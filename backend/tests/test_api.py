"""HTTP contract tests with deterministic model doubles; no downloads / GPU required."""
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import threading
import time

from fastapi.testclient import TestClient
import numpy as np
from PIL import Image
import pytest

from backend import app as api


class FakeRunner:
    def __init__(self, name, calls):
        self.name = name
        self.calls = calls
        self.loaded = False
        self.entered = None
        self.continue_event = None

    def status(self):
        return {"loaded": self.loaded, "downloaded": True, "error": None}

    def prepare(self, **kwargs):
        self.calls.append((self.name, "prepare", kwargs))
        self.loaded = True
        return self.status()

    def release(self):
        self.calls.append((self.name, "release", {}))

    def infer(self, image, **kwargs):
        self.calls.append((self.name, "infer", kwargs))
        self.loaded = True
        if self.entered:
            self.entered.set()
            assert self.continue_event.wait(3), "test inference was not released"
        output = Image.new("RGBA", image.size, (200, 30, 20, 128))
        return output, "cpu"


@pytest.fixture
def setup(monkeypatch):
    calls = []
    birefnet = FakeRunner("birefnet", calls)
    corridor = FakeRunner("corridorkey", calls)
    monkeypatch.setattr(api, "birefnet", birefnet)
    monkeypatch.setattr(api, "corridor_runner", lambda: corridor)
    monkeypatch.setattr(api, "runtime_info", lambda: {"cuda": False, "gpu": None, "device": "cpu", "vram_total": 0, "vram_free": 0})
    return TestClient(api.app), birefnet, corridor, calls


def png(size=(5, 3), alpha=255):
    buffer = BytesIO()
    Image.new("RGBA", size, (10, 20, 30, alpha)).save(buffer, "PNG")
    return buffer.getvalue()


def post_image(client, **data):
    return client.post("/api/matte", files={"image": ("frame.png", png(alpha=128), "image/png")}, data={"spill": "0", **data})


def test_matte_contract_keeps_dimensions_straight_rgb_and_existing_alpha(setup):
    client, _, _, _ = setup
    response = post_image(client, mode="birefnet", device="cpu", resolution="768", birefnet_variant="lite")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-matte-mode"] == "birefnet"
    assert response.headers["x-matte-device"] == "cpu"
    image = Image.open(BytesIO(response.content))
    assert image.size == (5, 3)
    assert image.mode == "RGBA"
    assert image.getpixel((0, 0)) == (200, 30, 20, 64)


@pytest.mark.parametrize("mode", ["birefnet", "corridorkey", "hybrid"])
def test_all_real_model_modes_have_distinct_dispatch(setup, mode):
    client, _, _, calls = setup
    assert post_image(client, mode=mode).status_code == 200
    inferred = [name for name, action, _ in calls if action == "infer"]
    assert inferred == {"birefnet": ["birefnet"], "corridorkey": ["corridorkey"], "hybrid": ["birefnet", "corridorkey"]}[mode]


def test_hybrid_passes_learned_alpha_and_offloads_birefnet_before_corridor(setup):
    client, _, _, calls = setup
    assert post_image(client, mode="hybrid").status_code == 200
    actions = [(name, action) for name, action, _ in calls]
    assert actions == [("corridorkey", "release"), ("birefnet", "infer"), ("birefnet", "release"), ("corridorkey", "infer")]
    hint = calls[-1][2]["hint"]
    assert hint.shape == (3, 5)
    assert np.allclose(hint, 128 / 255)


@pytest.mark.parametrize("params", [
    {"mode": "chroma"}, {"device": "apple"}, {"resolution": "1313"},
    {"birefnet_variant": "unknown"}, {"key_color": "#0f0"},
    {"spill": "1.1"}, {"spill": "-0.1"},
])
def test_invalid_options_are_rejected_before_inference(setup, params):
    client, _, _, calls = setup
    assert post_image(client, **params).status_code == 422
    assert calls == []


def test_requires_image_field_and_readable_image(setup):
    client, _, _, _ = setup
    assert client.post("/api/matte", files={"file": ("x.png", png())}).status_code == 422
    assert client.post("/api/matte", files={"image": ("bad.png", b"not an image")}).status_code == 415
    assert client.post("/api/matte", files={"image": ("empty.png", b"")}).status_code == 400


def test_enforces_file_bytes_and_image_dimensions(setup, monkeypatch):
    client, _, _, calls = setup
    monkeypatch.setattr(api, "MAX_UPLOAD", 32)
    assert post_image(client).status_code == 413
    monkeypatch.setattr(api, "MAX_UPLOAD", 16 * 1024 * 1024)
    monkeypatch.setattr(api, "MAX_DIMENSION", 2)
    assert post_image(client).status_code == 413
    assert calls == []


def test_prepare_validates_json_and_returns_health(setup):
    client, _, _, calls = setup
    response = client.post("/api/models/prepare", json={"mode": "hybrid", "device": "cpu", "resolution": 512, "birefnet_variant": "hr-matting"})
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["models"]["birefnet"]["loaded"]
    assert [(name, action) for name, action, _ in calls] == [("corridorkey", "release"), ("birefnet", "prepare"), ("birefnet", "release"), ("corridorkey", "prepare")]
    assert calls[1][2] == {"device": "cpu", "resolution": 512, "variant": "hr-matting"}
    assert client.post("/api/models/prepare", json={"resolution": 999}).status_code == 422


def test_health_remains_responsive_while_inference_holds_gpu_lock(setup):
    client, birefnet, _, _ = setup
    birefnet.entered = threading.Event()
    birefnet.continue_event = threading.Event()
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(post_image, client)
        assert birefnet.entered.wait(2)
        try:
            start = time.monotonic()
            response = client.get("/api/health")
            assert time.monotonic() - start < 1
            assert response.status_code == 200
            assert response.json()["busy"] is True
        finally:
            birefnet.continue_event.set()
        assert pending.result().status_code == 200
    assert client.get("/api/health").json()["busy"] is False


def test_oom_is_actionable_and_never_falls_back_to_chroma(setup, monkeypatch):
    client, birefnet, _, calls = setup
    def oom(*args, **kwargs):
        raise RuntimeError("CUDA out of memory")
    monkeypatch.setattr(birefnet, "infer", oom)
    response = post_image(client)
    assert response.status_code == 507
    assert "512 / 768" in response.json()["detail"]
    assert any(action == "release" for _, action, _ in calls)


def test_cors_only_accepts_local_development_frontend(setup):
    client, _, _, _ = setup
    allowed = client.options("/api/matte", headers={"Origin": "http://127.0.0.1:5173", "Access-Control-Request-Method": "POST"})
    assert allowed.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"
    denied = client.options("/api/matte", headers={"Origin": "https://example.com", "Access-Control-Request-Method": "POST"})
    assert denied.status_code == 400
    assert "access-control-allow-origin" not in denied.headers
