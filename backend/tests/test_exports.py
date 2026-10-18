from fractions import Fraction
from io import BytesIO
import json
from pathlib import Path
import shutil
import stat
import subprocess
from urllib.parse import quote
import zipfile

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image
import pytest

from backend import exports


def png(size=(5, 4), color=(80, 100, 120, 128)):
    image = Image.new("RGBA", size, color)
    image.putpixel((0, 0), (170, 40, 70, 0))
    buffer = BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def manifest(fps=12, frames=None, **extra):
    return {"format": "framecraft-mov-v1", "name": "角色·跑步", "fps": fps,
            "frames": frames if frames is not None else [{"filename": "frame_001.png", "width": 5, "height": 4}], **extra}


def archive(data=None, assets=None, extra=None):
    result = BytesIO()
    with zipfile.ZipFile(result, "w", zipfile.ZIP_DEFLATED) as zipped:
        zipped.writestr("manifest.json", json.dumps(data or manifest(), ensure_ascii=False))
        for name, payload in (assets if assets is not None else {"frame_001.png": png()}).items():
            zipped.writestr(name, payload)
        for name, payload in extra or []:
            zipped.writestr(name, payload)
    return result.getvalue()


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(exports, "TEMP_ROOT", tmp_path / "mov-temp")
    monkeypatch.delenv("FRAMECRAFT_FFMPEG", raising=False)
    monkeypatch.delenv("FRAMECRAFT_FFPROBE", raising=False)
    app = FastAPI()
    app.include_router(exports.router)
    return TestClient(app, base_url="http://127.0.0.1:8765"), tmp_path


def post(client, payload=None, **options):
    return client.post("/api/exports/mov", files={"archive": ("frames.zip", payload if payload is not None else archive(), "application/zip")}, **options)


@pytest.fixture
def fake_encoder(setup, monkeypatch):
    calls = []
    def encode(ffmpeg, ffprobe, root, output, fps, count, width, height):
        assert exports.EXPORT_LOCK.locked()
        images = []
        for index in range(1, count + 1):
            with Image.open(root / f"frame_{index:03d}.png") as image:
                images.append(image.copy())
        calls.append({"fps": fps, "count": count, "width": width, "height": height, "images": images})
        output.write_bytes(b"verified mock MOV bytes")
    monkeypatch.setattr(exports, "resolve_tool", lambda name: f"{name}.exe")
    monkeypatch.setattr(exports, "run_encoder", encode)
    return calls


def test_mov_response_keeps_name_fps_and_cleans_all_temporary_files(setup, fake_encoder):
    client, _ = setup
    response = post(client, archive(manifest(fps=59.94)))
    assert response.status_code == 200, response.text
    assert response.content == b"verified mock MOV bytes"
    assert response.headers["content-type"] == "video/quicktime"
    assert quote("角色·跑步.mov", safe="") in response.headers["content-disposition"]
    assert response.headers["x-export-frame-count"] == "1"
    assert response.headers["x-export-width"] == "5" and response.headers["x-export-height"] == "4"
    assert response.headers["x-export-fps"] == "59.94"
    assert fake_encoder[0]["fps"] == Fraction(2997, 50)
    assert not list(exports.TEMP_ROOT.iterdir())


def test_varying_sizes_use_bottom_center_and_explicit_center_anchor_without_alpha_squaring(setup, fake_encoder):
    client, _ = setup
    records = [{"filename": "frame_001.png", "width": 5, "height": 4},
               {"filename": "frame_002.png", "width": 3, "height": 2},
               {"filename": "frame_003.png", "width": 1, "height": 1, "anchor": "center"}]
    assets = {"frame_003.png": png((1, 1)), "frame_002.png": png((3, 2)), "frame_001.png": png()}
    response = post(client, archive(manifest(frames=records), assets))
    assert response.status_code == 200, response.text
    frames = fake_encoder[0]["images"]
    assert all(frame.size == (5, 4) for frame in frames)
    assert frames[1].getpixel((1, 2)) == (170, 40, 70, 0)
    assert frames[1].getpixel((2, 2)) == (80, 100, 120, 128)
    assert frames[1].getpixel((0, 3)) == (0, 0, 0, 0)
    assert frames[2].getpixel((2, 1)) == (170, 40, 70, 0)
    assert frames[2].getpixel((2, 3)) == (0, 0, 0, 0)


@pytest.mark.parametrize("changes", [{"format": "other"}, {"name": ""}, {"fps": 0}, {"fps": 121}, {"fps": True}, {"fps": float("inf")}, {"fps": 10**1000},
                                     {"frames": []}, {"frames": [{"filename": "frame_002.png", "width": 5, "height": 4}]},
                                     {"frames": [{"filename": "frame_001.png", "width": True, "height": 4}]},
                                     {"frames": [{"filename": "frame_001.png", "width": 5, "height": 4, "anchor": "top"}]},
                                     {"frames": [{"filename": "frame_001.png", "width": 5, "height": 4, "anchor": []}]}])
def test_invalid_manifest_is_rejected_before_encoding(setup, fake_encoder, changes):
    client, _ = setup
    response = post(client, archive(manifest(**changes)))
    assert response.status_code == 400
    assert fake_encoder == []


@pytest.mark.parametrize("path", ["../outside.png", "/absolute.png", "C:/outside.png", "folder/frame.png", "CON.png"])
def test_zip_paths_cannot_escape_or_create_unrelated_files(setup, path):
    client, tmp = setup
    response = post(client, archive(extra=[(path, b"bad")]))
    assert response.status_code == 400
    assert not list(tmp.iterdir())


def test_duplicate_symlink_missing_extra_and_non_png_files_are_rejected(setup, fake_encoder):
    client, _ = setup
    with pytest.warns(UserWarning):
        duplicate = archive(extra=[("frame_001.png", png())])
    assert post(client, duplicate).status_code == 400
    link = zipfile.ZipInfo("link.png")
    link.create_system = 3
    link.external_attr = (stat.S_IFLNK | 0o777) << 16
    assert post(client, archive(extra=[(link, "../outside")])).status_code == 400
    assert post(client, archive(assets={})).status_code == 400
    assert post(client, archive(extra=[("unexpected.txt", b"bad")])).status_code == 400
    assert post(client, archive(assets={"frame_001.png": b"not a PNG"})).status_code == 400
    assert post(client, archive(assets={"frame_001.png": png((6, 4))})).status_code == 400
    assert post(client, b"not ZIP").status_code == 400
    assert not exports.TEMP_ROOT.exists() or not list(exports.TEMP_ROOT.iterdir())
    assert fake_encoder == []


def test_archive_member_and_total_canvas_limits_are_enforced(setup, fake_encoder, monkeypatch):
    client, _ = setup
    monkeypatch.setattr(exports, "MAX_ARCHIVE", 4)
    assert post(client).status_code == 413
    monkeypatch.setattr(exports, "MAX_ARCHIVE", 256 * 1024 * 1024)
    monkeypatch.setattr(exports, "MAX_MEMBER", 4)
    assert post(client).status_code == 413
    monkeypatch.setattr(exports, "MAX_MEMBER", 64 * 1024 * 1024)
    monkeypatch.setattr(exports, "MAX_SEQUENCE_PIXELS", 19)
    assert post(client).status_code == 413
    assert fake_encoder == []


def test_encoder_failure_cleans_temporary_files_and_releases_lock(setup, fake_encoder, monkeypatch):
    client, _ = setup
    def fail(*args):
        raise HTTPException(503, "encoder failed")
    monkeypatch.setattr(exports, "run_encoder", fail)
    assert post(client).status_code == 503
    assert not exports.EXPORT_LOCK.locked()
    assert not list(exports.TEMP_ROOT.iterdir())


def test_foreign_origin_cannot_invoke_local_encoder(setup, fake_encoder):
    client, tmp = setup
    assert post(client, headers={"Origin": "https://unrelated.example"}).status_code == 403
    assert fake_encoder == [] and not list(tmp.iterdir())


def test_missing_ffmpeg_is_clear_and_no_temp_files_are_created(setup, monkeypatch):
    client, tmp = setup
    monkeypatch.setattr(exports.shutil, "which", lambda name: None)
    response = post(client)
    assert response.status_code == 503
    assert "FFmpeg" in response.json()["detail"] and "PATH" in response.json()["detail"]
    assert not list(tmp.iterdir())


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="local FFmpeg/ffprobe are needed for real transparent MOV verification")
@pytest.mark.parametrize("fps", [12, 59.94])
def test_real_qtrle_movie_preserves_every_rgba_pixel_order_fps_and_anchor(setup, fps):
    client, tmp = setup
    records = [{"filename": "frame_001.png", "width": 5, "height": 4},
               {"filename": "frame_002.png", "width": 3, "height": 2},
               {"filename": "frame_003.png", "width": 1, "height": 1, "anchor": "center"}]
    assets = {"frame_003.png": png((1, 1), (30, 200, 10, 255)),
              "frame_002.png": png((3, 2), (20, 30, 220, 128)), "frame_001.png": png()}
    response = post(client, archive(manifest(fps=fps, frames=records), assets))
    assert response.status_code == 200, response.text
    output = tmp / "actual-transparent.mov"
    output.write_bytes(response.content)
    probe = subprocess.run([exports.resolve_tool("ffprobe"), "-v", "error", "-select_streams", "v:0", "-show_entries",
                            "stream=codec_name,pix_fmt,width,height,avg_frame_rate,nb_frames", "-of", "json", str(output)],
                           capture_output=True, check=True)
    stream = json.loads(probe.stdout)["streams"][0]
    assert stream["codec_name"] == "qtrle" and stream["pix_fmt"] == "argb"
    assert stream["nb_frames"] == "3" and Fraction(stream["avg_frame_rate"]) == Fraction(str(fps))
    decoded = subprocess.run([exports.resolve_tool("ffmpeg"), "-v", "error", "-i", str(output), "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
                             capture_output=True, check=True).stdout
    expected = bytearray()
    for record in records:
        canvas = Image.new("RGBA", (5, 4), (0, 0, 0, 0))
        with Image.open(BytesIO(assets[record["filename"]])) as image:
            x = (5 - image.width) // 2
            y = (4 - image.height) // 2 if record.get("anchor") == "center" else 4 - image.height
            canvas.paste(image, (x, y))
        expected.extend(canvas.tobytes())
    assert decoded == bytes(expected)
    assert not list(exports.TEMP_ROOT.iterdir())
