from io import BytesIO
import asyncio
import json
from pathlib import Path
import stat
from types import SimpleNamespace
import zipfile

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
import pytest

from backend import projects


def png(color=(80, 100, 120, 255), size=(3, 2)):
    buffer = BytesIO()
    Image.new("RGBA", size, color).save(buffer, "PNG")
    return buffer.getvalue()


def frame(name="起步.png", file="frames/0001.png", selected=True, **extra):
    return {"id": file, "name": name, "sourceIndex": 3, "time": 0.25,
            "width": 3, "height": 2, "selected": selected, "file": file, **extra}


def manifest(**extra):
    return {"format": projects.FORMAT, "name": "人物·跑步", "fps": 12,
            "frames": [frame()], "workspace": {"crop": {"x": 17}, "alpha": True, "future": [1, {"key": "中文"}]}, **extra}


def archive(data=None, assets=None, more=None, compression=zipfile.ZIP_DEFLATED):
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", compression) as zipped:
        zipped.writestr("project.json", json.dumps(data or manifest(), ensure_ascii=False).encode("utf-8"))
        for name, payload in (assets if assets is not None else {"frames/0001.png": png()}).items():
            zipped.writestr(name, payload)
        for name, payload in more or []:
            zipped.writestr(name, payload)
    return buffer.getvalue()


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(projects, "WORKSPACE", tmp_path)
    monkeypatch.setattr(projects, "DEFAULT_DIRECTORY", tmp_path / "FrameAnimProjectList")
    app = FastAPI()
    app.include_router(projects.router)
    return TestClient(app, base_url="http://127.0.0.1:8765"), tmp_path


def save(client, data=None, payload=None, directory=None, **kwargs):
    return client.post("/api/projects", params={"directory": str(directory)} if directory else {},
                       files={"archive": ("project.zip", payload or archive(data), "application/zip")}, **kwargs)


def test_empty_default_does_not_create_directory(setup):
    client, tmp = setup
    response = client.get("/api/projects")
    assert response.status_code == 200
    assert response.json() == {"directory": str(tmp / "FrameAnimProjectList"), "exists": False, "projects": []}
    assert not (tmp / "FrameAnimProjectList").exists()


def test_real_asset_bytes_and_complete_state_round_trip_in_chinese_path(setup):
    client, tmp = setup
    directory = tmp / "动画 工程"
    data = manifest(
        frames=[frame(selected=False), frame("第二帧.png", "frames/0002.png", True)],
        source={"file": "source/原视频.mp4", "name": "原视频.mp4", "type": "video/mp4", "fps": 29.97, "kind": "video", "custom": 7},
        loopCorrection={"enabled": True, "settings": {"strength": 0.7}, "frames": [frame("循环.png", "loop/0001.png")]},
        compression={"settings": {"quality": 88}, "lastSettings": {"quality": 82}, "sourceLabel": "压缩前", "fps": 18,
                     "sources": [frame("压缩原帧", "compression/sources/0001.png")],
                     "results": [frame("压缩结果", "compression/results/0001.png", bytes=91, ratio=0.6)]},
        version=1,
    )
    assets = {
        "frames/0001.png": png(), "frames/0002.png": png((200, 0, 0, 128)),
        "source/原视频.mp4": b"original video bytes, deliberately not decoded",
        "loop/0001.png": png((0, 200, 0, 255)), "compression/sources/0001.png": png(),
        "compression/results/0001.png": png((0, 0, 200, 255)),
    }
    response = save(client, payload=archive(data, assets), directory=directory)
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["path"] == str(directory / f"{saved['id']}.framecraft")
    assert saved["project"]["frameCount"] == 2
    assert saved["project"]["selectedFrameCount"] == 1
    assert saved["project"]["thumbnail"] == "frames/0001.png"
    loaded = client.get(f"/api/projects/{saved['id']}", params={"directory": str(directory)})
    assert loaded.status_code == 200
    actual = loaded.json()
    for key, value in data.items():
        assert actual[key] == value
    assert actual["id"] == saved["id"] and actual["updatedAt"].endswith("Z")
    for path, payload in assets.items():
        asset_response = client.get(f"/api/projects/{saved['id']}/files/{path}", params={"directory": str(directory)})
        assert asset_response.status_code == 200
        assert asset_response.content == payload
        assert (Path(saved["path"]) / path).read_bytes() == payload
    listing = client.get("/api/projects", params={"directory": str(directory)}).json()
    assert listing["projects"] == [saved["project"]]


def test_relative_paths_are_resolved_against_workspace_and_scan_independent_paths(setup):
    client, tmp = setup
    one = save(client, directory="一个相对目录").json()
    two = save(client, directory=tmp / "another").json()
    assert one["directory"] == str(tmp / "一个相对目录")
    assert client.get("/api/projects", params={"directory": "一个相对目录"}).json()["projects"][0]["id"] == one["id"]
    assert client.get("/api/projects", params={"directory": str(tmp / "another")}).json()["projects"][0]["id"] == two["id"]
    assert client.get("/api/projects").json()["projects"] == []


def test_same_name_always_creates_a_new_project_and_never_overwrites(setup):
    client, tmp = setup
    one = save(client).json()
    root = Path(one["path"])
    marker = root / "unrelated-user-note.txt"
    marker.write_text("keep me", encoding="utf8")
    two = save(client).json()
    assert one["id"] != two["id"]
    assert marker.read_text(encoding="utf8") == "keep me"
    listing = client.get("/api/projects").json()["projects"]
    assert {project["id"] for project in listing} == {one["id"], two["id"]}
    # Even files next to the known resources cannot be fetched through this API.
    assert client.get(f"/api/projects/{one['id']}/files/unrelated-user-note.txt").status_code == 404


def test_project_folder_is_portable_and_can_be_discovered_after_move(setup):
    client, tmp = setup
    saved = save(client).json()
    new_directory = tmp / "移动后" / "工程列表"
    new_directory.mkdir(parents=True)
    old_project = Path(saved["path"])
    old_project.rename(new_directory / old_project.name)
    assert client.get("/api/projects").json()["projects"] == []
    params = {"directory": str(new_directory)}
    assert client.get("/api/projects", params=params).json()["projects"][0]["id"] == saved["id"]
    assert client.get(f"/api/projects/{saved['id']}", params=params).json()["name"] == "人物·跑步"
    assert client.get(f"/api/projects/{saved['id']}/files/frames/0001.png", params=params).content == png()


def test_asset_fetch_verifies_only_requested_image_instead_of_all_frames(setup, monkeypatch):
    client, _ = setup
    data = manifest(frames=[frame(), frame("第二帧", "frames/0002.png")])
    saved = save(client, payload=archive(data, {"frames/0001.png": png(), "frames/0002.png": png()})).json()
    verified = []
    original = projects.check_image
    def check(stream, expected):
        verified.append(stream.name)
        return original(stream, expected)
    monkeypatch.setattr(projects, "check_image", check)
    response = client.get(f"/api/projects/{saved['id']}/files/frames/0001.png")
    assert response.status_code == 200 and response.content == png()
    assert len(verified) == 1 and Path(verified[0]).name == "0001.png"
    assert response.headers["content-type"] == "image/png"


def test_source_extension_cannot_cause_html_to_execute_on_workbench_origin(setup):
    client, _ = setup
    source = {"name": "source.html", "type": "text/html", "file": "source/source.html"}
    saved = save(client, payload=archive(manifest(frames=[], source=source), {source["file"]: b"<html>bytes</html>"})).json()
    response = client.get(f"/api/projects/{saved['id']}/files/source/source.html")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["x-content-type-options"] == "nosniff"


@pytest.mark.parametrize("format,mime,extension", [("BMP", "image/bmp", "bmp"), ("AVIF", "image/avif", "avif")])
def test_bmp_and_avif_assets_round_trip_with_their_image_mime(setup, format, mime, extension):
    client, _ = setup
    buffer = BytesIO()
    Image.new("RGB", (3, 2), (50, 100, 150)).save(buffer, format)
    payload = buffer.getvalue()
    source_path = f"source/original.{extension}"
    frame_path = f"frames/0001.{extension}"
    source = {"name": f"原素材.{extension}", "type": mime, "width": 3, "height": 2, "file": source_path}
    data = manifest(frames=[frame(file=frame_path)], source=source)
    response = save(client, payload=archive(data, {source_path: payload, frame_path: payload}))
    assert response.status_code == 200, response.text
    saved = response.json()
    assert client.get("/api/projects").json()["projects"][0]["id"] == saved["id"]
    assert client.get(f"/api/projects/{saved['id']}").json()["source"] == source
    for path in (source_path, frame_path):
        asset = client.get(f"/api/projects/{saved['id']}/files/{path}")
        assert asset.status_code == 200 and asset.content == payload
        assert asset.headers["content-type"] == mime


@pytest.mark.parametrize("orientation", [5, 6, 7, 8])
def test_exif_oriented_jpeg_uses_browser_display_dimensions(setup, orientation):
    client, _ = setup
    buffer = BytesIO()
    exif = Image.Exif()
    exif[274] = orientation
    Image.new("RGB", (3, 2), (50, 100, 150)).save(buffer, "JPEG", exif=exif)
    payload = buffer.getvalue()
    source = {"name": "竖向照片.jpg", "type": "image/jpeg", "width": 2, "height": 3, "file": "source/original.jpg"}
    data = manifest(frames=[frame(file="frames/0001.jpg", width=2, height=3)], source=source)
    response = save(client, payload=archive(data, {source["file"]: payload, "frames/0001.jpg": payload}))
    assert response.status_code == 200, response.text
    saved = response.json()
    assert client.get("/api/projects").json()["projects"][0]["id"] == saved["id"]
    loaded = client.get(f"/api/projects/{saved['id']}")
    assert loaded.status_code == 200 and loaded.json()["source"] == source
    for path in (source["file"], "frames/0001.jpg"):
        asset = client.get(f"/api/projects/{saved['id']}/files/{path}")
        assert asset.status_code == 200 and asset.content == payload
        assert asset.headers["content-type"] == "image/jpeg"


def test_scan_skips_broken_unrelated_and_incomplete_projects(setup):
    client, tmp = setup
    good = save(client).json()
    root = tmp / "FrameAnimProjectList"
    bad_json = root / ("a" * 32 + ".framecraft")
    bad_json.mkdir()
    (bad_json / "project.json").write_text("not json", encoding="utf8")
    wrong_id = root / ("b" * 32 + ".framecraft")
    wrong_id.mkdir()
    (wrong_id / "project.json").write_text(json.dumps(manifest(id="c" * 32, updatedAt="2026-01-01T00:00:00Z")), encoding="utf8")
    (root / "unrelated-project").mkdir()
    (root / ".framecraft-writing-half-saved").mkdir()
    missing_asset = save(client).json()
    (Path(missing_asset["path"]) / "frames/0001.png").unlink()
    broken_image = save(client).json()
    (Path(broken_image["path"]) / "frames/0001.png").write_bytes(b"broken image")
    assert [project["id"] for project in client.get("/api/projects").json()["projects"]] == [good["id"]]


def test_listing_is_ordered_by_saved_time(setup):
    client, _ = setup
    one, two = save(client).json(), save(client).json()
    for project, timestamp in [(one, "2026-10-01T00:00:00Z"), (two, "2026-10-17T00:00:00Z")]:
        file = Path(project["path"]) / "project.json"
        data = json.loads(file.read_text(encoding="utf8"))
        data["updatedAt"] = timestamp
        file.write_text(json.dumps(data), encoding="utf8")
    assert [project["id"] for project in client.get("/api/projects").json()["projects"]] == [two["id"], one["id"]]


def test_source_only_and_compression_only_projects_are_supported(setup):
    client, _ = setup
    source = {"name": "视频.mp4", "type": "video/mp4", "fps": 24, "file": "source/source.mp4"}
    one = save(client, payload=archive(manifest(frames=[], source=source), {source["file"]: b"video bytes"}))
    assert one.status_code == 200 and one.json()["project"]["frameCount"] == 0
    compressed = frame("压缩帧", "compression/results/0001.png", ratio=0.5)
    del compressed["selected"]
    two = save(client, payload=archive(manifest(frames=[], compression={"sources": [], "results": [compressed]}), {compressed["file"]: png()}))
    assert two.status_code == 200 and two.json()["project"]["frameCount"] == 1
    assert two.json()["project"]["thumbnail"] == compressed["file"]
    assert save(client, payload=archive(manifest(frames=[]), {})).status_code == 400


@pytest.mark.parametrize("path", ["../outside.png", "/absolute.png", "C:/drive.png", "frames\\escape.png", "frames/../escape.png", "folder//frame.png", "CON.png", "folder/file.png.", "folder/NUL/test.png"])
def test_zip_paths_are_rejected_without_touching_other_files(setup, path):
    client, tmp = setup
    marker = tmp / "keep.txt"
    marker.write_bytes(b"preserve")
    response = save(client, payload=archive(more=[(path, b"bad")]))
    assert response.status_code == 400
    assert marker.read_bytes() == b"preserve"
    assert not (tmp / "FrameAnimProjectList").exists()


def test_zip_symlink_duplicate_and_case_collisions_are_rejected(setup):
    client, _ = setup
    link = zipfile.ZipInfo("frames/link.png")
    link.create_system = 3
    link.external_attr = (stat.S_IFLNK | 0o777) << 16
    assert save(client, payload=archive(more=[(link, "../../other")])).status_code == 400
    with pytest.warns(UserWarning):
        duplicate = archive(more=[("frames/0001.png", png())])
    assert save(client, payload=duplicate).status_code == 400
    assert save(client, payload=archive(more=[("frames/0001.PNG", png())])).status_code == 400


@pytest.mark.parametrize("change", [
    {"format": "not-a-project"}, {"fps": 0}, {"fps": float("inf")}, {"workspace": []},
    {"frames": [frame(width=0)]}, {"frames": [frame(width=4)]}, {"frames": [frame(time=-1)]},
    {"frames": [frame(selected="yes")]}, {"frames": [frame(sourceIndex=-1)]},
    {"frames": [frame(file="../outside.png")]}, {"frames": [frame(), frame()]},
    {"frames": [frame(file="missing.png")]}, {"frames": [frame()] * 401},
])
def test_invalid_manifest_and_mismatched_assets_are_rejected(setup, change):
    client, tmp = setup
    assert save(client, payload=archive(manifest(**change))).status_code in {400, 413}
    assert not list(tmp.glob("**/*.framecraft"))
    assert not list(tmp.glob("**/.framecraft-writing-*"))


def test_asset_payload_limits_image_validation_and_bomb_detection(setup, monkeypatch):
    client, tmp = setup
    assert save(client, payload=archive(assets={"frames/0001.png": b"not a png"})).status_code == 400
    assert save(client, payload=archive(more=[("unreferenced.txt", b"no")])).status_code == 400
    bomb = manifest(frames=[], source={"name": "source.mp4", "type": "video/mp4", "file": "source/source.mp4"})
    assert save(client, payload=archive(bomb, {"source/source.mp4": b"0" * (2 * 1024 * 1024)})).status_code == 413
    monkeypatch.setattr(projects, "MAX_MEMBER", 4)
    assert save(client).status_code == 413
    assert not list(tmp.glob("**/*.framecraft"))


def test_archive_and_manifest_size_limits(setup, monkeypatch):
    client, _ = setup
    monkeypatch.setattr(projects, "MAX_ARCHIVE", 16)
    assert save(client).status_code == 413
    monkeypatch.setattr(projects, "MAX_ARCHIVE", 512 * 1024 * 1024)
    monkeypatch.setattr(projects, "MAX_MANIFEST", 16)
    assert save(client).status_code == 413


def test_windows_directory_rename_denied_does_not_prevent_save(setup, monkeypatch):
    client, _ = setup
    def blocked_rename(*args, **kwargs):
        raise PermissionError(5, "Access is denied")
    monkeypatch.setattr(Path, "rename", blocked_rename)
    response = save(client)
    assert response.status_code == 200, response.text
    saved = response.json()
    assert client.get(f"/api/projects/{saved['id']}").status_code == 200
    assert not (Path(saved["path"]) / ".incomplete").exists()


def test_smoothing_assets_and_options_round_trip_without_directory_rename(setup, monkeypatch):
    client, _ = setup
    monkeypatch.setattr(Path, "rename", lambda *args, **kwargs: pytest.fail("project saves must not rename directories"))
    smoothed = frame("平滑结果", "smoothing/0001.png")
    smoothing = {"enabled": True, "options": {"targetHeight": 384, "removeBackground": True, "future": ["value"]}, "frames": [smoothed]}
    response = save(client, payload=archive(manifest(frames=[], smoothing=smoothing), {smoothed["file"]: png()}))
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["project"]["frameCount"] == 1 and saved["project"]["thumbnail"] == smoothed["file"]
    assert client.get(f"/api/projects/{saved['id']}").json()["smoothing"] == smoothing
    assert client.get(f"/api/projects/{saved['id']}/files/{smoothed['file']}").content == png()
    assert save(client, payload=archive(manifest(smoothing={"enabled": "bad"}))).status_code == 400


def test_failed_final_manifest_preserves_recoverable_assets_and_existing_projects(setup, monkeypatch):
    client, tmp = setup
    good = save(client).json()
    original = (Path(good["path"]) / "project.json").read_bytes()
    original_open = Path.open
    def fail_manifest(path, mode="r", *args, **kwargs):
        if path.name == "project.json" and mode == "x":
            raise PermissionError(5, "manifest is locked")
        return original_open(path, mode, *args, **kwargs)
    monkeypatch.setattr(Path, "open", fail_manifest)
    failed = save(client)
    assert failed.status_code == 500
    root = tmp / "FrameAnimProjectList"
    incomplete = [path for path in root.iterdir() if path.name != Path(good["path"]).name]
    assert len(incomplete) == 1
    assert (incomplete[0] / ".incomplete").exists()
    assert (incomplete[0] / "frames/0001.png").read_bytes() == png()
    assert "可恢复文件" in failed.json()["detail"]
    assert client.get("/api/projects").json()["projects"][0]["id"] == good["id"]
    assert len(client.get("/api/projects").json()["projects"]) == 1
    assert client.get(f"/api/projects/{incomplete[0].stem}").status_code == 404
    assert (Path(good["path"]) / "project.json").read_bytes() == original


def test_asset_and_project_requests_cannot_escape_or_read_other_paths(setup):
    client, tmp = setup
    saved = save(client).json()
    assert client.get("/api/projects/invalid").status_code == 400
    assert client.get("/api/projects/" + "a" * 32).status_code == 404
    assert client.get(f"/api/projects/{saved['id']}/files/project.json").status_code == 404
    assert client.get(f"/api/projects/{saved['id']}/files/..%2Fproject.json").status_code == 400
    assert client.get(f"/api/projects/{saved['id']}/files/C:%2Foutside.png").status_code == 400
    file = tmp / "not-a-folder"
    file.write_text("keep", encoding="utf8")
    assert client.get("/api/projects", params={"directory": str(file)}).status_code == 400


@pytest.mark.parametrize("path,method", [("/api/projects", "get"), ("/api/projects", "post"), ("/api/projects/browse", "post"), ("/api/projects/" + "a" * 32, "get"), ("/api/projects/" + "a" * 32, "delete")])
def test_foreign_origin_cannot_list_write_open_or_show_picker(setup, monkeypatch, path, method):
    client, tmp = setup
    monkeypatch.setattr(projects, "browse_directory", lambda _: pytest.fail("must not open a picker"))
    options = {"headers": {"Origin": "https://unrelated.example"}}
    if method == "post":
        options.update({"json": {}} if path.endswith("browse") else {"files": {"archive": ("project.zip", archive(), "application/zip")}})
    assert getattr(client, method)(path, **options).status_code == 403
    assert not (tmp / "FrameAnimProjectList").exists()


def test_trusted_local_origin_and_cli_without_origin_are_allowed(setup):
    client, _ = setup
    assert save(client, headers={"Origin": "http://127.0.0.1:8765"}).status_code == 200
    assert save(client, headers={"Origin": "http://localhost:5173"}).status_code == 200
    assert save(client, headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert client.get("/api/projects", headers={"Host": "evil.example"}).status_code == 403


def test_directory_picker_is_an_explicit_subprocess_and_cancel_is_harmless(setup, monkeypatch):
    client, tmp = setup
    calls = []
    def run(args, **options):
        calls.append((args, options))
        return SimpleNamespace(returncode=0, stdout=json.dumps({"directory": str(tmp / "已选目录")}), stderr="")
    monkeypatch.setattr(projects.subprocess, "run", run)
    assert client.get("/api/projects").status_code == 200
    assert calls == []
    response = client.post("/api/projects/browse", json={"directory": "FrameAnimProjectList"})
    assert response.status_code == 200 and response.json()["directory"] == str(tmp / "已选目录")
    command, options = calls[0]
    assert command[1:3] == ["-m", "backend.project_picker"]
    assert command[-1] == str(tmp / "FrameAnimProjectList")
    assert options.get("shell", False) is False and options["cwd"] == str(tmp)
    monkeypatch.setattr(projects.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout='{"directory":null}', stderr=""))
    assert client.post("/api/projects/browse", json={}).json() == {"directory": None}
    assert not list(tmp.iterdir())


def test_directory_picker_failure_reports_manual_path_fallback(setup, monkeypatch):
    client, _ = setup
    monkeypatch.setattr(projects.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=1, stdout="", stderr="tk unavailable"))
    response = client.post("/api/projects/browse", json={})
    assert response.status_code == 503
    assert "手动输入" in response.json()["detail"]


def test_delete_copies_only_the_chosen_project_to_recovery_and_open_assets_keep_working(setup):
    client, tmp = setup
    chosen, other = save(client).json(), save(client).json()
    directory = tmp / "FrameAnimProjectList"
    adjacent = directory / "keep-this-note.txt"
    adjacent.write_bytes(b"unrelated")
    own_note = Path(chosen["path"]) / "user-note.txt"
    own_note.write_bytes(b"recover me too")
    original_manifest = (Path(chosen["path"]) / "project.json").read_bytes()
    response = client.delete(f"/api/projects/{chosen['id']}")
    assert response.status_code == 200, response.text
    assert response.json() == {"id": chosen["id"], "directory": str(directory), "deleted": True}
    assert Path(chosen["path"]).is_dir()
    assert (Path(chosen["path"]) / "project.json").read_bytes() == original_manifest
    recovered = list((directory / ".trash").iterdir())
    assert len(recovered) == 1 and recovered[0].name.startswith(chosen["id"] + "-")
    assert (Path(chosen["path"]) / ".deleted").read_text(encoding="ascii").strip() == recovered[0].name
    assert (recovered[0] / "project.json").read_bytes() == original_manifest
    assert (recovered[0] / "user-note.txt").read_bytes() == b"recover me too"
    assert client.get(f"/api/projects/{chosen['id']}").status_code == 404
    assert [project["id"] for project in client.get("/api/projects").json()["projects"]] == [other["id"]]
    assert client.get(f"/api/projects/{other['id']}").status_code == 200
    assert adjacent.read_bytes() == b"unrelated"
    # Existing browser workspaces may still export or re-save these asset URLs.
    asset = client.get(f"/api/projects/{chosen['id']}/files/frames/0001.png")
    assert asset.status_code == 200 and asset.content == png()
    assert asset.headers["cache-control"] == "no-store"
    actual_path, _ = projects.read_asset(directory, chosen["id"], "frames/0001.png")
    assert actual_path.is_relative_to(recovered[0])
    assert client.get(f"/api/projects/{chosen['id']}/files/user-note.txt").status_code == 404
    assert client.get(f"/api/projects/{chosen['id']}/files/project.json").status_code == 404
    assert client.get(f"/api/projects/{chosen['id']}/files/..%2Fproject.json").status_code == 400
    assert client.delete(f"/api/projects/{chosen['id']}").status_code == 404
    assert len(list((directory / ".trash").iterdir())) == 1


def test_delete_resolves_relative_directory_and_does_not_touch_same_name_in_other_directory(setup):
    client, tmp = setup
    chosen = save(client, directory="动画工程").json()
    other = save(client).json()
    response = client.delete(f"/api/projects/{chosen['id']}", params={"directory": "动画工程"})
    assert response.status_code == 200 and response.json()["directory"] == str(tmp / "动画工程")
    assert client.get("/api/projects", params={"directory": "动画工程"}).json()["projects"] == []
    assert client.get(f"/api/projects/{other['id']}").status_code == 200
    assert client.get(f"/api/projects/{chosen['id']}/files/frames/0001.png", params={"directory": "动画工程"}).content == png()


@pytest.mark.parametrize("project_id,status", [("invalid", 400), ("..%5Coutside", 400), ("A" * 32, 400), ("a" * 32, 404)])
def test_delete_invalid_or_missing_project_never_creates_a_directory(setup, project_id, status):
    client, tmp = setup
    assert client.delete(f"/api/projects/{project_id}").status_code == status
    assert not (tmp / "FrameAnimProjectList").exists()


def test_delete_rejects_non_folder_directory_and_incomplete_write(setup):
    client, tmp = setup
    file = tmp / "not-a-directory"
    file.write_bytes(b"keep")
    assert client.delete("/api/projects/" + "a" * 32, params={"directory": str(file)}).status_code == 400
    assert file.read_bytes() == b"keep"
    saved = save(client).json()
    (Path(saved["path"]) / ".incomplete").write_bytes(b"")
    response = client.delete(f"/api/projects/{saved['id']}")
    assert response.status_code == 409 and "保存完成" in response.json()["detail"]
    assert Path(saved["path"]).is_dir()
    assert not (tmp / "FrameAnimProjectList" / ".trash").exists()


def test_delete_conflicts_with_active_project_reads_or_delete_without_blocking_other_projects(setup):
    client, _ = setup
    saved, other = save(client).json(), save(client).json()
    directory = Path(saved["directory"])
    with projects.project_access(directory, saved["id"]):
        assert client.delete(f"/api/projects/{saved['id']}").status_code == 409
        assert client.get(f"/api/projects/{saved['id']}").status_code == 200
        assert client.get(f"/api/projects/{other['id']}").status_code == 200
    with projects.project_access(directory, saved["id"], deleting=True):
        assert client.delete(f"/api/projects/{saved['id']}").status_code == 409
        assert client.get(f"/api/projects/{saved['id']}/files/frames/0001.png").status_code == 409
        assert client.get(f"/api/projects/{other['id']}").status_code == 200
    assert client.delete(f"/api/projects/{saved['id']}").status_code == 200
    assert projects._PROJECT_ACCESS == {}


@pytest.mark.parametrize("error,status", [(PermissionError(5, "locked by scanner"), 409), (OSError(28, "disk full"), 500)])
def test_delete_copy_failure_preserves_original_project_and_reports_error(setup, monkeypatch, error, status):
    client, _ = setup
    saved = save(client).json()
    original = (Path(saved["path"]) / "project.json").read_bytes()
    attempts = []
    def blocked(path, target, **kwargs):
        attempts.append((path, target))
        raise error
    monkeypatch.setattr(projects.shutil, "copytree", blocked)
    response = client.delete(f"/api/projects/{saved['id']}")
    assert response.status_code == status, response.text
    assert len(attempts) == 1
    assert (Path(saved["path"]) / "project.json").read_bytes() == original
    assert client.get(f"/api/projects/{saved['id']}").status_code == 200
    recovery = list((Path(saved["directory"]) / ".trash").iterdir())
    assert len(recovery) == 1 and (recovery[0] / ".incomplete").exists()
    assert not (Path(saved["path"]) / ".deleted").exists()
    assert projects._PROJECT_ACCESS == {}


def test_windows_directory_rename_denied_does_not_prevent_delete_or_later_asset_exports(setup, monkeypatch):
    client, _ = setup
    saved = save(client).json()
    def blocked_rename(*args, **kwargs):
        raise PermissionError(5, "Access is denied")
    monkeypatch.setattr(Path, "rename", blocked_rename)
    response = client.delete(f"/api/projects/{saved['id']}")
    assert response.status_code == 200, response.text
    assert client.get("/api/projects").json()["projects"] == []
    assert client.get(f"/api/projects/{saved['id']}").status_code == 404
    assert client.get(f"/api/projects/{saved['id']}/files/frames/0001.png").content == png()
    assert (Path(saved["path"]) / ".deleted").is_file()
    assert (Path(saved["path"]) / "frames/0001.png").read_bytes() == png()


@pytest.mark.parametrize("stage", ["write", "commit"])
def test_delete_marker_failure_leaves_original_project_visible_and_recovery_incomplete(setup, monkeypatch, stage):
    client, _ = setup
    saved = save(client).json()
    original_open = Path.open
    original_replace = projects.os.replace
    if stage == "write":
        def denied(path, mode="r", *args, **kwargs):
            if path.name.startswith(".deleted-writing-") and mode == "x":
                raise PermissionError(5, "marker write denied")
            return original_open(path, mode, *args, **kwargs)
        monkeypatch.setattr(Path, "open", denied)
    else:
        def denied(source, destination, *args, **kwargs):
            if Path(destination).name == ".deleted":
                raise PermissionError(5, "marker commit denied")
            return original_replace(source, destination, *args, **kwargs)
        monkeypatch.setattr(projects.os, "replace", denied)
    response = client.delete(f"/api/projects/{saved['id']}")
    assert response.status_code == 409, response.text
    assert client.get(f"/api/projects/{saved['id']}").status_code == 200
    assert client.get(f"/api/projects/{saved['id']}/files/frames/0001.png").content == png()
    assert [project["id"] for project in client.get("/api/projects").json()["projects"]] == [saved["id"]]
    assert not (Path(saved["path"]) / ".deleted").exists()
    assert not list(Path(saved["path"]).glob(".deleted-writing-*"))
    recovery = next((Path(saved["directory"]) / ".trash").iterdir())
    assert (recovery / ".incomplete").exists()
    assert projects._PROJECT_ACCESS == {}


@pytest.mark.parametrize("escaped", ["project", "trash"])
def test_delete_rejects_project_and_recovery_paths_resolving_outside_directory(setup, monkeypatch, escaped):
    client, tmp = setup
    saved = save(client).json()
    root = Path(saved["path"])
    unsafe = root if escaped == "project" else Path(saved["directory"]) / ".trash"
    original_resolve = Path.resolve
    def resolve(path, *args, **kwargs):
        return tmp / "outside" if path == unsafe else original_resolve(path, *args, **kwargs)
    monkeypatch.setattr(Path, "resolve", resolve)
    response = client.delete(f"/api/projects/{saved['id']}")
    assert response.status_code == (404 if escaped == "project" else 400)
    assert root.is_dir() and (root / "frames/0001.png").read_bytes() == png()
    assert not (tmp / "outside").exists()


def test_deleted_assets_validate_recovery_id_and_never_read_a_linked_recovery_directory(setup, monkeypatch):
    client, tmp = setup
    saved = save(client).json()
    assert client.delete(f"/api/projects/{saved['id']}").status_code == 200
    trash = Path(saved["directory"]) / ".trash"
    recovered = next(trash.iterdir())
    original_resolve = Path.resolve
    def resolve(path, *args, **kwargs):
        return tmp / "outside" if path == recovered else original_resolve(path, *args, **kwargs)
    monkeypatch.setattr(Path, "resolve", resolve)
    assert client.get(f"/api/projects/{saved['id']}/files/frames/0001.png").status_code == 404
    monkeypatch.setattr(Path, "resolve", original_resolve)
    manifest_file = recovered / "project.json"
    data = json.loads(manifest_file.read_text(encoding="utf8"))
    data["id"] = "b" * 32
    manifest_file.write_text(json.dumps(data), encoding="utf8")
    assert client.get(f"/api/projects/{saved['id']}/files/frames/0001.png").status_code == 404


def test_asset_response_survives_delete_before_dispatch_and_protects_active_stream(setup):
    client, _ = setup
    saved = save(client).json()
    directory = Path(saved["directory"])
    path, mime = projects.read_asset(directory, saved["id"], "frames/0001.png")
    response = projects.ProjectFileResponse(path, mime, directory, saved["id"], "frames/0001.png")
    # Simulate the gap between endpoint validation and ASGI response dispatch.
    assert client.delete(f"/api/projects/{saved['id']}").status_code == 200
    messages = []
    async def receive():
        return {"type": "http.request", "body": b""}
    async def send(message):
        with pytest.raises(projects.HTTPException) as conflict:
            projects.delete_project(directory, saved["id"])
        assert conflict.value.status_code == 409
        messages.append(message)
    asyncio.run(response({"type": "http", "method": "GET", "headers": [], "extensions": {}, "asgi": {"spec_version": "2.4"}}, receive, send))
    assert messages[0]["status"] == 200
    assert b"".join(message.get("body", b"") for message in messages) == png()
    assert projects._PROJECT_ACCESS == {}
