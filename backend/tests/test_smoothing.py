from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
from pathlib import Path
import time
from types import SimpleNamespace
import zipfile

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image, ImageChops
import pytest

from backend import smoothing


def png(size=(8, 6), alpha=128):
    buffer = BytesIO()
    image = Image.new("RGBA", size, (50, 100, 150, alpha))
    image.putpixel((0, 0), (200, 0, 100, 0))
    image.putpixel((1, 0), (0, 200, 100, 255))
    image.save(buffer, "PNG")
    return buffer.getvalue()


def package(extra=None):
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as zipped:
        for name, data in {
            "official/realesrgan-ncnn-vulkan.exe": b"MZ fixture executable",
            f"official/models/{smoothing.MODEL}.param": b"fixture param",
            f"official/models/{smoothing.MODEL}.bin": b"fixture weights",
            "official/LICENSE": b"official license text",
            **(extra or {}),
        }.items():
            zipped.writestr(name, data)
    return buffer.getvalue()


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(smoothing, "RUNTIME", tmp_path / "runtime" / "realesrgan")
    monkeypatch.setattr(smoothing, "BACKEND", tmp_path / "workspace" / "backend")
    monkeypatch.setattr(smoothing, "TEMP_ROOT", tmp_path / "temp")
    monkeypatch.setattr(smoothing, "LAST_ERROR", None)
    monkeypatch.delenv("FRAMECRAFT_ESRGAN_BINARY", raising=False)
    monkeypatch.delenv("FRAMECRAFT_ESRGAN_MODELS", raising=False)
    app = FastAPI()
    app.include_router(smoothing.router)
    return TestClient(app, base_url="http://127.0.0.1:8765"), tmp_path


def ready_runtime():
    binary, models = smoothing.runtime_paths()
    models.mkdir(parents=True, exist_ok=True)
    binary.write_bytes(b"MZ fixture executable")
    (models / f"{smoothing.MODEL}.param").write_bytes(b"fixture param")
    (models / f"{smoothing.MODEL}.bin").write_bytes(b"fixture model")


def post(client, payload=None):
    return client.post("/api/smoothing/frame", files={"image": ("frame.png", payload if payload is not None else png(), "image/png")})


def test_status_is_read_only_and_clear_when_missing(setup):
    client, tmp = setup
    result = client.get("/api/smoothing/status")
    assert result.status_code == 200
    data = result.json()
    assert data["ready"] is False and data["available"] is False
    assert data["model"] == smoothing.MODEL and data["scale"] == 4
    assert data["implementation"] == "ncnn-vulkan"
    assert data["source"] == smoothing.SOURCE_PAGE
    assert "准备" in data["message"]
    assert not list(tmp.iterdir())
    response = post(client)
    assert response.status_code == 503 and "准备" in response.json()["detail"]


def test_prepare_downloads_official_package_keeps_license_and_is_idempotent(setup, monkeypatch):
    client, _ = setup
    calls = []
    def download(path):
        calls.append(path)
        path.write_bytes(package())
        return "fixture-sha256"
    monkeypatch.setattr(smoothing, "download_package", download)
    response = client.post("/api/smoothing/prepare")
    assert response.status_code == 200, response.text
    assert response.json()["ready"] and response.json()["busy"] is False
    assert (smoothing.RUNTIME / "LICENSE").read_bytes() == b"official license text"
    origin = json.loads((smoothing.RUNTIME / "framecraft-runtime.json").read_text(encoding="utf8"))
    assert origin["source"] == smoothing.PACKAGE_URL and origin["sha256"] == "fixture-sha256"
    assert client.post("/api/smoothing/prepare").json()["busy"] is False
    assert len(calls) == 1


def test_prepare_can_copy_existing_reference_runtime_without_future_dependency(setup, monkeypatch):
    client, _ = setup
    source = smoothing.BACKEND.parent.parent / "sprite-video-lab" / "work" / "tools" / "realesrgan-ncnn-vulkan"
    models = source / "models"
    models.mkdir(parents=True)
    (source / "realesrgan-ncnn-vulkan.exe").write_bytes(b"MZ reference executable")
    for suffix in ("param", "bin"):
        (models / f"{smoothing.MODEL}.{suffix}").write_bytes(b"reference model")
    monkeypatch.setattr(smoothing, "download_package", lambda path: pytest.fail("must reuse existing official runtime"))
    assert client.post("/api/smoothing/prepare").json()["ready"]
    (source / "realesrgan-ncnn-vulkan.exe").unlink()
    assert client.get("/api/smoothing/status").json()["ready"]


def test_prepare_failure_has_actionable_error_and_no_fake_ready_state(setup, monkeypatch):
    client, _ = setup
    monkeypatch.setattr(smoothing, "download_package", lambda _: (_ for _ in ()).throw(OSError("network unavailable")))
    response = client.post("/api/smoothing/prepare")
    assert response.status_code == 503 and "准备失败" in response.json()["detail"]
    status = client.get("/api/smoothing/status").json()
    assert status["ready"] is False and "network unavailable" in status["error"]


def test_partially_copied_runtime_is_not_ready_until_installation_completes(setup):
    client, _ = setup
    ready_runtime()
    (smoothing.RUNTIME / ".installing").write_bytes(b"")
    assert client.get("/api/smoothing/status").json()["ready"] is False
    assert post(client).status_code == 503


@pytest.mark.parametrize("entry", ["../escape.exe", "C:/escape.exe", "/absolute.exe", "folder\\escape.exe"])
def test_installer_rejects_unsafe_zip_paths(setup, entry):
    _, tmp = setup
    file = tmp / "unsafe.zip"
    raw_name = zipfile.ZipInfo("placeholder")
    raw_name.filename = entry
    file.write_bytes(package({raw_name: b"bad"}))
    with pytest.raises((HTTPException, RuntimeError)):
        smoothing.extract_package(file, tmp / "unpacked")
    assert not (tmp.parent / "escape.exe").exists()


def test_model_input_preserves_straight_rgb_and_extends_local_foreground_colors():
    source = Image.new("RGBA", (9, 1), (0, 255, 0, 0))
    source.putpixel((1, 0), (240, 20, 10, 1))
    source.putpixel((7, 0), (10, 30, 230, 128))
    before = source.tobytes()
    result = smoothing.rgb_input(source)
    assert result.mode == "RGB" and result.size == source.size
    # Partial alpha must not blend either seed with an average background.
    assert result.getpixel((1, 0)) == (240, 20, 10)
    assert result.getpixel((7, 0)) == (10, 30, 230)
    assert result.getpixel((0, 0)) == result.getpixel((3, 0)) == (240, 20, 10)
    assert result.getpixel((5, 0)) == result.getpixel((8, 0)) == (10, 30, 230)
    assert source.tobytes() == before


@pytest.mark.parametrize("alpha", [1, 128, 255])
def test_model_input_with_no_clear_pixels_keeps_every_rgb_value(alpha):
    source = Image.new("RGBA", (3, 2), (20, 90, 220, alpha))
    source.putpixel((2, 1), (250, 15, 60, alpha))
    assert smoothing.rgb_input(source).tobytes() == source.convert("RGB").tobytes()


@pytest.mark.parametrize("size", [(1, 1), (1, 5), (5, 1), (3, 3)])
def test_model_input_handles_fully_clear_frames_and_single_visible_seed(size):
    source = Image.new("RGBA", size, (200, 80, 50, 0))
    assert smoothing.rgb_input(source).tobytes() == Image.new("RGB", size).tobytes()
    source.putpixel((0, 0), (10, 40, 230, 128))
    assert smoothing.rgb_input(source).tobytes() == Image.new("RGB", size, (10, 40, 230)).tobytes()


def test_identity_model_does_not_bake_background_into_half_alpha_pixels(setup, monkeypatch):
    client, _ = setup
    ready_runtime()
    source = Image.new("RGBA", (32, 12), (0, 0, 240, 128))
    source.paste((240, 0, 0, 255), (0, 0, 4, 12))
    source.paste((0, 255, 0, 0), (30, 0, 32, 12))
    buffer = BytesIO()
    source.save(buffer, "PNG")
    calls = []

    def identity(input_path, output_path):
        with Image.open(input_path) as prepared:
            calls.append(prepared.getpixel((20, 6)))
            assert prepared.getpixel((31, 6)) == (0, 0, 240)
            prepared.resize((prepared.width * 4, prepared.height * 4), Image.Resampling.NEAREST).save(output_path)

    monkeypatch.setattr(smoothing, "run_model", identity)
    response = post(client, buffer.getvalue())
    assert response.status_code == 200, response.text
    assert calls == [(0, 0, 240)]
    with Image.open(BytesIO(response.content)) as result:
        assert result.size == source.size
        assert result.getpixel((20, 6)) == (0, 0, 240, 128)
        assert ImageChops.difference(result.getchannel("A"), source.getchannel("A")).getbbox() is None


def test_frame_runs_ncnn_x4_then_returns_exact_source_size_and_alpha(setup, monkeypatch):
    client, _ = setup
    ready_runtime()
    calls = []
    def run(command, **options):
        calls.append((command, options))
        assert smoothing.VULKAN_LOCK.locked()
        assert smoothing.status()["busy"]
        input_file = Path(command[command.index("-i") + 1])
        output_file = Path(command[command.index("-o") + 1])
        with Image.open(input_file) as input_image:
            assert input_image.mode == "RGB"
            Image.new("RGB", (input_image.width * 4, input_image.height * 4), (90, 120, 150)).save(output_file, "PNG")
        return SimpleNamespace(returncode=0, stderr=b"", stdout=b"")
    monkeypatch.setattr(smoothing.subprocess, "run", run)
    original = png()
    response = post(client, original)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-smoothing-model"] == smoothing.MODEL
    assert response.headers["x-smoothing-scale"] == "4"
    with Image.open(BytesIO(original)) as source, Image.open(BytesIO(response.content)) as result:
        assert result.size == source.size
        assert ImageChops.difference(result.getchannel("A"), source.getchannel("A")).getbbox() is None
        assert result.getpixel((3, 3)) == (90, 120, 150, 128)
    command, options = calls[0]
    assert command[command.index("-s") + 1] == "4"
    assert command[command.index("-n") + 1] == "realesrgan-x4plus-anime"
    assert command[command.index("-j") + 1] == "1:1:1"
    assert options.get("shell", False) is False
    assert not list(smoothing.TEMP_ROOT.iterdir())


def test_vulkan_model_invocations_are_serialized(setup, monkeypatch):
    client, _ = setup
    ready_runtime()
    active = 0
    maximum = 0
    def run(input_path, output_path):
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        time.sleep(0.04)
        with Image.open(input_path) as source:
            source.resize((source.width * 4, source.height * 4)).save(output_path)
        active -= 1
    monkeypatch.setattr(smoothing, "run_model", run)
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(lambda _: post(client), range(2)))
    assert [response.status_code for response in responses] == [200, 200]
    assert maximum == 1 and not smoothing.VULKAN_LOCK.locked()


def test_wrong_model_output_size_is_rejected_and_lock_released(setup, monkeypatch):
    client, _ = setup
    ready_runtime()
    monkeypatch.setattr(smoothing, "run_model", lambda input_path, output_path: Image.new("RGB", (1, 1)).save(output_path))
    response = post(client)
    assert response.status_code == 503 and "错误尺寸" in response.json()["detail"]
    assert not smoothing.VULKAN_LOCK.locked()
    assert not list(smoothing.TEMP_ROOT.iterdir())


@pytest.mark.parametrize("message,status", [(b"VK_ERROR_OUT_OF_DEVICE_MEMORY", 507), (b"cannot find Vulkan device", 503)])
def test_vulkan_errors_are_actionable_without_silent_filter_fallback(setup, monkeypatch, message, status):
    client, _ = setup
    ready_runtime()
    monkeypatch.setattr(smoothing.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=1, stdout=b"", stderr=message))
    response = post(client)
    assert response.status_code == status
    assert "Real-ESRGAN" in response.json()["detail"]
    assert not smoothing.VULKAN_LOCK.locked()


def test_invalid_empty_and_oversized_images_are_rejected_before_model(setup, monkeypatch):
    client, _ = setup
    monkeypatch.setattr(smoothing, "run_model", lambda *args: pytest.fail("must not invoke model"))
    assert post(client, b"not an image").status_code == 415
    assert post(client, b"").status_code == 400
    monkeypatch.setattr(smoothing, "MAX_UPLOAD", 4)
    assert post(client).status_code == 413
    monkeypatch.setattr(smoothing, "MAX_UPLOAD", 24 * 1024 * 1024)
    monkeypatch.setattr(smoothing, "MAX_INPUT_PIXELS", 10)
    assert post(client).status_code == 413


@pytest.mark.parametrize("path,method", [("/status", "get"), ("/prepare", "post"), ("/frame", "post")])
def test_foreign_pages_cannot_download_or_run_local_components(setup, monkeypatch, path, method):
    client, _ = setup
    monkeypatch.setattr(smoothing, "prepare", lambda: pytest.fail("must not install"))
    options = {"headers": {"Origin": "https://unrelated.example"}}
    if path == "/frame":
        options["files"] = {"image": ("frame.png", png(), "image/png")}
    assert getattr(client, method)("/api/smoothing" + path, **options).status_code == 403
