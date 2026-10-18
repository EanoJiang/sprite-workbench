"""Lossless transparent QuickTime export from an explicitly ordered PNG ZIP."""
from __future__ import annotations

from fractions import Fraction
from io import BytesIO
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import threading
from typing import Any, BinaryIO
from urllib.parse import quote
import warnings
import zipfile
import zlib

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from PIL import Image, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

from .projects import asset_name, local_request

TEMP_ROOT = Path(__file__).resolve().parent / ".tmp" / "exports"
MAX_ARCHIVE = 256 * 1024 * 1024
MAX_UNPACKED = 512 * 1024 * 1024
MAX_MEMBER = 64 * 1024 * 1024
MAX_MANIFEST = 2 * 1024 * 1024
MAX_OUTPUT = 512 * 1024 * 1024
MAX_FRAMES = 400
MAX_DIMENSION = 8192
MAX_FRAME_PIXELS = 32_000_000
MAX_SEQUENCE_PIXELS = 120_000_000
EXPORT_LOCK = threading.Lock()
router = APIRouter(prefix="/api/exports", tags=["Animation exports"], dependencies=[Depends(local_request)])


def resolve_tool(name: str) -> str:
    configured = os.environ.get(f"FRAMECRAFT_{name.upper()}")
    if configured:
        candidate = Path(configured).expanduser()
        if candidate.is_file():
            return str(candidate.resolve())
        raise HTTPException(503, f"配置的 {name} 路径不存在，请检查 FRAMECRAFT_{name.upper()}。")
    found = shutil.which(name)
    if not found:
        raise HTTPException(503, f"找不到本机 {name}，请安装 FFmpeg 并将其加入 PATH 后重启工作台。")
    return found


def export_name(value: str) -> str:
    name = re.sub(r"\.[a-z0-9]{1,8}$", "", value, flags=re.IGNORECASE)
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(". ")[:120]
    return name or "animation"


def read_manifest(payload: bytes) -> tuple[dict[str, Any], Fraction, int, int]:
    if len(payload) > MAX_MANIFEST:
        raise HTTPException(413, "MOV 导出清单不能超过 2 MB。")
    try:
        def invalid_constant(value: str) -> None:
            raise ValueError(f"invalid number {value}")
        manifest = json.loads(payload.decode("utf-8-sig"), parse_constant=invalid_constant)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise HTTPException(400, "MOV 导出清单不是有效的 JSON。") from error
    if not isinstance(manifest, dict) or manifest.get("format") != "framecraft-mov-v1":
        raise HTTPException(400, "MOV 导出清单格式不匹配。")
    name = manifest.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 200:
        raise HTTPException(400, "MOV 动画片段名无效。")
    fps = manifest.get("fps")
    if isinstance(fps, bool) or not isinstance(fps, (int, float)) or not 1 <= fps <= 120 or not math.isfinite(fps):
        raise HTTPException(400, "MOV 播放帧率需要在 1–120 FPS 之间。")
    rate = Fraction(str(fps)).limit_denominator(1_000_000)
    frames = manifest.get("frames")
    if not isinstance(frames, list) or not 1 <= len(frames) <= MAX_FRAMES:
        raise HTTPException(400, "MOV 导出需要 1–400 帧图片。")
    for index, frame in enumerate(frames, 1):
        if not isinstance(frame, dict) or frame.get("filename") != f"frame_{index:03d}.png":
            raise HTTPException(400, "MOV 帧必须按顺序连续命名为 frame_001.png、frame_002.png…。")
        for dimension in ("width", "height"):
            value = frame.get(dimension)
            if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_DIMENSION:
                raise HTTPException(400, "MOV 帧尺寸无效，单边最多为 8192 像素。")
        anchor = frame.get("anchor", "bottom")
        if not isinstance(anchor, str) or anchor not in {"bottom", "center"}:
            raise HTTPException(400, "MOV 帧锚点必须为 center 或 bottom。")
        if frame["width"] * frame["height"] > MAX_FRAME_PIXELS:
            raise HTTPException(413, "MOV 单帧图片不能超过 3200 万像素。")
    width = max(frame["width"] for frame in frames)
    height = max(frame["height"] for frame in frames)
    if width * height > MAX_FRAME_PIXELS or width * height * len(frames) > MAX_SEQUENCE_PIXELS:
        raise HTTPException(413, "MOV 导出画布或总像素过大，请减少帧数或降低尺寸。")
    return manifest, rate, width, height


def validated_members(archive: zipfile.ZipFile) -> tuple[dict[str, zipfile.ZipInfo], dict[str, Any], Fraction, int, int]:
    entries = archive.infolist()
    if len(entries) > MAX_FRAMES + 1:
        raise HTTPException(413, "MOV 导出压缩包中的文件过多。")
    members: dict[str, zipfile.ZipInfo] = {}
    seen: set[str] = set()
    total = 0
    for entry in entries:
        path = asset_name(entry.orig_filename)
        if entry.is_dir() or "/" in path:
            raise HTTPException(400, "MOV 导出压缩包只能包含根目录的 PNG 帧与 manifest.json。")
        if path.casefold() in seen:
            raise HTTPException(400, "MOV 导出压缩包中有重名文件。")
        seen.add(path.casefold())
        mode = entry.external_attr >> 16
        if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) and not stat.S_ISREG(mode)) or entry.flag_bits & 1:
            raise HTTPException(400, "MOV 导出压缩包不能包含链接、特殊文件或加密文件。")
        total += entry.file_size
        limit = MAX_MANIFEST if path == "manifest.json" else MAX_MEMBER
        if entry.file_size <= 0 or entry.file_size > limit or total > MAX_UNPACKED:
            raise HTTPException(413, "MOV 导出压缩包或图片超过文件大小限制。")
        if entry.file_size > 1024 * 1024 and entry.file_size > max(entry.compress_size, 1) * 200:
            raise HTTPException(413, "MOV 导出压缩包的压缩比例异常。")
        members[path] = entry
    if "manifest.json" not in members:
        raise HTTPException(400, "MOV 导出压缩包缺少 manifest.json。")
    manifest, rate, width, height = read_manifest(archive.read(members["manifest.json"]))
    expected = {"manifest.json", *(frame["filename"] for frame in manifest["frames"])}
    if set(members) != expected:
        raise HTTPException(400, "MOV 导出图片与清单不一致。")
    return members, manifest, rate, width, height


def decode_png(payload: bytes, width: int, height: int) -> Image.Image:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(payload)) as image:
                if image.format != "PNG" or image.size != (width, height):
                    raise HTTPException(400, "MOV 帧必须为尺寸与清单一致的有效 PNG。")
                image.verify()
            with Image.open(BytesIO(payload)) as image:
                return image.convert("RGBA")
    except HTTPException:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise HTTPException(413, "MOV 图片像素过多，请先缩小图片。") from error
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as error:
        raise HTTPException(400, "MOV 导出压缩包中有无法读取的 PNG。") from error


def write_aligned_frames(archive: zipfile.ZipFile, members: dict[str, zipfile.ZipInfo], manifest: dict[str, Any], destination: Path, width: int, height: int) -> None:
    for index, frame in enumerate(manifest["frames"], 1):
        source = decode_png(archive.read(members[frame["filename"]]), frame["width"], frame["height"])
        try:
            canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
            try:
                x = (width - source.width) // 2
                y = (height - source.height) // 2 if frame.get("anchor") == "center" else height - source.height
                # No mask: using the source alpha as a paste mask would apply it
                # twice and change every semitransparent pixel.
                canvas.paste(source, (x, y))
                canvas.save(destination / f"frame_{index:03d}.png", "PNG")
            finally:
                canvas.close()
        finally:
            source.close()


def run_encoder(ffmpeg: str, ffprobe: str, frames_directory: Path, output: Path, fps: Fraction, frame_count: int, width: int, height: int) -> None:
    command = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-framerate", str(fps),
               "-start_number", "1", "-i", str(frames_directory / "frame_%03d.png"), "-frames:v", str(frame_count),
               "-c:v", "qtrle", "-pix_fmt", "argb", "-fps_mode", "passthrough", "-video_track_timescale", str(fps.numerator),
               "-threads", "2", "-an", "-map_metadata", "-1", "-fs", str(MAX_OUTPUT), str(output)]
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180, creationflags=creationflags)
        if result.returncode or not output.is_file():
            detail = result.stderr.decode("utf-8", errors="replace")[-900:]
            raise HTTPException(503, f"FFmpeg 透明 MOV 导出失败：{detail}")
        if output.stat().st_size > MAX_OUTPUT:
            raise HTTPException(413, "MOV 文件超过 512 MB，请减少帧数或降低尺寸。")
        probe = subprocess.run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
                                "stream=codec_name,pix_fmt,width,height,nb_frames,avg_frame_rate", "-of", "json", str(output)],
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, creationflags=creationflags)
        if probe.returncode:
            raise HTTPException(503, "FFprobe 无法验证导出的透明 MOV，已停止下载。")
        streams = json.loads(probe.stdout).get("streams", [])
        stream = streams[0] if len(streams) == 1 else {}
        if int(stream.get("nb_frames", 0)) != frame_count:
            raise HTTPException(413, "MOV 导出超过容量或帧数不完整，请减少帧数或降低尺寸。")
        if stream.get("codec_name") != "qtrle" or stream.get("pix_fmt") != "argb" or (stream.get("width"), stream.get("height")) != (width, height) or Fraction(stream.get("avg_frame_rate", "0")) != fps:
            raise HTTPException(503, "MOV 的透明通道、尺寸或帧率验证失败，已停止下载。")
    except HTTPException:
        raise
    except subprocess.TimeoutExpired as error:
        raise HTTPException(504, "透明 MOV 导出超时，请减少帧数或降低尺寸后重试。") from error
    except (OSError, ValueError, TypeError, KeyError, ZeroDivisionError) as error:
        raise HTTPException(503, f"无法完成透明 MOV 编码或验证：{error}") from error


def export_mov(file: BinaryIO) -> tuple[bytes, dict[str, Any]]:
    file.seek(0, os.SEEK_END)
    if file.tell() > MAX_ARCHIVE:
        raise HTTPException(413, "MOV 导出压缩包不能超过 256 MB。")
    file.seek(0)
    try:
        with zipfile.ZipFile(file) as archive:
            members, manifest, fps, width, height = validated_members(archive)
            ffmpeg, ffprobe = resolve_tool("ffmpeg"), resolve_tool("ffprobe")
            with EXPORT_LOCK:
                TEMP_ROOT.mkdir(parents=True, exist_ok=True)
                # Read the bounded result before leaving this context: cleanup
                # also runs if the requesting browser disconnects mid-encoding.
                with tempfile.TemporaryDirectory(prefix="mov-", dir=TEMP_ROOT) as temporary:
                    root = Path(temporary)
                    write_aligned_frames(archive, members, manifest, root, width, height)
                    output = root / "animation.mov"
                    run_encoder(ffmpeg, ffprobe, root, output, fps, len(manifest["frames"]), width, height)
                    payload = output.read_bytes()
                    return payload, {"name": export_name(manifest["name"]), "width": width, "height": height, "frames": len(manifest["frames"]), "fps": str(manifest["fps"])}
    except HTTPException:
        raise
    except (zipfile.BadZipFile, zipfile.LargeZipFile, RuntimeError, ValueError, NotImplementedError, EOFError, zlib.error) as error:
        raise HTTPException(400, f"无法读取 MOV 导出压缩包：{error}") from error
    except OSError as error:
        raise HTTPException(500, f"MOV 临时文件写入失败：{error}") from error


@router.post("/mov")
async def post_mov(archive: UploadFile = File(...)) -> Response:
    try:
        payload, metadata = await run_in_threadpool(export_mov, archive.file)
    finally:
        await archive.close()
    filename = quote(f"{metadata['name']}.mov", safe="")
    return Response(payload, media_type="video/quicktime", headers={
        "Content-Disposition": f"attachment; filename=\"animation.mov\"; filename*=UTF-8''{filename}",
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Export-Width": str(metadata["width"]),
        "X-Export-Height": str(metadata["height"]), "X-Export-Frame-Count": str(metadata["frames"]), "X-Export-FPS": metadata["fps"],
    })
