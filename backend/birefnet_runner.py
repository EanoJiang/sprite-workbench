"""Pinned official BiRefNet inference; no heuristic background-removal fallback.

Inference follows the model author's Hugging Face tutorial:
https://huggingface.co/ZhengPeng7/BiRefNet#use-the-loaded-birefnet-for-inference
The allow-listed remote Python code and safetensors weights are pinned together.
"""
from __future__ import annotations

import gc
import os
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

BACKEND_DIR = Path(__file__).resolve().parent
MODEL_DIR = BACKEND_DIR / "models"
HF_HOME = MODEL_DIR / "huggingface"
HUB_CACHE = HF_HOME / "hub"
os.environ.setdefault("HF_HOME", str(HF_HOME))
os.environ.setdefault("HF_HUB_CACHE", str(HUB_CACHE))
os.environ.setdefault("HF_MODULES_CACHE", str(HF_HOME / "modules"))
os.environ.setdefault("TORCH_HOME", str(MODEL_DIR / "torch"))

# Official author repositories; revision and code_revision must remain identical.
MODEL_SPECS = {
    "standard": {"repo": "ZhengPeng7/BiRefNet", "revision": "e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4"},
    "hr-matting": {"repo": "ZhengPeng7/BiRefNet_HR-matting", "revision": "5d6b6f8adcb5b417c871b1d84ceaae9871355b7f"},
    "lite": {"repo": "ZhengPeng7/BiRefNet_lite", "revision": "aa62cd87eafb9cc43056d08ef3615a14628b831d"},
}


def runtime_info() -> dict[str, Any]:
    """Does not acquire the inference lock, so /health stays responsive."""
    try:
        import torch
        cuda = bool(torch.cuda.is_available())
        free, total = torch.cuda.mem_get_info(0) if cuda else (0, 0)
        return {
            "cuda": cuda,
            "gpu": torch.cuda.get_device_name(0) if cuda else None,
            "device": "cuda" if cuda else "cpu",
            "vram_total": int(total),
            "vram_free": int(free),
            "versions": {"torch": torch.__version__, "cuda": torch.version.cuda},
        }
    except ImportError:
        return {"cuda": False, "gpu": None, "device": "cpu", "vram_total": 0, "vram_free": 0, "versions": {}, "runtime_error": "请先安装 backend/requirements.txt 中的 Python 依赖。"}
    except Exception as error:
        return {"cuda": False, "gpu": None, "device": "cpu", "vram_total": 0, "vram_free": 0, "versions": {}, "runtime_error": str(error)}


def resolve_device(device: str) -> str:
    import torch
    if device not in {"auto", "cuda", "cpu"}:
        raise ValueError("运行设备必须是 auto、cuda 或 cpu。")
    cuda = bool(torch.cuda.is_available())
    if device == "cuda" and not cuda:
        raise RuntimeError("CUDA 不可用。请安装与显卡驱动匹配的 CUDA 版 PyTorch，或选择 CPU。")
    return "cuda" if cuda and device != "cpu" else "cpu"


class BiRefNetRunner:
    def __init__(self) -> None:
        self._model: Any = None
        self._variant: str | None = None
        self._device = "cpu"
        self._loading = False
        self._error: str | None = None

    def _downloaded(self, variant: str) -> bool:
        spec = MODEL_SPECS[variant]
        snapshot = HUB_CACHE / f"models--{spec['repo'].replace('/', '--')}" / "snapshots" / spec["revision"]
        return all((snapshot / filename).is_file() for filename in ("model.safetensors", "config.json", "birefnet.py", "BiRefNet_config.py"))

    def status(self) -> dict[str, Any]:
        variants = {
            name: {**spec, "downloaded": self._downloaded(name), "loaded": self._model is not None and self._variant == name}
            for name, spec in MODEL_SPECS.items()
        }
        return {
            "loaded": self._model is not None,
            "downloaded": any(item["downloaded"] for item in variants.values()),
            "loading": self._loading,
            "variant": self._variant,
            "device": self._device if self._model is not None else None,
            "error": self._error,
            "variants": variants,
            "cache_dir": str(HUB_CACHE),
        }

    def prepare(self, device: str = "auto", resolution: int = 1024, variant: str = "standard") -> dict[str, Any]:
        if variant not in MODEL_SPECS:
            raise ValueError("不支持的 BiRefNet 模型版本。")
        if resolution not in {512, 768, 1024, 1312, 2048}:
            raise ValueError("AI 分辨率必须是 512、768、1024、1312 或 2048。")
        self._loading = True
        self._error = None
        try:
            import torch
            chosen = resolve_device(device)
            dtype = torch.float16 if chosen == "cuda" else torch.float32
            if self._model is not None and self._variant != variant:
                self.release(unload=True)
            if self._model is None:
                from transformers import AutoModelForImageSegmentation
                HUB_CACHE.mkdir(parents=True, exist_ok=True)
                spec = MODEL_SPECS[variant]
                self._model = AutoModelForImageSegmentation.from_pretrained(
                    spec["repo"], revision=spec["revision"], code_revision=spec["revision"],
                    trust_remote_code=True, use_safetensors=True,
                    cache_dir=str(HUB_CACHE), torch_dtype=dtype,
                )
                self._variant = variant
            if self._device != chosen or next(self._model.parameters()).dtype != dtype:
                self._model.to(device=chosen, dtype=dtype)
            self._device = chosen
            self._model.eval()
            return self.status()
        except Exception as error:
            self._error = str(error)
            # A failed .to(cuda) can leave a partially transferred model; offload it.
            self.release()
            raise
        finally:
            self._loading = False

    def infer(self, image: Image.Image, device: str = "auto", resolution: int = 1024, variant: str = "standard") -> tuple[Image.Image, str]:
        import torch
        import torch.nn.functional as functional
        self.prepare(device=device, resolution=resolution, variant=variant)
        original = image.convert("RGB")
        resized = original.resize((resolution, resolution), Image.Resampling.BILINEAR)
        array = np.asarray(resized, dtype=np.float32) / 255.0
        array = (array - np.array([0.485, 0.456, 0.406], dtype=np.float32)) / np.array([0.229, 0.224, 0.225], dtype=np.float32)
        dtype = torch.float16 if self._device == "cuda" else torch.float32
        inputs = torch.from_numpy(np.ascontiguousarray(array.transpose(2, 0, 1))).unsqueeze(0).to(device=self._device, dtype=dtype)
        try:
            with torch.inference_mode():
                prediction = self._model(inputs)[-1].sigmoid().float()
                prediction = functional.interpolate(prediction, size=(original.height, original.width), mode="bilinear", align_corners=False)
                matte = prediction[0, 0].clamp(0, 1).cpu().numpy()
            output = original.convert("RGBA")
            output.putalpha(Image.fromarray(np.rint(matte * 255).astype(np.uint8), "L"))
            self._error = None
            return output, self._device
        except Exception as error:
            self._error = str(error)
            raise
        finally:
            del inputs

    def release(self, unload: bool = False) -> None:
        """Offload before CorridorKey; keep at most one variant cached in host RAM."""
        if self._model is not None:
            try:
                self._model.to("cpu")
            except Exception:
                unload = True
            self._device = "cpu"
            if unload:
                self._model = None
                self._variant = None
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass


runner = BiRefNetRunner()
