"""User-managed, portable Framecraft projects, independent of browser caches."""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import threading
import time
from typing import Any, BinaryIO, Iterator
import unicodedata
import uuid
import warnings
import zipfile
import zlib

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

WORKSPACE = Path(__file__).resolve().parent.parent
DEFAULT_DIRECTORY = WORKSPACE / "FrameAnimProjectList"
FORMAT = "framecraft-project-v1"
MAX_ARCHIVE = 512 * 1024 * 1024
MAX_MEMBER = 64 * 1024 * 1024
MAX_MANIFEST = 4 * 1024 * 1024
MAX_ENTRIES = 2200
MAX_FRAMES = 400
MAX_DIMENSION = 8192
MAX_FRAME_PIXELS = 32_000_000
MAX_TOTAL_PIXELS = 512_000_000
PROJECT_ID = re.compile(r"[0-9a-f]{32}\Z")
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
TRUSTED_ORIGINS = {"http://127.0.0.1:8765", "http://localhost:8765", "http://127.0.0.1:5173", "http://localhost:5173"}
WINDOWS_RESERVED = re.compile(r"(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?\Z", re.IGNORECASE)


@dataclass
class ProjectAccess:
    readers: int = 0
    deleting: bool = False


_PROJECT_ACCESS: dict[Path, ProjectAccess] = {}
_PROJECT_ACCESS_LOCK = threading.Lock()


@contextmanager
def project_access(directory: Path, project_id: str, *, deleting: bool = False) -> Iterator[None]:
    """Keep an in-flight project read intact when another request deletes it."""
    key = directory / f"{project_id}.framecraft"
    with _PROJECT_ACCESS_LOCK:
        access = _PROJECT_ACCESS.setdefault(key, ProjectAccess())
        if access.deleting or (deleting and access.readers):
            raise HTTPException(409, "该工程正在读取或删除，请稍后重试。")
        if deleting:
            access.deleting = True
        else:
            access.readers += 1
    try:
        yield
    finally:
        with _PROJECT_ACCESS_LOCK:
            if deleting:
                access.deleting = False
            else:
                access.readers -= 1
            if not access.deleting and not access.readers:
                _PROJECT_ACCESS.pop(key, None)


def local_request(request: Request) -> None:
    """Do not let remote pages use this local API as a filesystem writer."""
    if request.url.hostname not in LOOPBACK:
        raise HTTPException(403, "工程文件接口仅允许本机访问。")
    origin = request.headers.get("origin")
    if origin and origin not in TRUSTED_ORIGINS:
        raise HTTPException(403, "请从本机工作台页面访问工程文件。")
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(403, "不允许跨站访问本机工程文件。")


router = APIRouter(prefix="/api/projects", tags=["Animation projects"], dependencies=[Depends(local_request)])


def directory_path(value: str | None) -> Path:
    if not value or not value.strip():
        return DEFAULT_DIRECTORY.resolve()
    if len(value) > 4096 or "\x00" in value:
        raise HTTPException(400, "工程目录路径无效。")
    try:
        path = Path(value.strip()).expanduser()
        if not path.is_absolute():
            path = WORKSPACE / path
        path = path.resolve()
        if path.exists() and not path.is_dir():
            raise HTTPException(400, "所选工程路径不是文件夹。")
        return path
    except (OSError, ValueError, RuntimeError) as error:
        raise HTTPException(400, f"无法读取工程目录：{error}") from error


def asset_name(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise HTTPException(400, "工程资源路径无效。")
    if "\\" in value or ":" in value or value.startswith("/"):
        raise HTTPException(400, "工程资源必须使用工程内的相对路径。")
    parts = value.split("/")
    if any(part in {"", ".", ".."} or part.endswith((".", " ")) or WINDOWS_RESERVED.fullmatch(part)
           or any(ord(char) < 32 or char in '<>"|?*' for char in part) for part in parts):
        raise HTTPException(400, "工程资源路径含有不安全的文件名。")
    if PurePosixPath(value).is_absolute():
        raise HTTPException(400, "工程资源必须使用工程内的相对路径。")
    return value


def number(value: Any, label: str, *, minimum: float = 0, maximum: float = float("inf"), integer: bool = False) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < minimum or value > maximum or (integer and int(value) != value):
        raise HTTPException(400, f"工程中的{label}无效。")


def text_value(value: Any, label: str, maximum: int, *, empty: bool = False) -> None:
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value.strip()):
        raise HTTPException(400, f"工程中的{label}无效。")


def references(manifest: Any) -> dict[str, tuple[int, int] | None]:
    """Validate known metadata while preserving workspace and future JSON fields."""
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT:
        raise HTTPException(400, "工程文件格式不匹配。")
    text_value(manifest.get("name"), "片段名", 200)
    number(manifest.get("fps"), "帧率", minimum=0.001, maximum=240)
    if not isinstance(manifest.get("workspace", {}), dict):
        raise HTTPException(400, "工程工作区参数无效。")
    assets: dict[str, tuple[int, int] | None] = {}

    def add_asset(value: Any, dimensions: tuple[int, int] | None) -> None:
        path = asset_name(value)
        if path.casefold() in {"project.json", ".incomplete", ".deleted"}:
            raise HTTPException(400, "工程清单或保存状态文件不能作为图片或素材。")
        if path in assets and assets[path] != dimensions:
            raise HTTPException(400, "同一工程资源的尺寸记录不一致。")
        assets[path] = dimensions

    def frame_group(frames: Any) -> None:
        if not isinstance(frames, list) or len(frames) > MAX_FRAMES:
            raise HTTPException(400, "工程中的每组动画最多可保存 400 帧。")
        ids: set[str] = set()
        for frame in frames:
            if not isinstance(frame, dict):
                raise HTTPException(400, "工程帧记录无效。")
            text_value(frame.get("id"), "帧编号", 200)
            text_value(frame.get("name"), "帧名称", 500)
            if frame["id"] in ids:
                raise HTTPException(400, "同组动画中的帧编号不能重复。")
            ids.add(frame["id"])
            number(frame.get("width"), "帧宽度", minimum=1, maximum=MAX_DIMENSION, integer=True)
            number(frame.get("height"), "帧高度", minimum=1, maximum=MAX_DIMENSION, integer=True)
            number(frame.get("sourceIndex"), "原始帧序号", integer=True)
            number(frame.get("time"), "帧时间")
            if "selected" in frame and not isinstance(frame["selected"], bool):
                raise HTTPException(400, "工程帧的勾选状态无效。")
            dimensions = (int(frame["width"]), int(frame["height"]))
            if dimensions[0] * dimensions[1] > MAX_FRAME_PIXELS:
                raise HTTPException(413, "单帧图片不能超过 3200 万像素。")
            add_asset(frame.get("file"), dimensions)

    frame_group(manifest.get("frames", []))
    if "sequenceInputs" in manifest:
        frame_group(manifest["sequenceInputs"])
    matting = manifest.get("matting")
    if matting is not None:
        if not isinstance(matting, dict) or not isinstance(matting.get("options"), dict):
            raise HTTPException(400, "工程抠图参数无效。")
        if matting.get("frames") is not None:
            frame_group(matting["frames"])
    source = manifest.get("source")
    if source is not None:
        if not isinstance(source, dict):
            raise HTTPException(400, "工程原素材记录无效。")
        text_value(source.get("name"), "素材名称", 500)
        text_value(source.get("type"), "素材类型", 128)
        if source.get("fps") is not None:
            number(source["fps"], "素材帧率", maximum=1000)
        dimensions = None
        if source["type"].startswith("image/") and source.get("width") is not None and source.get("height") is not None:
            number(source["width"], "素材宽度", minimum=1, maximum=MAX_DIMENSION, integer=True)
            number(source["height"], "素材高度", minimum=1, maximum=MAX_DIMENSION, integer=True)
            dimensions = (int(source["width"]), int(source["height"]))
        add_asset(source.get("file"), dimensions)
    loop = manifest.get("loopCorrection")
    if loop is not None:
        if not isinstance(loop, dict) or ("enabled" in loop and not isinstance(loop["enabled"], bool)):
            raise HTTPException(400, "工程循环修正参数无效。")
        if loop.get("frames") is not None:
            frame_group(loop["frames"])
    smoothing = manifest.get("smoothing")
    if smoothing is not None:
        if not isinstance(smoothing, dict) or ("enabled" in smoothing and not isinstance(smoothing["enabled"], bool)):
            raise HTTPException(400, "工程平滑参数无效。")
        if smoothing.get("frames") is not None:
            frame_group(smoothing["frames"])
    compression = manifest.get("compression")
    if compression is not None:
        if not isinstance(compression, dict):
            raise HTTPException(400, "工程压缩参数无效。")
        if compression.get("fps") is not None:
            number(compression["fps"], "压缩帧率", minimum=0.001, maximum=240)
        frame_group(compression.get("sources", []))
        frame_group(compression.get("results", []))
    if not assets:
        raise HTTPException(400, "工程中没有可保存的原素材或动画帧。")
    return assets


def parse_manifest(payload: bytes) -> dict[str, Any]:
    if len(payload) > MAX_MANIFEST:
        raise HTTPException(413, "工程参数文件不能超过 4 MB。")
    try:
        def invalid_constant(value: str) -> None:
            raise ValueError(f"invalid JSON number: {value}")
        value = json.loads(payload.decode("utf-8-sig"), parse_constant=invalid_constant)
        references(value)
        return value
    except HTTPException:
        raise
    except (ValueError, TypeError, RecursionError, UnicodeError) as error:
        raise HTTPException(400, "工程参数文件不是有效的 JSON。") from error


def check_image(stream: BinaryIO, expected: tuple[int, int] | None) -> int:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(stream) as image:
                width, height = image.size
                displayed_size = image.size
                # Browsers report JPEG dimensions after applying EXIF orientation.
                # Only JPEG needs this lookup; PNG getexif() can load the image and
                # prevent verify() from checking its original stream afterwards.
                if image.format == "JPEG" and image.getexif().get(274) in {5, 6, 7, 8}:
                    displayed_size = (height, width)
                if image.format not in {"PNG", "JPEG", "WEBP", "GIF", "BMP", "AVIF"} or (expected is not None and displayed_size != expected):
                    raise HTTPException(400, "工程图片格式或尺寸与记录不一致。")
                if width > MAX_DIMENSION or height > MAX_DIMENSION or width * height > MAX_FRAME_PIXELS:
                    raise HTTPException(413, "工程图片尺寸超限。")
                image.verify()
                return width * height
    except HTTPException:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise HTTPException(413, "工程图片像素过多。") from error
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as error:
        raise HTTPException(400, "工程中包含无法读取的图片。") from error


def summary(manifest: dict[str, Any]) -> dict[str, Any]:
    frames = manifest.get("frames", [])
    compression = manifest.get("compression") or {}
    effective = frames or (manifest.get("smoothing") or {}).get("frames") or compression.get("results", []) or compression.get("sources", []) or (manifest.get("loopCorrection") or {}).get("frames") or []
    result = {
        "id": manifest["id"], "name": manifest["name"], "fps": manifest["fps"],
        "frameCount": len(effective), "selectedFrameCount": sum(frame.get("selected", True) for frame in effective),
        "updatedAt": manifest["updatedAt"],
    }
    if effective:
        result["thumbnail"] = effective[0]["file"]
    elif (manifest.get("source") or {}).get("type", "").startswith("image/"):
        result["thumbnail"] = manifest["source"]["file"]
    return result


def member_limit(manifest: dict[str, Any], filename: str) -> int:
    return MAX_ARCHIVE if (manifest.get("source") or {}).get("file") == filename else MAX_MEMBER


def save_project(file: BinaryIO, directory: Path) -> dict[str, Any]:
    incomplete: Path | None = None
    try:
        file.seek(0, os.SEEK_END)
        if file.tell() > MAX_ARCHIVE:
            raise HTTPException(413, "工程压缩包不能超过 512 MB。")
        file.seek(0)
        with zipfile.ZipFile(file) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_ENTRIES:
                raise HTTPException(413, "工程压缩包中的文件过多。")
            names: set[str] = set()
            members: dict[str, zipfile.ZipInfo] = {}
            total_size = 0
            for entry in entries:
                path = asset_name(entry.orig_filename[:-1] if entry.is_dir() else entry.orig_filename)
                key = unicodedata.normalize("NFC", path).casefold()
                if key in names:
                    raise HTTPException(400, "工程压缩包中有重名文件。")
                names.add(key)
                mode = entry.external_attr >> 16
                if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) and not (stat.S_ISREG(mode) or stat.S_ISDIR(mode))) or entry.flag_bits & 1:
                    raise HTTPException(400, "工程压缩包不能包含链接、特殊文件或加密文件。")
                total_size += entry.file_size
                if total_size > MAX_ARCHIVE or entry.file_size > MAX_ARCHIVE:
                    raise HTTPException(413, "工程解压后的总大小不能超过 512 MB。")
                if entry.file_size > 1024 * 1024 and entry.file_size > max(entry.compress_size, 1) * 200:
                    raise HTTPException(413, "工程压缩包的压缩比例异常。")
                if not entry.is_dir():
                    members[path] = entry
            manifest_entry = members.get("project.json")
            if manifest_entry is None:
                raise HTTPException(400, "工程压缩包中缺少 project.json。")
            if manifest_entry.file_size > MAX_MANIFEST:
                raise HTTPException(413, "工程参数文件不能超过 4 MB。")
            manifest = parse_manifest(archive.read(manifest_entry))
            assets = references(manifest)
            if set(members) != {"project.json", *assets}:
                raise HTTPException(400, "工程压缩包中的资源与工程清单不一致。")
            pixels = 0
            source_image = manifest.get("source") or {}
            for path, expected in assets.items():
                entry = members[path]
                if entry.file_size <= 0 or entry.file_size > member_limit(manifest, path):
                    raise HTTPException(413, "工程资源为空或超过文件大小限制。")
                if expected or (path == source_image.get("file") and source_image.get("type", "").startswith("image/")):
                    with archive.open(entry) as stream:
                        pixels += check_image(stream, expected)
                    if pixels > MAX_TOTAL_PIXELS:
                        raise HTTPException(413, "工程图片总像素过多。")
            directory.mkdir(parents=True, exist_ok=True)
            project_id = uuid.uuid4().hex
            target = directory / f"{project_id}.framecraft"
            # Directory rename is denied by some Windows scanners even after all
            # handles are closed. Commit in a new, exclusive directory instead;
            # the marker keeps it out of scans until every byte is durable.
            try:
                target.mkdir()
            except FileExistsError as error:
                raise HTTPException(409, "工程编号冲突，请重新保存。") from error
            incomplete = target
            marker = target / ".incomplete"
            marker.write_bytes(b"")
            for path in assets:
                asset_target = target.joinpath(*PurePosixPath(path).parts)
                asset_target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(members[path]) as source, asset_target.open("xb") as destination:
                    copied = 0
                    while chunk := source.read(1024 * 1024):
                        copied += len(chunk)
                        if copied > member_limit(manifest, path) or copied > members[path].file_size:
                            raise HTTPException(413, "工程资源超过文件大小限制。")
                        destination.write(chunk)
                    if copied != members[path].file_size:
                        raise HTTPException(400, "工程资源数据不完整。")
            manifest["id"] = project_id
            manifest["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            manifest.setdefault("createdAt", manifest["updatedAt"])
            with (target / "project.json").open("x", encoding="utf-8") as destination:
                json.dump(manifest, destination, ensure_ascii=False, allow_nan=False)
                destination.flush()
                os.fsync(destination.fileno())
            # An antivirus may briefly hold the tiny marker; retry only this
            # operation, never replace an existing project directory.
            for delay in (0, 0.04, 0.12, 0.25):
                if delay:
                    time.sleep(delay)
                try:
                    marker.unlink()
                    break
                except PermissionError:
                    if delay == 0.25:
                        raise
            incomplete = None
            return {"id": project_id, "directory": str(directory), "path": str(target), "project": summary(manifest)}
    except HTTPException:
        raise
    except (zipfile.BadZipFile, zipfile.LargeZipFile, NotImplementedError, RuntimeError, ValueError, EOFError, zlib.error) as error:
        raise HTTPException(400, f"无法读取工程压缩包：{error}") from error
    except OSError as error:
        location = f" 已保留可恢复文件：{incomplete}。" if incomplete is not None else ""
        if isinstance(error, PermissionError):
            detail = f"Windows 拒绝写入工程目录，请检查该文件夹的写入权限或安全软件占用。{location} 原因：{error}"
        else:
            detail = f"工程文件写入失败。{location} 原因：{error}"
        raise HTTPException(500, detail) from error
    finally:
        if incomplete is not None:
            # Keep any recoverable assets from an interrupted write. Empty
            # directories created by this request alone are safe to discard.
            try:
                if not any(path.is_file() and path.name != ".incomplete" for path in incomplete.rglob("*")):
                    shutil.rmtree(incomplete, ignore_errors=True)
            except OSError:
                pass


def project_directory(directory: Path, project_id: str) -> Path:
    if not PROJECT_ID.fullmatch(project_id):
        raise HTTPException(400, "工程编号无效。")
    path = directory / f"{project_id}.framecraft"
    if path.is_symlink() or not path.is_dir() or path.resolve().parent != directory or (path / ".incomplete").exists() or (path / ".deleted").exists():
        raise HTTPException(404, "找不到该工程。")
    return path


def verified_asset(root: Path, path: str) -> Path:
    safe = asset_name(path)
    current = root
    for part in PurePosixPath(safe).parts:
        current = current / part
        if current.is_symlink():
            raise HTTPException(400, "工程资源不能使用文件链接。")
    try:
        if not current.is_file() or not current.resolve().is_relative_to(root.resolve()):
            raise HTTPException(400, "工程资源缺失或路径无效。")
    except (OSError, ValueError, RuntimeError) as error:
        raise HTTPException(400, "工程资源路径无效。") from error
    return current


def read_project_root(root: Path, project_id: str, verify_assets: bool = True) -> tuple[dict[str, Any], dict[str, tuple[int, int] | None], Path]:
    try:
        manifest_path = verified_asset(root, "project.json")
        if manifest_path.stat().st_size > MAX_MANIFEST:
            raise HTTPException(413, "工程参数文件不能超过 4 MB。")
        manifest = parse_manifest(manifest_path.read_bytes())
        if manifest.get("id") != project_id or not isinstance(manifest.get("updatedAt"), str):
            raise HTTPException(400, "工程编号或保存时间无效。")
        # Ensure malformed timestamps cannot disturb the list's ordering.
        datetime.fromisoformat(manifest["updatedAt"].replace("Z", "+00:00"))
        assets = references(manifest)
        if not verify_assets:
            return manifest, assets, root
        total_size = 0
        total_pixels = 0
        source_image = manifest.get("source") or {}
        for path, expected in assets.items():
            target = verified_asset(root, path)
            size = target.stat().st_size
            if size <= 0 or size > member_limit(manifest, path):
                raise HTTPException(413, "工程资源超过文件大小限制。")
            total_size += size
            if total_size > MAX_ARCHIVE:
                raise HTTPException(413, "工程资源总大小超过限制。")
            if expected or (path == source_image.get("file") and source_image.get("type", "").startswith("image/")):
                with target.open("rb") as stream:
                    total_pixels += check_image(stream, expected)
                if total_pixels > MAX_TOTAL_PIXELS:
                    raise HTTPException(413, "工程图片总像素过多。")
        return manifest, assets, root
    except HTTPException:
        raise
    except (OSError, ValueError, TypeError) as error:
        raise HTTPException(400, f"无法读取工程：{error}") from error


def read_project(directory: Path, project_id: str, verify_assets: bool = True) -> tuple[dict[str, Any], dict[str, tuple[int, int] | None], Path]:
    with project_access(directory, project_id):
        return read_project_root(project_directory(directory, project_id), project_id, verify_assets)


def trash_directory(directory: Path, *, create: bool = False) -> Path:
    trash = directory / ".trash"
    # Never follow a user-created .trash link to another location.
    if trash.is_symlink() or trash.resolve() != trash or (trash.exists() and not trash.is_dir()):
        raise HTTPException(400, "工程回收目录无效，请检查项目目录下的 .trash 文件夹。")
    if create:
        trash.mkdir(exist_ok=True)
        if trash.resolve() != trash:
            raise HTTPException(400, "工程回收目录不能使用文件链接。")
    return trash


def read_trashed_project(directory: Path, project_id: str) -> tuple[dict[str, Any], dict[str, tuple[int, int] | None], Path]:
    if not PROJECT_ID.fullmatch(project_id):
        raise HTTPException(400, "工程编号无效。")
    trash = trash_directory(directory)
    if not trash.is_dir():
        raise HTTPException(404, "找不到该工程。")
    pattern = re.compile(re.escape(project_id) + r"-[0-9a-f]{32}\.framecraft\Z")
    try:
        original = directory / f"{project_id}.framecraft"
        marker = original / ".deleted"
        recovery_name = None
        if original.exists():
            if original.is_symlink() or original.resolve() != original or not marker.is_file() or marker.is_symlink() or marker.stat().st_size > 128:
                raise HTTPException(404, "找不到该工程。")
            recovery_name = marker.read_text(encoding="ascii").strip()
            if not pattern.fullmatch(recovery_name):
                raise HTTPException(404, "找不到该工程的恢复资源。")
        candidates = [path for path in trash.iterdir()
                      if pattern.fullmatch(path.name) and not path.is_symlink()
                      and (recovery_name is None or path.name == recovery_name)
                      and path.is_dir() and path.resolve() == path and not (path / ".incomplete").exists()]
        candidates.sort(key=lambda path: path.stat().st_mtime_ns, reverse=True)
        for root in candidates:
            try:
                return read_project_root(root, project_id, verify_assets=False)
            except HTTPException:
                continue
    except (OSError, UnicodeError) as error:
        raise HTTPException(400, f"无法读取已删除工程的资源：{error}") from error
    raise HTTPException(404, "找不到该工程。")


def _read_asset(directory: Path, project_id: str, asset: str) -> tuple[Path, str]:
    # Each of N image requests verifies only its own image, avoiding N² PNG reads.
    try:
        manifest, assets, root = read_project(directory, project_id, verify_assets=False)
    except HTTPException as error:
        original = directory / f"{project_id}.framecraft"
        deleted = (original / ".deleted").is_file() and not original.is_symlink() and original.resolve() == original
        if error.status_code != 404 or original.is_symlink() or (original.exists() and not deleted):
            raise
        # Open workspaces keep HTTP asset URLs. A deleted project can continue
        # exporting those already-open frames without reappearing in the list.
        manifest, assets, root = read_trashed_project(directory, project_id)
    if asset_name(asset) not in assets:
        raise HTTPException(404, "工程中没有该资源。")
    try:
        path = verified_asset(root, asset)
        size = path.stat().st_size
        if size <= 0 or size > member_limit(manifest, asset):
            raise HTTPException(413, "工程资源超过文件大小限制。")
        expected = assets[asset]
        source = manifest.get("source") or {}
        is_source = asset == source.get("file")
        media_type = "application/octet-stream"
        if expected or (is_source and source.get("type", "").startswith("image/")):
            with path.open("rb") as stream:
                check_image(stream, expected)
            with Image.open(path) as image:
                media_type = Image.MIME.get(image.format, "application/octet-stream")
        elif is_source and re.fullmatch(r"video/[a-zA-Z0-9.+-]+", source.get("type", "")):
            media_type = source["type"]
        return path, media_type
    except HTTPException:
        raise
    except (OSError, ValueError) as error:
        raise HTTPException(400, f"无法读取工程资源：{error}") from error


def read_asset(directory: Path, project_id: str, asset: str) -> tuple[Path, str]:
    with project_access(directory, project_id):
        return _read_asset(directory, project_id, asset)


def delete_project(directory: Path, project_id: str) -> dict[str, Any]:
    with project_access(directory, project_id, deleting=True):
        if not PROJECT_ID.fullmatch(project_id):
            raise HTTPException(400, "工程编号无效。")
        root = directory / f"{project_id}.framecraft"
        try:
            if root.is_symlink() or root.resolve() != root or not root.is_dir():
                raise HTTPException(404, "找不到该工程。")
            if (root / ".deleted").exists():
                raise HTTPException(404, "找不到该工程，请刷新项目列表。")
            if (root / ".incomplete").exists():
                raise HTTPException(409, "该工程尚未保存完成，请稍后重试。")
            # Validate the project identity before moving the whole portable
            # directory. No other project or adjacent file is modified.
            read_project_root(root, project_id, verify_assets=False)
            trash = trash_directory(directory, create=True)
            target = trash / f"{project_id}-{uuid.uuid4().hex}.framecraft"
            target.mkdir()
            incomplete = target / ".incomplete"
            incomplete.write_bytes(b"")

            def reject_links(folder: str, names: list[str]) -> set[str]:
                for name in names:
                    path = Path(folder) / name
                    if path.is_symlink() or path.resolve() != path:
                        raise HTTPException(400, "工程目录包含文件链接，无法安全删除。")
                return set()

            # Some Windows security tools deny renaming a directory even when
            # it is writable. Copy into recovery storage before committing a
            # small marker; keep the original directory as a second backup.
            shutil.copytree(root, target, dirs_exist_ok=True, symlinks=True, ignore=reject_links)
            read_project_root(target, project_id)
            for delay in (0, 0.04, 0.12, 0.25):
                if delay:
                    time.sleep(delay)
                try:
                    incomplete.unlink()
                    break
                except PermissionError:
                    if delay == 0.25:
                        raise
            writing = root / f".deleted-writing-{uuid.uuid4().hex}"
            try:
                with writing.open("x", encoding="ascii") as destination:
                    destination.write(target.name + "\n")
                    destination.flush()
                    os.fsync(destination.fileno())
                # Only a completed file commit hides the original project.
                # This never renames or deletes a user project directory.
                os.replace(writing, root / ".deleted")
            except OSError:
                # A failed marker commit leaves the source visible. Exclude
                # its unused recovery copy from any later resource fallback.
                try:
                    incomplete.write_bytes(b"")
                except OSError:
                    pass
                raise
            finally:
                writing.unlink(missing_ok=True)
            return {"id": project_id, "directory": str(directory), "deleted": True}
        except HTTPException:
            raise
        except FileNotFoundError as error:
            raise HTTPException(404, "找不到该工程，请刷新项目列表。") from error
        except PermissionError as error:
            raise HTTPException(409, "Windows 暂时无法删除该工程，请检查文件夹写入权限或安全软件占用后重试。") from error
        except OSError as error:
            raise HTTPException(500, f"无法删除工程：{error}") from error


def list_projects(directory: Path) -> dict[str, Any]:
    projects = []
    if directory.is_dir():
        try:
            for child in directory.iterdir():
                if not child.name.endswith(".framecraft") or child.is_symlink() or not child.is_dir():
                    continue
                project_id = child.name[:-len(".framecraft")]
                if not PROJECT_ID.fullmatch(project_id):
                    continue
                try:
                    manifest, _, _ = read_project(directory, project_id)
                    projects.append(summary(manifest))
                except (HTTPException, OSError, ValueError):
                    # An unrelated or incomplete directory must not hide good projects.
                    continue
        except OSError as error:
            raise HTTPException(400, f"无法扫描工程目录：{error}") from error
    projects.sort(key=lambda project: project["updatedAt"], reverse=True)
    return {"directory": str(directory), "exists": directory.is_dir(), "projects": projects}


class BrowseRequest(BaseModel):
    directory: str | None = None


class ProjectFileResponse(FileResponse):
    def __init__(self, path: Path, media_type: str, directory: Path, project_id: str, asset: str):
        super().__init__(path, media_type=media_type, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
        self.project_directory = directory
        self.project_id = project_id
        self.asset = asset

    async def __call__(self, scope, receive, send) -> None:
        with project_access(self.project_directory, self.project_id):
            # A delete may finish between endpoint validation and response
            # dispatch. Resolve the same resource in the recovery directory.
            if not Path(self.path).is_file() or (self.project_directory / f"{self.project_id}.framecraft" / ".deleted").exists():
                self.path, _ = await run_in_threadpool(read_asset, self.project_directory, self.project_id, self.asset)
            await super().__call__(scope, receive, send)


def browse_directory(directory: Path) -> str | None:
    try:
        process = subprocess.run(
            [sys.executable, "-m", "backend.project_picker", str(directory)],
            cwd=str(WORKSPACE), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8", timeout=600,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        if process.returncode:
            raise RuntimeError(process.stderr.strip()[-400:])
        selected = json.loads(process.stdout)["directory"]
        if selected is None:
            return None
        return str(directory_path(selected))
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.TimeoutExpired) as error:
        raise HTTPException(503, f"无法打开文件夹选择窗口，请手动输入工程目录路径。{str(error)[:400]}") from error


@router.get("")
async def get_projects(directory: str | None = None) -> dict[str, Any]:
    return await run_in_threadpool(list_projects, directory_path(directory))


@router.post("/browse")
async def choose_directory(options: BrowseRequest) -> dict[str, Any]:
    return {"directory": await run_in_threadpool(browse_directory, directory_path(options.directory))}


@router.post("")
async def post_project(archive: UploadFile = File(...), directory: str | None = None) -> dict[str, Any]:
    try:
        return await run_in_threadpool(save_project, archive.file, directory_path(directory))
    finally:
        await archive.close()


@router.get("/{project_id}")
async def get_project(project_id: str, directory: str | None = None) -> dict[str, Any]:
    manifest, _, _ = await run_in_threadpool(read_project, directory_path(directory), project_id)
    return manifest


@router.delete("/{project_id}")
async def remove_project(project_id: str, directory: str | None = None) -> dict[str, Any]:
    return await run_in_threadpool(delete_project, directory_path(directory), project_id)


@router.get("/{project_id}/files/{asset:path}")
async def get_asset(project_id: str, asset: str, directory: str | None = None) -> FileResponse:
    root = directory_path(directory)
    path, media_type = await run_in_threadpool(read_asset, root, project_id, asset)
    return ProjectFileResponse(path, media_type, root, project_id, asset)
