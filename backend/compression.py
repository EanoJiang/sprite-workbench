"""CPU PNG precision compression with alpha-correct Pillow resampling."""
from __future__ import annotations

from io import BytesIO
import math
from typing import Literal
import warnings

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
import numpy as np
from PIL import Image, ImageFilter, ImageOps, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

Algorithm = Literal["lanczos", "palette", "nearest"]
ResizeMode = Literal["hard", "soft"]
MAX_UPLOAD = 16 * 1024 * 1024
MAX_DIMENSION = 8192
MAX_PIXELS = 32_000_000
router = APIRouter(prefix="/api/compression", tags=["Animation frame compression"])


def decode_input(payload: bytes) -> Image.Image:
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
        raise HTTPException(status_code=415, detail="无法读取图片，请上传有效的 PNG、JPEG 或 WebP。") from error


def clear_transparency(image: Image.Image, threshold: int) -> Image.Image:
    pixels = np.array(image.convert("RGBA"), dtype=np.uint8)
    clear = pixels[:, :, 3] <= threshold
    pixels[clear] = 0
    return Image.fromarray(pixels)


def sharpen_opaque(image: Image.Image, amount: int) -> Image.Image:
    if amount <= 0:
        return image
    # Keep soft edges untouched; erosion also protects the adjacent opaque rim.
    alpha = image.getchannel("A")
    mask = alpha.point(lambda value: 255 if value == 255 else 0).filter(ImageFilter.MinFilter(3))
    rgb = image.convert("RGB")
    sharpened = rgb.filter(ImageFilter.UnsharpMask(radius=0.8, percent=amount, threshold=3))
    rgb.paste(sharpened, (0, 0), mask)
    result = rgb.convert("RGBA")
    result.putalpha(alpha)
    return result


def indexed_png_image(image: Image.Image, colors: int, threshold: int) -> Image.Image:
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8)
    transparent = rgba[:, :, 3] == 0
    if np.any(transparent):
        # Reserve transparency explicitly: octree quantization can otherwise drop a
        # rare clear pixel when the visible colors consume the whole palette budget.
        indices = np.zeros(transparent.shape, dtype=np.uint8)
        palette = [0, 0, 0, 0]
        if not np.all(transparent):
            visible = Image.fromarray(rgba[~transparent][None, :, :])
            quantized = visible.quantize(colors=colors - 1, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
            indices[~transparent] = np.asarray(quantized).reshape(-1) + 1
            palette.extend((quantized.getpalette("RGBA") or [])[:(colors - 1) * 4])
        indexed = Image.frombytes("P", image.size, indices.tobytes())
        indexed.putpalette(palette, rawmode="RGBA")
    else:
        indexed = image.quantize(colors=colors, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    # Palette entries carry alpha (PNG tRNS); clear hidden color after quantization too.
    palette = indexed.getpalette("RGBA")
    if palette is None:
        raise RuntimeError("无法生成带透明度的 PNG 调色板。")
    for index in range(0, len(palette), 4):
        if palette[index + 3] <= threshold:
            palette[index:index + 4] = [0, 0, 0, 0]
    indexed.putpalette(palette, rawmode="RGBA")
    return indexed


def compress_image(
    image: Image.Image, scale: float = 0.5, algorithm: Algorithm = "lanczos",
    alpha_threshold: int = 8, sharpen: int = 80, colors: int = 128,
    resize_mode: ResizeMode | None = None,
) -> tuple[bytes, int, int]:
    if not math.isfinite(scale) or not 0.05 <= scale <= 1:
        raise ValueError("缩放比例必须在 0.05 到 1 之间。")
    if algorithm not in {"lanczos", "palette", "nearest"}:
        raise ValueError("不支持的压缩算法。")
    if resize_mode is not None and resize_mode not in {"hard", "soft"}:
        raise ValueError("不支持的缩放方式。")
    effective_resize = resize_mode or ("hard" if algorithm == "nearest" else "soft")
    if not 0 <= alpha_threshold <= 64 or not 0 <= sharpen <= 200 or not 2 <= colors <= 256:
        raise ValueError("压缩参数超出有效范围。")
    width = max(1, math.floor(image.width * scale + 0.5))
    height = max(1, math.floor(image.height * scale + 0.5))
    source = clear_transparency(image, alpha_threshold)
    if source.size == (width, height):
        resized = source
    elif effective_resize == "hard":
        # Nearest chooses an exact source pixel; no interpolation or alpha division.
        resized = source.resize((width, height), Image.Resampling.NEAREST)
    else:
        # RGBa is Pillow's associated/premultiplied-alpha format. Resample alpha and
        # premultiplied colors together, then restore straight RGBA for PNG output.
        resized = source.convert("RGBa").resize((width, height), Image.Resampling.LANCZOS).convert("RGBA")
    resized = clear_transparency(resized, alpha_threshold)
    resized = sharpen_opaque(resized, sharpen)
    resized = clear_transparency(resized, alpha_threshold)
    output = indexed_png_image(resized, colors, alpha_threshold) if algorithm == "palette" else resized
    buffer = BytesIO()
    output.save(buffer, format="PNG", optimize=True, compress_level=9)
    return buffer.getvalue(), width, height


def process_payload(payload: bytes, scale: float, algorithm: Algorithm, alpha_threshold: int, sharpen: int, colors: int, resize_mode: ResizeMode | None = None) -> tuple[bytes, int, int]:
    return compress_image(decode_input(payload), scale, algorithm, alpha_threshold, sharpen, colors, resize_mode)


@router.post("/frame")
async def compress_frame(
    image: UploadFile = File(...), scale: float = Form(0.5, ge=0.05, le=1),
    algorithm: Algorithm = Form("lanczos"), alpha_threshold: int = Form(8, ge=0, le=64),
    sharpen: int = Form(80, ge=0, le=200), colors: int = Form(128, ge=2, le=256),
    resize_mode: ResizeMode | None = Form(None),
) -> Response:
    try:
        payload = await image.read(MAX_UPLOAD + 1)
    finally:
        await image.close()
    if len(payload) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="单帧图片不能超过 16 MB。")
    if not payload:
        raise HTTPException(status_code=400, detail="上传的图片为空。")
    png, width, height = await run_in_threadpool(process_payload, payload, scale, algorithm, alpha_threshold, sharpen, colors, resize_mode)
    return Response(png, media_type="image/png", headers={
        "X-Compression-Width": str(width), "X-Compression-Height": str(height),
        "X-Compression-Algorithm": algorithm, "X-Compression-Original-Bytes": str(len(payload)),
        "X-Compression-Resize-Mode": resize_mode or ("hard" if algorithm == "nearest" else "soft"),
        "X-Compression-Output-Bytes": str(len(png)), "Cache-Control": "no-store",
    })
