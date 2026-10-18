from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import threading
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient
import numpy as np
from PIL import Image
import pytest

from backend import compression


def png(image=None):
    buffer = BytesIO()
    (image or Image.new("RGBA", (9, 7), (220, 30, 20, 255))).save(buffer, "PNG")
    return buffer.getvalue()


def decode(payload):
    return Image.open(BytesIO(payload))


def rgba_pixels(image):
    return [tuple(pixel) for pixel in np.array(image.convert("RGBA")).reshape(-1, 4)]


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(compression.router)
    @app.get("/ping")
    async def ping():
        return {"ok": True}
    return TestClient(app)


def post(client, payload=None, **options):
    return client.post("/api/compression/frame", files={"image": ("frame.png", payload if payload is not None else png(), "image/png")}, data=options)


@pytest.mark.parametrize("algorithm", ["lanczos", "palette", "nearest"])
def test_actual_png_dimensions_headers_and_byte_counts(client, algorithm):
    original = png()
    response = post(client, original, scale="0.5", algorithm=algorithm)
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-compression-width"] == "5"
    assert response.headers["x-compression-height"] == "4"
    assert response.headers["x-compression-algorithm"] == algorithm
    assert int(response.headers["x-compression-original-bytes"]) == len(original)
    assert int(response.headers["x-compression-output-bytes"]) == len(response.content)
    assert decode(response.content).size == (5, 4)  # Half-up rounding: 4.5 -> 5.


def test_scale_never_returns_zero_dimensions():
    data, width, height = compression.compress_image(Image.new("RGBA", (1, 2)), scale=0.05)
    assert (width, height) == (1, 1)
    assert decode(data).size == (1, 1)


@pytest.mark.parametrize("algorithm", ["lanczos", "palette", "nearest"])
def test_black_body_red_blade_partial_alpha_and_zero_hidden_rgb(algorithm):
    image = Image.new("RGBA", (4, 1))
    image.putdata([(50, 200, 70, 0), (0, 0, 0, 255), (255, 0, 0, 255), (190, 80, 30, 128)])
    data, _, _ = compression.compress_image(image, scale=1, algorithm=algorithm, alpha_threshold=0, sharpen=200, colors=16)
    output = rgba_pixels(decode(data))
    assert output == [(0, 0, 0, 0), (0, 0, 0, 255), (255, 0, 0, 255), (190, 80, 30, 128)]


def test_premultiplied_lanczos_does_not_blend_hidden_green_into_red_edges():
    pixels = np.zeros((8, 100, 4), dtype=np.uint8)
    pixels[:, :50] = (255, 0, 0, 255)
    pixels[:, 50:] = (0, 255, 0, 0)
    data, _, _ = compression.compress_image(Image.fromarray(pixels), scale=0.5, algorithm="lanczos", alpha_threshold=0, sharpen=0)
    result = np.array(decode(data).convert("RGBA"))
    visible = result[:, :, 3] > 0
    assert np.any((result[:, :, 3] > 0) & (result[:, :, 3] < 255)), "must exercise a soft resampled edge"
    assert np.all(result[:, :, 0][visible] == 255)
    assert np.all(result[:, :, 1][visible] == 0)
    assert np.all(result[:, :, 2][visible] == 0)
    assert np.all(result[result[:, :, 3] == 0] == 0)


def test_alpha_threshold_cleans_faint_alpha_before_and_after_resampling():
    image = Image.new("RGBA", (4, 1))
    image.putdata([(80, 120, 90, 0), (50, 220, 90, 8), (255, 0, 0, 9), (0, 0, 0, 255)])
    data, _, _ = compression.compress_image(image, scale=1, alpha_threshold=8, sharpen=0)
    assert rgba_pixels(decode(data)) == [(0, 0, 0, 0), (0, 0, 0, 0), (255, 0, 0, 9), (0, 0, 0, 255)]


def test_sharpening_preserves_alpha_and_leaves_soft_edge_rgb_unchanged():
    pixels = np.zeros((12, 12, 4), dtype=np.uint8)
    pixels[:, :] = (30, 60, 90, 128)
    pixels[3:9, 3:9] = (90, 110, 130, 255)
    pixels[5:7, 5:7] = (180, 190, 200, 255)
    image = Image.fromarray(pixels)
    softened, _, _ = compression.compress_image(image, scale=1, alpha_threshold=0, sharpen=0)
    sharpened, _, _ = compression.compress_image(image, scale=1, alpha_threshold=0, sharpen=200)
    before = np.array(decode(softened))
    after = np.array(decode(sharpened))
    assert np.array_equal(before[:, :, 3], after[:, :, 3])
    assert np.array_equal(before[before[:, :, 3] < 255], after[before[:, :, 3] < 255])
    assert not np.array_equal(before[:, :, :3], after[:, :, :3]), "sharpening should actually affect opaque detail"


def test_palette_is_real_indexed_png_with_transparency_and_color_limit():
    random = np.random.default_rng(23)
    pixels = random.integers(0, 256, size=(32, 32, 4), dtype=np.uint8)
    pixels[:8] = (0, 255, 0, 0)
    pixels[8:16] = (0, 0, 0, 255)
    pixels[16:24] = (255, 0, 0, 255)
    data, _, _ = compression.compress_image(Image.fromarray(pixels), scale=1, algorithm="palette", alpha_threshold=8, sharpen=0, colors=16)
    indexed = decode(data)
    assert indexed.mode == "P"
    assert len(indexed.getcolors(256)) <= 16
    assert b"tRNS" in data
    rgba = np.array(indexed.convert("RGBA"))
    assert np.all(rgba[:8] == 0)
    assert np.all(rgba[8:16, :, :3] == 0)
    assert np.all(rgba[8:16, :, 3] >= 250)  # Lossy RGBA palette averages can round opaque alpha by a few levels.
    assert np.all(rgba[16:24] == (255, 0, 0, 255))
    assert np.any((rgba[:, :, 3] > 0) & (rgba[:, :, 3] < 255))


def test_nearest_keeps_exact_source_pixel_values():
    image = Image.new("RGBA", (4, 2))
    image.putdata([(12, 80, 45, 128), (20, 30, 40, 255), (255, 0, 0, 255), (0, 0, 0, 255)] * 2)
    data, _, _ = compression.compress_image(image, scale=0.5, algorithm="nearest", alpha_threshold=0, sharpen=0)
    expected = image.resize((2, 1), Image.Resampling.NEAREST)
    assert rgba_pixels(decode(data)) == rgba_pixels(expected)


@pytest.mark.parametrize("algorithm", ["lanczos", "palette", "nearest"])
def test_resize_mode_is_independent_of_png_encoding_and_overrides_legacy_algorithm(client, algorithm):
    pixels = np.zeros((16, 16, 4), dtype=np.uint8)
    pixels[:, :8] = (255, 0, 0, 255)
    pixels[:, 8:] = (0, 255, 0, 0)
    image = Image.fromarray(pixels)
    hard = post(client, png(image), scale="0.5", algorithm=algorithm, resize_mode="hard", alpha_threshold="0", sharpen="0", colors="256")
    soft = post(client, png(image), scale="0.5", algorithm=algorithm, resize_mode="soft", alpha_threshold="0", sharpen="0", colors="256")
    assert hard.status_code == soft.status_code == 200
    assert hard.headers["x-compression-resize-mode"] == "hard"
    assert soft.headers["x-compression-resize-mode"] == "soft"
    hard_pixels = np.array(decode(hard.content).convert("RGBA"))
    soft_pixels = np.array(decode(soft.content).convert("RGBA"))
    assert set(np.unique(hard_pixels[:, :, 3])) == {0, 255}
    assert np.any((soft_pixels[:, :, 3] > 0) & (soft_pixels[:, :, 3] < 255))
    assert not np.array_equal(hard_pixels, soft_pixels)
    if algorithm == "palette":
        assert decode(hard.content).mode == decode(soft.content).mode == "P"


def test_invalid_resize_mode_is_rejected(client):
    assert post(client, resize_mode="fake").status_code == 422


@pytest.mark.parametrize("colors", [2, 4, 16, 128, 256])
def test_palette_reserves_even_one_transparent_pixel_under_small_color_budgets(colors):
    pixels = np.random.default_rng(44).integers(0, 256, size=(64, 64, 4), dtype=np.uint8)
    pixels[:, :, 3] = 255
    pixels[0, 0] = (90, 255, 30, 0)
    data, _, _ = compression.compress_image(Image.fromarray(pixels), scale=1, algorithm="palette", alpha_threshold=0, sharpen=0, colors=colors)
    indexed = decode(data)
    assert indexed.mode == "P"
    assert len(indexed.getcolors(256)) <= colors
    assert b"tRNS" in data
    result = np.array(indexed.convert("RGBA"))
    assert tuple(result[0, 0]) == (0, 0, 0, 0)
    assert np.all(result[1:, :, 3] == 255)
    assert np.count_nonzero(result[:, :, 3] == 0) == 1


def test_palette_all_transparent_image_uses_a_valid_clear_palette():
    source = Image.new("RGBA", (5, 3), (120, 210, 50, 0))
    data, _, _ = compression.compress_image(source, scale=1, algorithm="palette", alpha_threshold=0, sharpen=0, colors=2)
    indexed = decode(data)
    assert indexed.mode == "P" and len(indexed.getcolors(256)) == 1
    assert np.all(np.array(indexed.convert("RGBA")) == 0)


@pytest.mark.parametrize("options", [
    {"scale": "0.01"}, {"scale": "1.1"}, {"scale": "nan"}, {"algorithm": "fake-ai"},
    {"alpha_threshold": "65"}, {"alpha_threshold": "-1"}, {"sharpen": "201"}, {"colors": "1"}, {"colors": "257"},
])
def test_invalid_parameters_are_rejected(client, options):
    assert post(client, **options).status_code == 422


def test_invalid_files_and_upload_dimension_pixel_limits(client, monkeypatch):
    assert post(client, b"").status_code == 400
    assert post(client, b"invalid png").status_code == 415
    assert client.post("/api/compression/frame").status_code == 422
    monkeypatch.setattr(compression, "MAX_UPLOAD", 10)
    assert post(client).status_code == 413
    monkeypatch.setattr(compression, "MAX_UPLOAD", 16 * 1024 * 1024)
    monkeypatch.setattr(compression, "MAX_DIMENSION", 4)
    assert post(client).status_code == 413
    monkeypatch.setattr(compression, "MAX_DIMENSION", 8192)
    monkeypatch.setattr(compression, "MAX_PIXELS", 20)
    assert post(client).status_code == 413


def test_cpu_processing_runs_in_threadpool_so_other_endpoints_remain_responsive(client, monkeypatch):
    entered = threading.Event()
    proceed = threading.Event()
    real = compression.process_payload
    def slow(*args):
        entered.set()
        assert proceed.wait(3)
        return real(*args)
    monkeypatch.setattr(compression, "process_payload", slow)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(post, client)
        assert entered.wait(2)
        try:
            started = time.monotonic()
            response = client.get("/ping")
            assert response.status_code == 200
            assert time.monotonic() - started < 1
        finally:
            proceed.set()
        assert pending.result().status_code == 200
