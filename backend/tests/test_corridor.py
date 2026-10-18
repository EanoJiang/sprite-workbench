"""Adapter contract and color tests; no model download or GPU use."""
import builtins
from types import SimpleNamespace

import numpy as np
from PIL import Image
import pytest

from backend.corridor_runner import (
    CorridorKeyRunner, _coarse_chroma_hint, _normalize_hint, _screen_color,
    processed_to_rgba,
)


def test_linear_premultiplied_is_unpremultiplied_before_srgb_conversion():
    srgb = np.array([0.25, 0.5, 0.75], dtype=np.float32)
    linear = np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)
    processed = np.zeros((1, 2, 4), dtype=np.float32)
    processed[0, 0, :3] = linear * 0.5
    processed[0, 0, 3] = 0.5
    # Arbitrary color in a fully transparent pixel must not bleed into PNG RGB.
    processed[0, 1, :3] = 0.9
    output = np.array(processed_to_rgba(processed))
    np.testing.assert_allclose(output[0, 0], [64, 128, 191, 128], atol=1)
    assert output[0, 1].tolist() == [0, 0, 0, 0]


@pytest.mark.parametrize("invalid", [np.ones((2, 2)), np.ones((2, 2, 3)), np.full((2, 2, 4), np.nan)])
def test_invalid_prediction_is_rejected(invalid):
    with pytest.raises(RuntimeError, match="无效"):
        processed_to_rgba(invalid)


def test_hint_preserves_linear_alpha_and_resizes_to_original_dimensions():
    mask = Image.new("L", (2, 2), 128)
    result = _normalize_hint(mask, (4, 3))
    assert result.shape == (3, 4)
    assert result.dtype == np.float32
    np.testing.assert_allclose(result, 128 / 255)
    boolean = _normalize_hint(np.array([[True, False]]), (2, 1))
    assert boolean.tolist() == [[1.0, 0.0]]


def test_invalid_hint_is_rejected_instead_of_silently_replaced():
    with pytest.raises(ValueError, match="单通道"):
        _normalize_hint(np.ones((2, 2, 3)), (2, 2))
    with pytest.raises(ValueError, match="非有限"):
        _normalize_hint(np.full((2, 2), np.inf), (2, 2))


def test_coarse_guidance_retains_dark_subject_while_excluding_key_color():
    pixels = np.array([[[71, 202, 48], [15, 15, 15]]], dtype=np.uint8)
    hint = _coarse_chroma_hint(pixels, "#47ca30")
    assert hint[0, 0] == 0
    assert hint[0, 1] == 1
    assert _screen_color("#47ca30") == ("green", 1)
    assert _screen_color("#2020ff") == ("blue", 2)
    with pytest.raises(ValueError, match="绿幕 / 蓝幕"):
        _screen_color("#ff2020")


def test_status_never_imports_torch_or_starts_loading(monkeypatch):
    original_import = builtins.__import__

    def blocked_import(name, *args, **kwargs):
        if name == "torch" or name.startswith("CorridorKeyModule"):
            raise AssertionError("Status must not initialize inference dependencies")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", blocked_import)
    status = CorridorKeyRunner().status()
    assert not status["loaded"]
    assert not status["loading"]
    assert len(status["source_revision"]) == 40


def test_inference_passes_linear_birefnet_hint_and_srgb_flags_to_official_engine(monkeypatch):
    runner = CorridorKeyRunner()
    calls = {}

    def process_frame(image, mask, **options):
        calls.update(image=image, mask=mask, options=options)
        output = np.ones((3, 4, 4), dtype=np.float32)
        output[:, :, :3] *= 0.25
        output[:, :, 3] = 0.25
        return {"processed": output}

    runner._engine = SimpleNamespace(process_frame=process_frame)
    runner._device = "cpu"
    monkeypatch.setattr(runner, "_prepare", lambda device, resolution, screen: {})
    result, actual = runner.infer(Image.new("RGB", (4, 3)), device="cpu", resolution=512, hint=np.full((3, 4), 0.5), spill=0.4)
    assert actual == "cpu"
    assert result.size == (4, 3)
    assert np.asarray(result)[0, 0].tolist() == [255, 255, 255, 64]
    assert calls["image"].dtype == np.uint8
    np.testing.assert_allclose(calls["mask"], 0.5)
    assert calls["options"] == {
        "input_is_linear": False, "fg_is_straight": True,
        "despill_strength": 0.4, "auto_despeckle": False,
        "generate_comp": False, "post_process_on_gpu": False, "screen_channel": 1,
    }
