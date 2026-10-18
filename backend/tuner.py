"""Local integration with pinned XSXB Lite and audited compatibility patches."""
from __future__ import annotations

import atexit
from datetime import datetime, timedelta, timezone
from io import BytesIO
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import socket
import stat
import subprocess
import tempfile
import threading
import time
from typing import Any
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import ProxyHandler, build_opener
import uuid
import warnings
import zipfile

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool
from .patches.apply_xsxb_compat import apply_compat_patch

BACKEND = Path(__file__).resolve().parent
VENDOR = BACKEND / "vendor" / "XSXB-Frame-Tuner"
DATA_DIR = BACKEND / "tuner-data"
TEMP_DIR = DATA_DIR / "tmp"
IMPORT_DIR = DATA_DIR / "imports"
SOURCE_REVISION = "cb061e15132b9250feebd34a18a3fd023197837c"
SOURCE_URL = "https://github.com/sparklecatta-lang/XSXB-Frame-Tuner"
MAX_ARCHIVE = 256 * 1024 * 1024
MAX_UNPACKED = 512 * 1024 * 1024
MAX_MEMBER = 64 * 1024 * 1024
MAX_FRAMES = 400
MAX_PIXELS = 120_000_000
MAX_FRAME_PIXELS = 16_000_000

# Starlette's multipart spool files must stay with the rest of this E: workspace.
TEMP_DIR.mkdir(parents=True, exist_ok=True)
tempfile.tempdir = str(TEMP_DIR)
router = APIRouter(prefix="/api/tuner", tags=["XSXB Frame Tuner"])


def node_binary() -> str:
    configured = os.environ.get("FRAMECRAFT_NODE") or os.environ.get("NODE_EXE")
    if configured:
        candidate = Path(configured).expanduser()
        if candidate.is_file():
            return str(candidate.resolve())
        raise RuntimeError("配置的 Node.js 路径不存在，请检查 FRAMECRAFT_NODE / NODE_EXE。")
    found = shutil.which("node") or shutil.which("node.exe")
    if not found:
        raise RuntimeError("找不到 Node.js，请先运行 setup.ps1，或安装 Node.js 18 及以上版本。")
    return found


def child_environment(port: int) -> dict[str, str]:
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    cache = DATA_DIR / "node-cache"
    cache.mkdir(parents=True, exist_ok=True)
    return {
        **os.environ, "LITE_PORT": str(port), "TEMP": str(TEMP_DIR),
        "TMP": str(TEMP_DIR), "TMPDIR": str(TEMP_DIR), "NODE_COMPILE_CACHE": str(cache),
    }


class TunerManager:
    def __init__(self, root: Path = VENDOR, port: int = 5188) -> None:
        self.root = root.resolve()
        self.port = port
        self.url = f"http://127.0.0.1:{port}"
        self.process: subprocess.Popen | None = None
        self.error: str | None = None
        self._startup_lock = threading.Lock()
        self._opener = build_opener(ProxyHandler({}))

    @property
    def installed(self) -> bool:
        return (self.root / "tools/frame_tuner_lite/server.js").is_file() and (self.root / "tools/frame_tuner_lite/import_frames.js").is_file()

    def _json(self, path: str) -> dict[str, Any]:
        with self._opener.open(f"{self.url}{path}", timeout=0.6) as response:
            payload = response.read(2 * 1024 * 1024 + 1)
        if len(payload) > 2 * 1024 * 1024:
            raise ValueError("Tuner 服务响应过大。")
        value = json.loads(payload)
        if not isinstance(value, dict):
            raise ValueError("Tuner 服务响应格式不匹配。")
        return value

    def probe(self) -> tuple[bool, bool]:
        """A matching HTTP response must prove both Lite kind and exact vendor root."""
        try:
            config = self._json("/api/config")
            projects = self._json("/api/projects")
            if config.get("projectKind") == "frame_lite" and Path(str(config.get("root", ""))).resolve() == self.root and isinstance(projects.get("projects"), list):
                return True, True
        except (OSError, URLError, ValueError, TypeError):
            pass
        try:
            with socket.create_connection(("127.0.0.1", self.port), timeout=0.15):
                return False, True
        except OSError:
            return False, False

    def status(self) -> dict[str, Any]:
        running, occupied = self.probe()
        error = self.error
        if occupied and not running:
            error = f"端口 {self.port} 被其他服务占用。请关闭该服务后重试；工作台不会终止其他程序。"
        elif self.process is not None and self.process.poll() is not None and not running:
            error = f"Tuner 服务已退出（代码 {self.process.returncode}），请查看 {DATA_DIR / 'server.log'}。"
        version = None
        try:
            version = json.loads((self.root / "package.json").read_text(encoding="utf-8"))["version"]
        except (OSError, ValueError, KeyError):
            pass
        return {
            "installed": self.installed, "running": running, "url": self.url,
            "version": version, "source_revision": SOURCE_REVISION,
            "source_url": SOURCE_URL, "error": error,
        }

    def start(self) -> dict[str, Any]:
        with self._startup_lock:
            if self.installed:
                try:
                    apply_compat_patch(self.root)
                except (OSError, RuntimeError) as error:
                    self.error = str(error)
                    raise HTTPException(status_code=503, detail=self.error) from error
            running, occupied = self.probe()
            if running:
                self.error = None
                return self.status()
            if occupied:
                raise HTTPException(status_code=409, detail=f"端口 {self.port} 被其他服务占用，无法启动 XSXB Frame Tuner。")
            if not self.installed:
                raise HTTPException(status_code=503, detail="XSXB Frame Tuner 尚未安装，请先运行 setup.ps1。")
            try:
                node = node_binary()
                DATA_DIR.mkdir(parents=True, exist_ok=True)
                with (DATA_DIR / "server.log").open("ab") as log:
                    self.process = subprocess.Popen(
                        [node, str(self.root / "tools/frame_tuner_lite/server.js")],
                        cwd=str(self.root), env=child_environment(self.port),
                        stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                    )
                deadline = time.monotonic() + 12
                while time.monotonic() < deadline:
                    if self.process.poll() is not None:
                        raise RuntimeError(f"Node.js 服务退出，代码 {self.process.returncode}；请查看 backend/tuner-data/server.log。")
                    if self.probe()[0]:
                        self.error = None
                        return self.status()
                    time.sleep(0.1)
                raise RuntimeError("XSXB Frame Tuner 启动超时，请查看 backend/tuner-data/server.log。")
            except HTTPException:
                raise
            except Exception as error:
                self.error = str(error)
                self.shutdown()
                raise HTTPException(status_code=503, detail=self.error) from error

    def shutdown(self) -> None:
        """Stop only the child process this manager actually created."""
        process = self.process
        if process is None:
            return
        self.process = None
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)


manager = TunerManager()
atexit.register(manager.shutdown)
IMPORT_LOCK = threading.Lock()


def natural_key(value: str) -> list[Any]:
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", value)]


def safe_zip_member(info: zipfile.ZipInfo) -> None:
    value = info.filename.replace("\\", "/")
    parts = PurePosixPath(value).parts
    if not parts or value.startswith("/") or any(part in {"..", "."} or ":" in part or "\x00" in part for part in parts):
        raise HTTPException(status_code=400, detail="ZIP 中包含不安全的文件路径。")
    if stat.S_ISLNK(info.external_attr >> 16):
        raise HTTPException(status_code=400, detail="ZIP 中不能包含符号链接。")
    if info.flag_bits & 1:
        raise HTTPException(status_code=400, detail="不支持加密 ZIP，请先解压后重新打包。")


def unpack_frames(archive: Path, destination: Path) -> int:
    try:
        with zipfile.ZipFile(archive) as zipped:
            entries = zipped.infolist()
            if len(entries) > MAX_FRAMES + 32:
                raise HTTPException(status_code=413, detail="ZIP 条目过多，最多导入 400 帧。")
            seen: set[str] = set()
            for info in entries:
                safe_zip_member(info)
                normalized = info.filename.replace("\\", "/").casefold()
                if normalized in seen:
                    raise HTTPException(status_code=400, detail="ZIP 中存在重名文件，请重新导出。")
                seen.add(normalized)
            files = [info for info in entries if not info.is_dir()]
            expanded = sum(info.file_size for info in files)
            compressed = sum(info.compress_size for info in files)
            if expanded > MAX_UNPACKED or any(info.file_size > MAX_MEMBER for info in files) or expanded > max(compressed, 1) * 200:
                raise HTTPException(status_code=413, detail="ZIP 解压尺寸或压缩比过大，请分批导入。")
            frames = sorted((info for info in files if info.filename.lower().endswith(".png")), key=lambda info: natural_key(info.filename))
            if not frames:
                raise HTTPException(status_code=400, detail="ZIP 中没有 PNG 序列帧。")
            if len(frames) > MAX_FRAMES:
                raise HTTPException(status_code=413, detail="每次最多导入 400 帧，请分批导入。")
            source_metadata: dict[str, dict[str, Any]] | None = None
            manifest_info = next((info for info in files if info.filename.casefold() == "manifest.json"), None)
            if manifest_info is not None:
                if manifest_info.file_size > 1024 * 1024:
                    raise HTTPException(status_code=413, detail="帧元数据过大，请重新导出。")
                metadata = json.loads(zipped.read(manifest_info).decode("utf-8"))
                if not isinstance(metadata, dict) or metadata.get("format") != "framecraft-tuner-v1" or not isinstance(metadata.get("frames"), list):
                    raise HTTPException(status_code=400, detail="帧元数据格式无效，请重新导出。")
                source_metadata = {}
                for record in metadata["frames"]:
                    if not isinstance(record, dict) or not isinstance(record.get("filename"), str) or not isinstance(record.get("sourceName"), str):
                        raise HTTPException(status_code=400, detail="帧元数据名称无效。")
                    key = record["filename"].replace("\\", "/").casefold()
                    if key in source_metadata or len(record["sourceName"]) > 255 or any(ord(char) < 32 for char in record["sourceName"]):
                        raise HTTPException(status_code=400, detail="帧元数据包含重复条目或无效名称。")
                    clean: dict[str, Any] = {"sourceName": record["sourceName"]}
                    for field in ("sourceFrame", "sourceTimeSeconds"):
                        value = record.get(field)
                        if isinstance(value, (int, float)) and abs(value) <= 1e12 and math.isfinite(value):
                            clean[field] = value
                    source_metadata[key] = clean
                if set(source_metadata) != {info.filename.replace("\\", "/").casefold() for info in frames}:
                    raise HTTPException(status_code=400, detail="帧元数据与 PNG 列表不一致。")
            destination.mkdir(parents=True, exist_ok=False)
            total_pixels = 0
            for index, info in enumerate(frames, 1):
                data = zipped.read(info)
                with warnings.catch_warnings():
                    warnings.simplefilter("error", Image.DecompressionBombWarning)
                    with Image.open(BytesIO(data)) as image:
                        if image.format != "PNG":
                            raise HTTPException(status_code=415, detail="序列中存在伪装成 PNG 的文件。")
                        pixels = image.width * image.height
                        total_pixels += pixels
                        if image.width > 8192 or image.height > 8192 or pixels > MAX_FRAME_PIXELS or total_pixels > MAX_PIXELS:
                            raise HTTPException(status_code=413, detail="帧像素总量超限：最多 1.2 亿像素，单帧最多 1600 万像素。")
                        image.load()
                        image.convert("RGBA").save(destination / f"frame_{index:04d}.png", "PNG")
            if source_metadata is not None:
                ordered = [source_metadata[info.filename.replace("\\", "/").casefold()] for info in frames]
                (destination.parent / "source-frames.json").write_text(json.dumps(ordered, ensure_ascii=False), encoding="utf-8")
            return len(frames)
    except HTTPException:
        raise
    except (zipfile.BadZipFile, zipfile.LargeZipFile, OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise HTTPException(status_code=400, detail="ZIP 或 PNG 文件损坏，请重新导出后重试。") from error


def preserve_source_names(batch_dir: Path, project: str, animation_id: str) -> None:
    mapping = batch_dir / "source-frames.json"
    if not mapping.is_file():
        return
    manifest_path = manager.root / "data/lite/projects" / project / "animation_manifest.json"
    try:
        source_frames = json.loads(mapping.read_text(encoding="utf-8"))
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        profile = next(item for item in manifest["profiles"] if item["id"] == "character")
        animation = next(item for item in profile["animations"] if item["id"] == animation_id)
        if len(animation["frames"]) != len(source_frames):
            raise ValueError("source frame count mismatch")
        for frame, source in zip(animation["frames"], source_frames, strict=True):
            frame["name"] = source["sourceName"]
            frame["framecraftSource"] = source
        temporary = manifest_path.with_suffix(".framecraft.tmp")
        temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, manifest_path)
    except (OSError, ValueError, KeyError, TypeError, StopIteration) as error:
        raise HTTPException(status_code=503, detail="已导入 PNG，但原始帧名称同步失败，请检查该批次的数据文件。") from error


def import_frames(archive_path: Path, batch_dir: Path, name: str, fps: float, anchor: str = "bottom") -> dict[str, Any]:
    with IMPORT_LOCK:
        count = unpack_frames(archive_path, batch_dir / "frames")
        try:
            node = node_binary()
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        project = batch_dir.name
        stem = re.sub(r"[^\w-]+", "_", name, flags=re.UNICODE).strip("_")[:48] or "animation"
        animation = f"{stem}_{uuid.uuid4().hex[:8]}"
        label = f"{name} · {datetime.now(timezone(timedelta(hours=8))).strftime('%m-%d %H:%M')}"
        args = [
            node, str(manager.root / "tools/frame_tuner_lite/import_frames.js"),
            "--project", project, "--profile", "character", "--animation", animation,
            "--source", str(batch_dir / "frames"), "--fps", str(fps),
            "--anchor-mode", "canvas_center" if anchor == "center" else "canvas_bottom_center",
            "--label", label, "--profile-label", "角色",
        ]
        try:
            result = subprocess.run(
                args, cwd=str(manager.root), env=child_environment(manager.port),
                stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=60, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise HTTPException(status_code=503, detail=f"XSXB 官方导入工具无法运行：{error}") from error
        if result.returncode:
            raise HTTPException(status_code=503, detail=f"XSXB 官方导入工具失败：{result.stderr[-1200:] or result.stdout[-1200:]}")
        try:
            imported = json.loads(result.stdout)
            if imported.get("frames") != count or imported.get("project") != project:
                raise ValueError("import count / project mismatch")
        except (ValueError, AttributeError) as error:
            raise HTTPException(status_code=503, detail="XSXB 导入结果校验失败，请查看导入目录后重试。") from error
        preserve_source_names(batch_dir, project, animation)
        manager.start()
        query = urlencode({"project": project, "profile": "character", "group": animation, "frame": 1})
        url = f"{manager.url}/?{query}"
        metadata = {"project": project, "profile": "character", "animation": animation, "name": name, "fps": fps, "frameCount": count, "url": url, "editorUrl": url, "source_revision": SOURCE_REVISION}
        (batch_dir / "transfer.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
        return metadata


@router.get("/status")
async def tuner_status() -> dict[str, Any]:
    return await run_in_threadpool(manager.status)


@router.post("/start")
async def tuner_start() -> dict[str, Any]:
    return await run_in_threadpool(manager.start)


@router.post("/import")
async def tuner_import(
    archive: UploadFile = File(...), name: str = Form("新动画", min_length=1, max_length=80), fps: float = Form(12, ge=0.1, le=240), anchor: str = Form("bottom"),
) -> dict[str, Any]:
    if not manager.installed:
        await archive.close()
        raise HTTPException(status_code=503, detail="XSXB Frame Tuner 尚未安装，请先运行 setup.ps1。")
    name = name.strip()
    if not name or any(ord(char) < 32 for char in name):
        await archive.close()
        raise HTTPException(status_code=422, detail="动画名称不能为空或包含控制字符。")
    if anchor not in {"center", "bottom"}:
        await archive.close()
        raise HTTPException(status_code=422, detail="动画画布锚点无效。")
    batch = IMPORT_DIR / f"framecraft_{uuid.uuid4().hex[:12]}"
    batch.mkdir(parents=True, exist_ok=False)
    archive_path = batch / "frames.zip"
    try:
        size = 0
        with archive_path.open("wb") as output:
            while chunk := await archive.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_ARCHIVE:
                    raise HTTPException(status_code=413, detail="ZIP 文件不能超过 256 MB，请分批导入。")
                output.write(chunk)
        if not size:
            raise HTTPException(status_code=400, detail="上传的 ZIP 文件为空。")
        return await run_in_threadpool(import_frames, archive_path, batch, name, fps, anchor)
    except Exception:
        # Remove only this newly allocated import directory, never upstream tuning.
        if batch.resolve().parent != IMPORT_DIR.resolve():
            raise RuntimeError("Refusing to remove an import outside the configured directory")
        shutil.rmtree(batch)
        raise
    finally:
        await archive.close()
