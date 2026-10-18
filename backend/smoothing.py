"""Real-ESRGAN NCNN ×4 followed by a return to the source canvas size."""
from __future__ import annotations

import hashlib
from io import BytesIO
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import tempfile
import threading
from typing import Any
from urllib.request import Request as URLRequest, urlopen
import warnings
import zipfile

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

from .projects import asset_name, local_request

BACKEND = Path(__file__).resolve().parent
RUNTIME = BACKEND / "runtime" / "realesrgan"
TEMP_ROOT = BACKEND / ".tmp" / "smoothing"
MODEL = "realesrgan-x4plus-anime"
SCALE = 4
PACKAGE_URL = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip"
SOURCE_PAGE = "https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0"
MAX_PACKAGE = 256 * 1024 * 1024
MAX_UNPACKED = 512 * 1024 * 1024
MAX_UPLOAD = 24 * 1024 * 1024
MAX_INPUT_PIXELS = 4_000_000
MAX_DIMENSION = 4096
VULKAN_LOCK = threading.Lock()
INSTALL_LOCK = threading.Lock()
LAST_ERROR: str | None = None
router = APIRouter(prefix="/api/smoothing", tags=["Real-ESRGAN smoothing"], dependencies=[Depends(local_request)])


def runtime_paths(root: Path | None = None) -> tuple[Path, Path]:
    root = RUNTIME if root is None else root
    binary = Path(os.environ.get("FRAMECRAFT_ESRGAN_BINARY", "")) if os.environ.get("FRAMECRAFT_ESRGAN_BINARY") else root / "realesrgan-ncnn-vulkan.exe"
    models = Path(os.environ.get("FRAMECRAFT_ESRGAN_MODELS", "")) if os.environ.get("FRAMECRAFT_ESRGAN_MODELS") else binary.parent / "models"
    return binary.resolve(), models.resolve()


def has_runtime(root: Path) -> bool:
    required = [root / "realesrgan-ncnn-vulkan.exe", root / "models" / f"{MODEL}.param", root / "models" / f"{MODEL}.bin"]
    return all(path.is_file() and path.stat().st_size > 0 for path in required)


def status() -> dict[str, Any]:
    binary, models = runtime_paths()
    required = [binary, models / f"{MODEL}.param", models / f"{MODEL}.bin"]
    ready = all(path.is_file() and path.stat().st_size > 0 for path in required)
    if binary.parent == RUNTIME.resolve() and (RUNTIME / ".installing").exists():
        ready = False
    result: dict[str, Any] = {
        "ready": ready, "available": ready, "model": MODEL, "scale": SCALE,
        "implementation": "ncnn-vulkan",
        "busy": VULKAN_LOCK.locked() or INSTALL_LOCK.locked(),
        "runtimeDirectory": str(RUNTIME), "source": SOURCE_PAGE,
        "message": "Real-ESRGAN 平滑组件已就绪。" if ready else "尚未安装 Real-ESRGAN 平滑组件，请点击准备组件。",
    }
    if LAST_ERROR:
        result["error"] = LAST_ERROR
    return result


def download_package(destination: Path) -> str:
    request = URLRequest(PACKAGE_URL, headers={"User-Agent": "Framecraft/Real-ESRGAN-Installer"})
    digest = hashlib.sha256()
    with urlopen(request, timeout=90) as response, destination.open("wb") as output:
        length = response.headers.get("Content-Length")
        if length and int(length) > MAX_PACKAGE:
            raise RuntimeError("官方组件安装包超过大小限制。")
        total = 0
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_PACKAGE:
                raise RuntimeError("官方组件安装包超过大小限制。")
            digest.update(chunk)
            output.write(chunk)
    return digest.hexdigest()


def extract_package(package: Path, destination: Path) -> Path:
    with zipfile.ZipFile(package) as archive:
        entries = archive.infolist()
        if len(entries) > 5000 or sum(entry.file_size for entry in entries) > MAX_UNPACKED:
            raise RuntimeError("官方组件安装包大小或文件数量异常。")
        names: set[str] = set()
        for entry in entries:
            path = asset_name(entry.orig_filename.rstrip("/"))
            if path.casefold() in names:
                raise RuntimeError("组件安装包中有重名文件。")
            names.add(path.casefold())
            mode = entry.external_attr >> 16
            if stat.S_ISLNK(mode) or entry.flag_bits & 1:
                raise RuntimeError("组件安装包不能包含链接或加密文件。")
            if entry.is_dir():
                continue
            target = destination.joinpath(*PurePosixPath(path).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output, 1024 * 1024)
    binaries = list(destination.rglob("realesrgan-ncnn-vulkan.exe"))
    if len(binaries) != 1 or not has_runtime(binaries[0].parent):
        raise RuntimeError("官方安装包中缺少 Real-ESRGAN 可执行文件或 anime 模型。")
    return binaries[0].parent


def copy_runtime(source: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    # Copy the official portable package, including its licences and model files.
    # No runtime dependency on the reference application's working directory.
    shutil.copytree(source, destination, dirs_exist_ok=True)
    if not has_runtime(destination):
        raise RuntimeError("Real-ESRGAN 安装不完整。")


def prepare() -> dict[str, Any]:
    global LAST_ERROR
    with INSTALL_LOCK:
        if status()["ready"]:
            result = status()
            result["busy"] = VULKAN_LOCK.locked()
            return result
        if os.name != "nt":
            raise HTTPException(503, "自动准备仅支持 Windows；请配置 FRAMECRAFT_ESRGAN_BINARY 和 FRAMECRAFT_ESRGAN_MODELS 指向官方 NCNN 组件。")
        try:
            RUNTIME.mkdir(parents=True, exist_ok=True)
            (RUNTIME / ".installing").write_bytes(b"")
            reference = BACKEND.parent.parent / "sprite-video-lab" / "work" / "tools" / "realesrgan-ncnn-vulkan"
            if has_runtime(reference):
                copy_runtime(reference, RUNTIME)
                origin = {"source": str(reference), "copied": True}
            else:
                with tempfile.TemporaryDirectory(prefix=".realesrgan-install-", dir=RUNTIME.parent) as temporary:
                    root = Path(temporary)
                    package = root / "official.zip"
                    digest = download_package(package)
                    package_root = extract_package(package, root / "unpacked")
                    copy_runtime(package_root, RUNTIME)
                    origin = {"source": PACKAGE_URL, "sha256": digest, "copied": False}
            (RUNTIME / "framecraft-runtime.json").write_text(json.dumps({"model": MODEL, **origin}, ensure_ascii=False), encoding="utf-8")
            (RUNTIME / ".installing").unlink()
            LAST_ERROR = None
        except Exception as error:
            LAST_ERROR = f"Real-ESRGAN 准备失败：{error}。请检查网络或将官方便携组件放入 {RUNTIME}。"
            raise HTTPException(503, LAST_ERROR) from error
    return status()


def decode_image(payload: bytes) -> Image.Image:
    if not payload:
        raise HTTPException(400, "请上传需要平滑的图片。")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(payload)) as image:
                width, height = image.size
                if width > MAX_DIMENSION or height > MAX_DIMENSION or width * height > MAX_INPUT_PIXELS:
                    raise HTTPException(413, "平滑图片单边最多 4096 像素，总像素最多 400 万，请先缩小素材。")
                return ImageOps.exif_transpose(image).convert("RGBA")
    except HTTPException:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise HTTPException(413, "平滑图片像素过多，请先缩小素材。") from error
    except (UnidentifiedImageError, OSError, ValueError) as error:
        raise HTTPException(415, "无法读取平滑图片，请上传有效的图片文件。") from error


def rgb_input(image: Image.Image) -> Image.Image:
    rgba = np.asarray(image.convert("RGBA"))
    rgb = rgba[:, :, :3].copy()
    visible = rgba[:, :, 3] > 0
    if visible.all():
        return Image.fromarray(rgb)
    if not visible.any():
        return Image.new("RGB", image.size, (0, 0, 0))
    # Keep straight RGB at every visible pixel, including partial alpha. Blending
    # it onto a backdrop here would bake that backdrop into the restored PNG
    # when smooth() reapplies its original alpha. Extend nearby foreground colors
    # through clear pixels so the model sees continuous edges instead of a halo.
    _, labels = cv2.distanceTransformWithLabels(
        (~visible).astype(np.uint8), cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL,
    )
    palette = np.empty((int(labels.max()) + 1, 3), dtype=np.uint8)
    palette[labels[visible]] = rgb[visible]
    rgb[~visible] = palette[labels[~visible]]
    return Image.fromarray(rgb)


def run_model(input_path: Path, output_path: Path) -> None:
    binary, models = runtime_paths()
    command = [str(binary), "-i", str(input_path), "-o", str(output_path), "-m", str(models), "-n", MODEL,
               "-s", str(SCALE), "-t", "128", "-j", "1:1:1", "-f", "png"]
    try:
        process = subprocess.run(command, cwd=str(binary.parent), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, timeout=240, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    except subprocess.TimeoutExpired as error:
        raise HTTPException(504, "Real-ESRGAN 平滑超时，请缩小素材后重试。") from error
    except OSError as error:
        raise HTTPException(503, f"无法启动 Real-ESRGAN：{error}。请确认组件和显卡 Vulkan 驱动可用。") from error
    if process.returncode or not output_path.is_file():
        detail = process.stderr.decode("utf-8", errors="replace")[-1200:]
        if "out of memory" in detail.lower() or "out_of_device_memory" in detail.lower():
            raise HTTPException(507, "Real-ESRGAN 显存不足，请关闭其他 GPU 程序或缩小素材后重试。")
        raise HTTPException(503, f"Real-ESRGAN 处理失败，请检查显卡 Vulkan 驱动。{detail}")


def smooth(payload: bytes) -> bytes:
    global LAST_ERROR
    image = decode_image(payload)
    if not status()["ready"]:
        raise HTTPException(503, "Real-ESRGAN 组件尚未准备，请先点击准备组件。")
    # The NCNN CLI owns its Vulkan allocation until it exits; serialize every
    # invocation, including its output read, to bound simultaneous GPU usage.
    with VULKAN_LOCK:
        TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        try:
            with tempfile.TemporaryDirectory(prefix="frame-", dir=TEMP_ROOT) as temporary:
                root = Path(temporary)
                input_path, output_path = root / "input.png", root / "upscaled.png"
                rgb_input(image).save(input_path, "PNG")
                run_model(input_path, output_path)
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", Image.DecompressionBombWarning)
                    with Image.open(output_path) as output:
                        if output.size != (image.width * SCALE, image.height * SCALE):
                            raise HTTPException(503, "Real-ESRGAN 返回了错误尺寸，已停止处理。")
                        restored = output.convert("RGB").resize(image.size, Image.Resampling.LANCZOS)
                restored.putalpha(image.getchannel("A"))
                buffer = BytesIO()
                restored.save(buffer, "PNG")
                LAST_ERROR = None
                return buffer.getvalue()
        except HTTPException as error:
            LAST_ERROR = str(error.detail)
            raise
        except (OSError, ValueError, Image.DecompressionBombError) as error:
            LAST_ERROR = f"Real-ESRGAN 输出无法读取：{error}"
            raise HTTPException(503, LAST_ERROR) from error


@router.get("/status")
async def get_status() -> dict[str, Any]:
    return status()


@router.post("/prepare")
async def post_prepare() -> dict[str, Any]:
    return await run_in_threadpool(prepare)


@router.post("/frame")
async def post_frame(image: UploadFile = File(...)) -> Response:
    try:
        payload = await image.read(MAX_UPLOAD + 1)
    finally:
        await image.close()
    if len(payload) > MAX_UPLOAD:
        raise HTTPException(413, "平滑图片文件不能超过 24 MB。")
    png = await run_in_threadpool(smooth, payload)
    return Response(png, media_type="image/png", headers={"Cache-Control": "no-store", "X-Smoothing-Model": MODEL, "X-Smoothing-Scale": str(SCALE)})
