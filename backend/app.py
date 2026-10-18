"""Local Sprite Workbench model API. Run: python -m backend.app."""
from __future__ import annotations

import importlib
from contextlib import asynccontextmanager
from io import BytesIO
from pathlib import Path
import re
import threading
from typing import Any, Literal
import warnings

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, field_validator
from starlette.concurrency import run_in_threadpool
from starlette.types import ASGIApp, Receive, Scope, Send

from .birefnet_runner import runner as birefnet, runtime_info

Mode = Literal["birefnet", "corridorkey", "hybrid"]
Device = Literal["auto", "cuda", "cpu"]
Variant = Literal["standard", "hr-matting", "lite"]
RESOLUTIONS = {512, 768, 1024, 1312, 2048}
MAX_UPLOAD = 16 * 1024 * 1024
MAX_DIMENSION = 8192
MAX_PIXELS = 32_000_000
INFERENCE_LOCK = threading.Lock()
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


class UploadSizeLimitMiddleware:
    """Bound chunked uploads before Starlette can spool an unbounded file to disk."""
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("path") != "/api/matte" or scope.get("method") != "POST":
            await self.app(scope, receive, send)
            return
        chunks: list[bytes] = []
        total = 0
        more = True
        while more:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            total += len(chunk)
            if total > MAX_UPLOAD + 1024 * 1024:
                await JSONResponse(status_code=413, content={"detail": "图片文件不能超过 16 MB。"})(scope, receive, send)
                return
            chunks.append(chunk)
            more = message.get("more_body", False)
        payload = b"".join(chunks)
        delivered = False

        async def replay() -> dict[str, Any]:
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": payload, "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        yield
    finally:
        from .tuner import manager
        await run_in_threadpool(manager.shutdown)


app = FastAPI(title="Sprite Workbench · local matting", version="1.0.0", lifespan=lifespan)
app.add_middleware(UploadSizeLimitMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
    expose_headers=["X-Matte-Mode", "X-Matte-Device"],
)


def corridor_runner() -> Any:
    # Optional until the separate official CorridorKey adapter has been installed.
    module = importlib.import_module("backend.corridor_runner")
    return getattr(module, "runner", module)


@app.middleware("http")
async def reject_oversized_requests(request: Request, call_next: Any) -> Response:
    length = request.headers.get("content-length")
    if request.url.path == "/api/matte" and length:
        try:
            if int(length) > MAX_UPLOAD + 1024 * 1024:
                return JSONResponse(status_code=413, content={"detail": "图片文件不能超过 16 MB。"})
        except ValueError:
            return JSONResponse(status_code=400, content={"detail": "无效的 Content-Length。"})
    return await call_next(request)


def health_snapshot() -> dict[str, Any]:
    try:
        corridor_status = corridor_runner().status()
    except ImportError as error:
        corridor_status = {"loaded": False, "downloaded": False, "error": f"CorridorKey 运行依赖尚未安装：{error}"}
    return {"status": "ok", **runtime_info(), "busy": INFERENCE_LOCK.locked(), "models": {"birefnet": birefnet.status(), "corridorkey": corridor_status}}


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return health_snapshot()


class PrepareRequest(BaseModel):
    mode: Mode = "birefnet"
    device: Device = "auto"
    resolution: int = 1024
    birefnet_variant: Variant = "standard"

    @field_validator("resolution")
    @classmethod
    def valid_resolution(cls, value: int) -> int:
        if value not in RESOLUTIONS:
            raise ValueError("AI 分辨率必须是 512、768、1024、1312 或 2048。")
        return value


def error_response(error: Exception) -> HTTPException:
    message = str(error)
    lower = message.lower()
    if "out of memory" in lower or "cuda error: memory" in lower:
        return HTTPException(status_code=507, detail="显存不足。请关闭其他占用显存的程序，将 AI 分辨率改为 512 / 768，选择 BiRefNet Lite，或改用 CPU。")
    if isinstance(error, ImportError):
        return HTTPException(status_code=503, detail=f"模型运行依赖不完整，请先运行安装脚本。缺少依赖：{message}")
    if "cuda" in lower and ("unavailable" in lower or "不可用" in message):
        return HTTPException(status_code=503, detail=message)
    return HTTPException(status_code=503, detail=f"AI 模型处理失败：{message[:900]}。请检查网络、模型文件及 Python 依赖后重试。")


def safe_release(runner: Any) -> None:
    try:
        runner.release()
    except Exception:
        pass


def prepare_models(options: PrepareRequest) -> dict[str, Any]:
    with INFERENCE_LOCK:
        try:
            if options.mode in {"birefnet", "hybrid"}:
                try:
                    safe_release(corridor_runner())
                except ImportError:
                    pass
                birefnet.prepare(device=options.device, resolution=options.resolution, variant=options.birefnet_variant)
            if options.mode in {"corridorkey", "hybrid"}:
                birefnet.release()
                corridor_runner().prepare(device=options.device, resolution=options.resolution)
        except Exception as error:
            safe_release(birefnet)
            try:
                safe_release(corridor_runner())
            except ImportError:
                pass
            raise error_response(error) from error
    return health_snapshot()


@app.post("/api/models/prepare")
async def prepare(options: PrepareRequest) -> dict[str, Any]:
    return await run_in_threadpool(prepare_models, options)


def decode_image(payload: bytes) -> Image.Image:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(payload)) as image:
                if image.width > MAX_DIMENSION or image.height > MAX_DIMENSION or image.width * image.height > MAX_PIXELS:
                    raise HTTPException(status_code=413, detail="图片尺寸超限：单边最多 8192 像素，总像素最多 3200 万。")
                image.load()
                return ImageOps.exif_transpose(image).convert("RGBA")
    except HTTPException:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise HTTPException(status_code=413, detail="图片像素过多，请缩小图片后重试。") from error
    except (UnidentifiedImageError, OSError, ValueError) as error:
        raise HTTPException(status_code=415, detail="无法读取图片。请上传有效的 PNG、JPEG 或 WebP 图片。") from error


def despill_edges(image: Image.Image, key_color: str, amount: float) -> Image.Image:
    """Optional RGB correction on the learned matte; never estimates foreground alpha."""
    if amount <= 0:
        return image
    key = np.array([int(key_color[index:index + 2], 16) for index in (1, 3, 5)])
    dominant = int(np.argmax(key))
    others = [index for index in range(3) if index != dominant]
    if key[dominant] - max(key[others]) <= 24:
        return image
    rgba = np.array(image.convert("RGBA"), dtype=np.uint8)
    pixels = rgba.astype(np.float32)
    alpha = pixels[:, :, 3] / 255.0
    neutral = np.maximum(pixels[:, :, others[0]], pixels[:, :, others[1]])
    excess = np.maximum(0, pixels[:, :, dominant] - neutral)
    pixels[:, :, dominant] -= excess * amount * (1 - alpha)
    rgba[:, :, :3] = np.rint(pixels[:, :, :3]).clip(0, 255).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def run_matte(image: Image.Image, mode: str, device: str, resolution: int, variant: str, key_color: str, spill: float) -> tuple[bytes, str]:
    with INFERENCE_LOCK:
        try:
            rgb = image.convert("RGB")
            if mode == "birefnet":
                try:
                    safe_release(corridor_runner())
                except ImportError:
                    pass
                output, chosen_device = birefnet.infer(rgb, device=device, resolution=resolution, variant=variant)
                output = despill_edges(output, key_color, spill)
            elif mode == "corridorkey":
                birefnet.release()
                output, chosen_device = corridor_runner().infer(rgb, device=device, resolution=resolution, hint=None, key_color=key_color, spill=spill)
            else:
                corridor = corridor_runner()
                safe_release(corridor)
                hint_image, _ = birefnet.infer(rgb, device=device, resolution=resolution, variant=variant)
                hint = np.asarray(hint_image.getchannel("A"), dtype=np.float32) / 255.0
                # The two neural networks must not be resident on the GPU together.
                birefnet.release()
                output, chosen_device = corridor.infer(rgb, device=device, resolution=resolution, hint=hint, key_color=key_color, spill=spill)
            if output.size != image.size:
                raise RuntimeError("模型返回了错误的画面尺寸，已停止导出。")
            output = output.convert("RGBA")
            original_alpha = np.asarray(image.getchannel("A"), dtype=np.float32) / 255.0
            matte = np.asarray(output.getchannel("A"), dtype=np.float32)
            output.putalpha(Image.fromarray(np.rint(matte * original_alpha).astype(np.uint8), "L"))
            buffer = BytesIO()
            output.save(buffer, format="PNG")
            return buffer.getvalue(), chosen_device
        except HTTPException:
            raise
        except Exception as error:
            safe_release(birefnet)
            try:
                safe_release(corridor_runner())
            except ImportError:
                pass
            raise error_response(error) from error


@app.post("/api/matte")
async def matte(
    image: UploadFile = File(...),
    mode: Mode = Form("birefnet"),
    device: Device = Form("auto"),
    resolution: int = Form(1024),
    birefnet_variant: Variant = Form("standard"),
    key_color: str = Form("#47ca30"),
    spill: float = Form(0.7, ge=0, le=1),
) -> Response:
    if resolution not in RESOLUTIONS:
        raise HTTPException(status_code=422, detail="AI 分辨率必须是 512、768、1024、1312 或 2048。")
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", key_color):
        raise HTTPException(status_code=422, detail="key_color 必须为 #RRGGBB 格式。")
    try:
        payload = await image.read(MAX_UPLOAD + 1)
    finally:
        await image.close()
    if len(payload) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="图片文件不能超过 16 MB。")
    if not payload:
        raise HTTPException(status_code=400, detail="上传的图片为空。")
    decoded = await run_in_threadpool(decode_image, payload)
    png, chosen_device = await run_in_threadpool(run_matte, decoded, mode, device, resolution, birefnet_variant, key_color, spill)
    return Response(content=png, media_type="image/png", headers={"X-Matte-Mode": mode, "X-Matte-Device": chosen_device, "Cache-Control": "no-store"})


# Mount after /api routes so the production build can share the same local port.
from .tuner import router as tuner_router
from .compression import router as compression_router
from .projects import router as projects_router
from .smoothing import router as smoothing_router
from .exports import router as exports_router
app.include_router(tuner_router)
app.include_router(compression_router)
app.include_router(projects_router)
app.include_router(smoothing_router)
app.include_router(exports_router)

DIST_DIR = Path(__file__).resolve().parent.parent / "dist"
if DIST_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765)
