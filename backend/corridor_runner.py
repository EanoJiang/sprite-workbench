"""Adapter for the pinned, unmodified official CorridorKey neural engine.

CorridorKey's ``processed`` output is *linear premultiplied* RGBA intended
for EXR. Browser PNGs require straight sRGB RGB and linear alpha; this module
performs that conversion explicitly. No heuristic replaces model inference.
"""
from __future__ import annotations

import gc
import os
from pathlib import Path
import re
import sys
import tempfile
from typing import Any

import numpy as np
from PIL import Image

BACKEND_DIR = Path(__file__).resolve().parent
VENDOR_DIR = BACKEND_DIR / "vendor" / "CorridorKey"
MODEL_DIR = BACKEND_DIR / "models"
CHECKPOINT_DIR = MODEL_DIR / "corridorkey"
UPSTREAM_REVISION = "97e55a453060745bead1befd293f6e523c4b845c"
MODEL_SPECS = {
    "green": {
        "repo": "nikopueringer/CorridorKey_v1.0",
        "revision": "f6386ddf042d8e92aeb5fd16cb9b101cff508195",
        "filename": "CorridorKey_v1.0.safetensors",
    },
    "blue": {
        "repo": "nikopueringer/CorridorKeyBlue_1.0",
        "revision": "51e6ccaa4b703f54be20a72ac2c37784fb9ba1cd",
        "filename": "CorridorKeyBlue_1.0.safetensors",
    },
}
RESOLUTIONS = {512, 768, 1024, 1312, 2048}

# This workstation's system drive is full. Set paths before importing Torch,
# timm or Hugging Face; no model download or GPU initialization occurs here.
_TEMP_DIR = BACKEND_DIR / ".tmp"
_TEMP_DIR.mkdir(parents=True, exist_ok=True)
for _name, _path in {
    "TEMP": _TEMP_DIR,
    "TMP": _TEMP_DIR,
    "TMPDIR": _TEMP_DIR,
    "HF_HOME": MODEL_DIR / "huggingface",
    "HF_HUB_CACHE": MODEL_DIR / "huggingface" / "hub",
    "HF_MODULES_CACHE": MODEL_DIR / "huggingface" / "modules",
    "HF_XET_CACHE": MODEL_DIR / "huggingface" / "xet",
    "TORCH_HOME": MODEL_DIR / "torch",
    "TORCHINDUCTOR_CACHE_DIR": MODEL_DIR / "torch" / "inductor",
    "TORCH_EXTENSIONS_DIR": MODEL_DIR / "torch" / "extensions",
    "TRITON_CACHE_DIR": MODEL_DIR / "torch" / "triton",
    "XDG_CACHE_HOME": MODEL_DIR / ".cache",
    "PIP_CACHE_DIR": BACKEND_DIR / ".pip-cache",
}.items():
    os.environ[_name] = str(_path)
tempfile.tempdir = str(_TEMP_DIR)
os.environ["CORRIDORKEY_SKIP_COMPILE"] = "1"


def _key_rgb(key_color: str) -> np.ndarray:
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", key_color):
        raise ValueError("背景颜色必须是 #RRGGBB 格式。")
    return np.array([int(key_color[index:index + 2], 16) for index in (1, 3, 5)], dtype=np.float32) / 255.0


def _screen_color(key_color: str) -> tuple[str, int]:
    key = _key_rgb(key_color)
    channel = int(np.argmax(key))
    if channel not in (1, 2) or float(key.max() - key.min()) < 0.1:
        raise ValueError("CorridorKey 使用官方绿幕 / 蓝幕模型，请选择绿色或蓝色背景；其他背景请使用 BiRefNet。")
    return ("green", 1) if channel == 1 else ("blue", 2)


def _coarse_chroma_hint(image: np.ndarray, key_color: str) -> np.ndarray:
    """Rough guidance for CorridorKey's fourth input channel, never the output.

    The dedicated model still predicts both foreground color and alpha. A
    provided BiRefNet mask takes precedence over this inexpensive guidance.
    """
    key = _key_rgb(key_color)
    rgb = image.astype(np.float32) / 255.0
    delta = rgb - key
    chroma = delta - delta.mean(axis=2, keepdims=True)
    distance = np.sqrt(np.sum(chroma * chroma, axis=2))
    hint = np.clip((distance - 0.08) / 0.22, 0.0, 1.0)
    channel = int(np.argmax(key))
    other = [index for index in range(3) if index != channel]
    # Retain neutral and dark clothing in the coarse guidance.
    neutral = rgb[:, :, channel] <= np.maximum(rgb[:, :, other[0]], rgb[:, :, other[1]]) + 0.025
    return np.ascontiguousarray(np.where(neutral, 1.0, hint), dtype=np.float32)


def _normalize_hint(hint: np.ndarray | Image.Image, size: tuple[int, int]) -> np.ndarray:
    if isinstance(hint, Image.Image):
        hint = hint.getchannel("A") if "A" in hint.getbands() else hint.convert("L")
        values = np.asarray(hint)
    else:
        values = np.asarray(hint)
    if values.ndim == 3 and values.shape[2] == 1:
        values = values[:, :, 0]
    if values.ndim != 2:
        raise ValueError("Alpha 提示必须为 H×W 单通道图像。")
    if values.dtype == np.bool_:
        values = values.astype(np.float32)
    elif np.issubdtype(values.dtype, np.integer):
        maximum = 255.0 if values.dtype.itemsize == 1 else float(np.iinfo(values.dtype).max)
        values = values.astype(np.float32) / maximum
    else:
        values = values.astype(np.float32)
    if not np.isfinite(values).all():
        raise ValueError("Alpha 提示包含非有限数值。")
    if values.shape != (size[1], size[0]):
        mask_image = Image.fromarray(np.clip(values, 0, 1), mode="F")
        values = np.asarray(mask_image.resize(size, Image.Resampling.BILINEAR), dtype=np.float32)
    return np.ascontiguousarray(np.clip(values, 0.0, 1.0), dtype=np.float32)


def processed_to_rgba(processed: np.ndarray) -> Image.Image:
    """Convert official linear-premultiplied output to a straight sRGB PNG."""
    values = np.asarray(processed, dtype=np.float32)
    if values.ndim != 3 or values.shape[2] != 4 or not np.isfinite(values).all():
        raise RuntimeError("CorridorKey 返回了无效的 RGBA 预测。")
    alpha_raw = values[:, :, 3:4]
    linear = np.divide(values[:, :, :3], alpha_raw, out=np.zeros_like(values[:, :, :3]), where=alpha_raw > 1e-6)
    linear = np.maximum(linear, 0.0)
    # IEC 61966-2-1 piecewise transfer, identical to official color_utils.
    srgb = np.where(linear <= 0.0031308, linear * 12.92, 1.055 * np.power(linear, 1 / 2.4) - 0.055)
    rgba = np.concatenate([np.clip(srgb, 0, 1), np.clip(alpha_raw, 0, 1)], axis=2)
    return Image.fromarray(np.rint(rgba * 255).astype(np.uint8), mode="RGBA")


class CorridorKeyRunner:
    def __init__(self) -> None:
        self._engine: Any = None
        self._device: str | None = None
        self._resolution: int | None = None
        self._screen: str | None = None
        self._loading = False
        self._error: str | None = None
        self._last_hint: str | None = None

    @staticmethod
    def _downloaded(screen: str) -> bool:
        path = CHECKPOINT_DIR / MODEL_SPECS[screen]["filename"]
        return path.is_file() and path.stat().st_size > 1024

    def status(self) -> dict[str, Any]:
        """Filesystem / Python state only; safe during a long-running inference."""
        variants = {
            screen: {**spec, "downloaded": self._downloaded(screen), "loaded": self._engine is not None and self._screen == screen}
            for screen, spec in MODEL_SPECS.items()
        }
        return {
            "loaded": self._engine is not None,
            "downloaded": variants["green"]["downloaded"],
            "loading": self._loading,
            "device": self._device,
            "resolution": self._resolution,
            "screen_color": self._screen,
            "hint": self._last_hint,
            "error": self._error,
            "variants": variants,
            "cache_dir": str(CHECKPOINT_DIR),
            "source_revision": UPSTREAM_REVISION,
            "license": "CorridorKey Licence 1.0 / CC BY-NC-SA 4.0 with additional terms",
        }

    def _checkpoint(self, screen: str) -> Path:
        spec = MODEL_SPECS[screen]
        path = CHECKPOINT_DIR / spec["filename"]
        if not self._downloaded(screen):
            from huggingface_hub import hf_hub_download
            CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)
            downloaded = hf_hub_download(
                repo_id=spec["repo"], filename=spec["filename"], revision=spec["revision"],
                local_dir=str(CHECKPOINT_DIR), cache_dir=str(MODEL_DIR / "huggingface" / "hub"),
            )
            path = Path(downloaded)
        return path

    def prepare(self, device: str = "auto", resolution: int = 768) -> dict[str, Any]:
        return self._prepare(device, resolution, "green")

    def _prepare(self, device: str, resolution: int, screen: str) -> dict[str, Any]:
        if device not in {"auto", "cuda", "cpu"}:
            raise ValueError("运行设备必须是 auto、cuda 或 cpu。")
        if resolution not in RESOLUTIONS:
            raise ValueError("AI 分辨率必须是 512、768、1024、1312 或 2048。")
        self._loading = True
        self._error = None
        try:
            import torch
            cuda = bool(torch.cuda.is_available())
            if device == "cuda" and not cuda:
                raise RuntimeError("CUDA 不可用，请安装 CUDA 版 PyTorch 或选择 CPU。")
            chosen = "cuda" if cuda and device != "cpu" else "cpu"
            dtype = torch.float16 if chosen == "cuda" else torch.float32
            if self._engine is not None and (self._resolution != resolution or self._screen != screen):
                self.release(unload=True)
            if self._engine is None:
                if not (VENDOR_DIR / "CorridorKeyModule" / "inference_engine.py").is_file():
                    raise RuntimeError("缺少官方 CorridorKey 源码，请重新运行安装脚本。")
                checkpoint = self._checkpoint(screen)
                if str(VENDOR_DIR) not in sys.path:
                    sys.path.insert(0, str(VENDOR_DIR))
                from CorridorKeyModule import CorridorKeyEngine
                self._engine = CorridorKeyEngine(
                    checkpoint_path=str(checkpoint), device=chosen, img_size=resolution,
                    use_refiner=True, mixed_precision=False, model_precision=dtype,
                )
                self._resolution = resolution
                self._screen = screen
            elif self._device != chosen:
                self._engine.model.to(device=chosen, dtype=dtype)
                self._engine.device = torch.device(chosen)
                self._engine.model_precision = dtype
                self._engine.mean = self._engine.mean.to(device=chosen, dtype=dtype)
                self._engine.std = self._engine.std.to(device=chosen, dtype=dtype)
            self._engine.model.eval()
            self._device = chosen
            return self.status()
        except Exception as error:
            self._error = str(error)
            self.release(unload=True)
            raise
        finally:
            self._loading = False

    def infer(
        self, image: Image.Image, device: str = "auto", resolution: int = 768,
        hint: np.ndarray | Image.Image | None = None, key_color: str = "#47ca30", spill: float = 0.7,
    ) -> tuple[Image.Image, str]:
        screen, channel = _screen_color(key_color)
        if not np.isfinite(spill) or not 0 <= spill <= 1:
            raise ValueError("去色溢强度必须在 0–1 之间。")
        original = image.convert("RGB")
        # PIL-backed np.asarray buffers are read-only; Torch expects writable
        # storage even though this inference path does not mutate its inputs.
        pixels = np.array(original, dtype=np.uint8, copy=True, order="C")
        mask = _coarse_chroma_hint(pixels, key_color) if hint is None else _normalize_hint(hint, original.size)
        self._last_hint = "chroma guidance" if hint is None else "provided alpha / BiRefNet"
        self._prepare(device, resolution, screen)
        try:
            result = self._engine.process_frame(
                pixels, mask, input_is_linear=False, fg_is_straight=True,
                despill_strength=float(spill), auto_despeckle=False,
                generate_comp=False, post_process_on_gpu=False, screen_channel=channel,
            )
            if not isinstance(result, dict) or "processed" not in result:
                raise RuntimeError("CorridorKey 未返回 processed RGBA 结果。")
            output = processed_to_rgba(result["processed"])
            if output.size != original.size:
                raise RuntimeError("CorridorKey 返回的图像尺寸不匹配。")
            self._error = None
            return output, str(self._device)
        except Exception as error:
            self._error = str(error)
            raise

    def release(self, unload: bool = False) -> None:
        """Offload weights between models; optionally discard the cached engine."""
        if self._engine is not None:
            try:
                import torch
                self._engine.model.to(device="cpu", dtype=torch.float32)
                self._engine.device = torch.device("cpu")
                self._engine.model_precision = torch.float32
                self._engine.mean = self._engine.mean.to(device="cpu", dtype=torch.float32)
                self._engine.std = self._engine.std.to(device="cpu", dtype=torch.float32)
                self._device = "cpu"
            except Exception:
                unload = True
            if unload:
                self._engine = None
                self._device = None
                self._resolution = None
                self._screen = None
        gc.collect()
        # Avoid importing Torch from health/status or an unused model's release.
        torch_module = sys.modules.get("torch")
        if torch_module is not None and torch_module.cuda.is_available():
            torch_module.cuda.empty_cache()


runner = CorridorKeyRunner()
