from io import BytesIO
import json
from pathlib import Path
import stat
import subprocess
from types import SimpleNamespace
import zipfile

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image
import pytest

from backend import tuner


def png(color=(80, 100, 120, 255), size=(3, 2)):
    buffer = BytesIO()
    Image.new("RGBA", size, color).save(buffer, "PNG")
    return buffer.getvalue()


def archive(entries=None):
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zipped:
        for name, data in entries or [("frame_001.png", png())]:
            zipped.writestr(name, data)
    return buffer.getvalue()


@pytest.fixture
def setup(tmp_path, monkeypatch):
    vendor = tmp_path / "vendor"
    (vendor / "tools/frame_tuner_lite").mkdir(parents=True)
    for name in ("server.js", "import_frames.js"):
        (vendor / "tools/frame_tuner_lite" / name).write_text("// fixture", encoding="utf8")
    (vendor / "package.json").write_text('{"version":"0.3.0"}', encoding="utf8")
    manager = tuner.TunerManager(vendor, 5188)
    monkeypatch.setattr(tuner, "manager", manager)
    monkeypatch.setattr(tuner, "IMPORT_DIR", tmp_path / "imports")
    monkeypatch.setattr(tuner, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(tuner, "TEMP_DIR", tmp_path / "temp")
    monkeypatch.setattr(tuner, "node_binary", lambda: "/path/to/node")
    monkeypatch.setattr(tuner, "apply_compat_patch", lambda root: {"changed": False})
    app = FastAPI()
    app.include_router(tuner.router)
    return TestClient(app), manager


def test_status_requires_exact_upstream_root_and_lite_kind(setup, monkeypatch):
    _, manager = setup
    monkeypatch.setattr(manager, "_json", lambda path: {"projects": []} if path == "/api/projects" else {"projectKind": "frame_lite", "root": str(manager.root)})
    status = manager.status()
    assert status["installed"] and status["running"]
    assert status["version"] == "0.3.0"
    assert status["source_revision"] == tuner.SOURCE_REVISION
    monkeypatch.setattr(manager, "_json", lambda path: {"projects": [], "projectKind": "frame_lite", "root": str(manager.root.parent / "unrelated")})
    monkeypatch.setattr(tuner.socket, "create_connection", lambda *args, **kwargs: (_ for _ in ()).throw(OSError()))
    assert manager.probe() == (False, False)


def test_refuses_occupied_unrelated_port_without_spawning_or_killing(setup, monkeypatch):
    client, manager = setup
    monkeypatch.setattr(manager, "probe", lambda: (False, True))
    monkeypatch.setattr(tuner.subprocess, "Popen", lambda *args, **kwargs: pytest.fail("must not spawn"))
    response = client.post("/api/tuner/start")
    assert response.status_code == 409
    assert "端口 5188" in response.json()["detail"]


def test_lazy_start_is_idempotent_and_child_uses_project_temp_paths(setup, monkeypatch):
    client, manager = setup
    calls = []
    process = SimpleNamespace(poll=lambda: None, returncode=None)
    monkeypatch.setattr(manager, "probe", lambda: (bool(calls), bool(calls)))
    def popen(args, **kwargs):
        calls.append((args, kwargs))
        return process
    monkeypatch.setattr(tuner.subprocess, "Popen", popen)
    assert client.post("/api/tuner/start").json()["running"] is True
    assert client.post("/api/tuner/start").status_code == 200
    assert len(calls) == 1
    args, options = calls[0]
    assert args == ["/path/to/node", str(manager.root / "tools/frame_tuner_lite/server.js")]
    assert options["env"]["LITE_PORT"] == "5188"
    assert Path(options["env"]["TEMP"]) == tuner.TEMP_DIR
    assert options["cwd"] == str(manager.root)
    assert options["stdin"] == subprocess.DEVNULL


def test_shutdown_only_terminates_owned_process(setup):
    _, manager = setup
    manager.shutdown()  # Adopting an existing verified server owns no process.
    calls = []
    manager.process = SimpleNamespace(poll=lambda: None, terminate=lambda: calls.append("terminate"), wait=lambda timeout: calls.append("wait"))
    manager.shutdown()
    manager.shutdown()
    assert calls == ["terminate", "wait"]


@pytest.fixture
def fake_cli(setup, monkeypatch):
    client, manager = setup
    calls = []
    monkeypatch.setattr(manager, "start", lambda: {"running": True, "url": manager.url})
    def run(args, **options):
        calls.append((args, options))
        project = args[args.index("--project") + 1]
        source = Path(args[args.index("--source") + 1])
        animation = args[args.index("--animation") + 1]
        manifest = manager.root / "data/lite/projects" / project / "animation_manifest.json"
        manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest.write_text(json.dumps({"profiles": [{"id": "character", "animations": [{"id": animation, "frames": [{"name": path.name} for path in sorted(source.glob('*.png'))]}]}]}), encoding="utf8")
        return SimpleNamespace(returncode=0, stderr="", stdout=json.dumps({"frames": len(list(source.glob("*.png"))), "project": project}))
    monkeypatch.setattr(tuner.subprocess, "run", run)
    return client, manager, calls


def post_frames(client, payload=None, **data):
    return client.post("/api/tuner/import", files={"archive": ("frames.zip", payload or archive(), "application/zip")}, data={"name": "待机动画", "fps": "12", **data})


def test_transfer_uses_official_cli_natural_order_and_actual_editor_query(fake_cli):
    client, _, calls = fake_cli
    frames = [(f"frames/frame_{number}.png", png((number, 0, 0, 255))) for number in (10, 2, 1)]
    response = post_frames(client, archive(frames), fps="18")
    assert response.status_code == 200
    result = response.json()
    assert result["project"].startswith("framecraft_")
    assert result["profile"] == "character"
    assert result["frameCount"] == 3 and result["fps"] == 18
    assert f"group={result['animation']}" not in result["url"]  # Unicode is URL encoded.
    from urllib.parse import parse_qs, urlsplit
    query = parse_qs(urlsplit(result["editorUrl"]).query)
    assert query["group"] == [result["animation"]]
    assert query["project"] == [result["project"]]
    args, options = calls[0]
    assert Path(args[1]).as_posix().endswith("tools/frame_tuner_lite/import_frames.js")
    assert "--label" in args and "--profile-label" in args
    assert options.get("shell", False) is False
    source = Path(args[args.index("--source") + 1])
    assert [Image.open(path).getpixel((0, 0))[0] for path in sorted(source.glob("*.png"))] == [1, 2, 10]
    assert (source.parent / "transfer.json").is_file()


def test_every_transfer_has_separate_project_preserving_prior_import(fake_cli):
    client, _, _ = fake_cli
    first = post_frames(client).json()
    first_dir = tuner.IMPORT_DIR / first["project"]
    marker = first_dir / "saved-marker.json"
    marker.write_text('{"unchanged":true}', encoding="utf8")
    second = post_frames(client).json()
    assert first["project"] != second["project"]
    assert first["animation"] != second["animation"]
    assert marker.read_text(encoding="utf8") == '{"unchanged":true}'
    assert (first_dir / "transfer.json").is_file()


def test_preserves_original_frame_names_and_source_metadata(fake_cli):
    client, manager, _ = fake_cli
    metadata = {"format": "framecraft-tuner-v1", "frames": [{"filename": "frame_0001.png", "sourceName": "walk_original_013.png", "sourceFrame": 13, "sourceTimeSeconds": 0.5}]}
    payload = archive([("frame_0001.png", png()), ("manifest.json", json.dumps(metadata).encode())])
    response = post_frames(client, payload)
    assert response.status_code == 200
    result = response.json()
    manifest = json.loads((manager.root / "data/lite/projects" / result["project"] / "animation_manifest.json").read_text(encoding="utf8"))
    frame = manifest["profiles"][0]["animations"][0]["frames"][0]
    assert frame["name"] == "walk_original_013.png"
    assert frame["framecraftSource"]["sourceFrame"] == 13
    assert frame["framecraftSource"]["sourceTimeSeconds"] == 0.5


def test_rejects_metadata_that_does_not_match_pngs(fake_cli):
    client, _, _ = fake_cli
    metadata = {"format": "framecraft-tuner-v1", "frames": [{"filename": "missing.png", "sourceName": "original.png"}]}
    payload = archive([("frame_0001.png", png()), ("manifest.json", json.dumps(metadata).encode())])
    assert post_frames(client, payload).status_code == 400


@pytest.mark.parametrize("member", ["../escape.png", "C:/escape.png", "/absolute.png", "folder/../../escape.png", "folder\\..\\escape.png"])
def test_rejects_zip_traversal_and_removes_only_new_import(fake_cli, member):
    client, _, calls = fake_cli
    response = post_frames(client, archive([(member, png())]))
    assert response.status_code == 400
    assert calls == []
    assert not list(tuner.IMPORT_DIR.iterdir())


def test_rejects_symlinks_encrypted_members_and_duplicate_names(fake_cli):
    client, _, _ = fake_cli
    info = zipfile.ZipInfo("link.png")
    info.create_system = 3
    info.external_attr = (stat.S_IFLNK | 0o777) << 16
    with pytest.raises(HTTPException):
        tuner.safe_zip_member(info)
    info = zipfile.ZipInfo("locked.png")
    info.flag_bits = 1
    with pytest.raises(HTTPException):
        tuner.safe_zip_member(info)
    with pytest.warns(UserWarning):
        duplicate = archive([("same.png", png()), ("same.png", png())])
    assert post_frames(client, duplicate).status_code == 400


def test_limits_frame_count_pixels_archive_bytes_and_zip_bombs(fake_cli, monkeypatch):
    client, _, _ = fake_cli
    monkeypatch.setattr(tuner, "MAX_FRAMES", 2)
    assert post_frames(client, archive([(f"{i}.png", png()) for i in range(3)])).status_code == 413
    monkeypatch.setattr(tuner, "MAX_FRAMES", 400)
    monkeypatch.setattr(tuner, "MAX_PIXELS", 4)
    assert post_frames(client).status_code == 413
    monkeypatch.setattr(tuner, "MAX_PIXELS", 120_000_000)
    bomb = archive([("large.txt", b"0" * 50_000), ("frame.png", png())])
    assert post_frames(client, bomb).status_code == 413
    monkeypatch.setattr(tuner, "MAX_ARCHIVE", 20)
    assert post_frames(client).status_code == 413


@pytest.mark.parametrize("options", [{"fps": "0"}, {"fps": "nan"}, {"fps": "241"}, {"name": " "}])
def test_validates_transfer_metadata(fake_cli, options):
    client, _, _ = fake_cli
    assert post_frames(client, **options).status_code == 422


def test_reports_corrupt_archive_or_fake_png(fake_cli):
    client, _, _ = fake_cli
    assert post_frames(client, b"bad zip").status_code == 400
    assert post_frames(client, archive([("frame.png", b"not png")])).status_code == 400
    assert post_frames(client, archive([("readme.txt", b"no frames")])).status_code == 400


def test_cli_failure_is_actionable_and_does_not_start_editor(fake_cli, monkeypatch):
    client, manager, _ = fake_cli
    monkeypatch.setattr(tuner.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=1, stderr="import failed", stdout=""))
    monkeypatch.setattr(manager, "start", lambda: pytest.fail("must not start after failed import"))
    response = post_frames(client)
    assert response.status_code == 503
    assert "import failed" in response.json()["detail"]
    assert not list(tuner.IMPORT_DIR.iterdir())


@pytest.mark.parametrize("relative,patcher_name", [
    ("tools/frame_tuner_lite/server.js", "patch_bytes"),
    ("tools/animation_tuner/public/app.js", "patch_view_bytes"),
])
def test_compatibility_patches_are_pinned_idempotent_and_refuse_unknown_edits(relative, patcher_name):
    from backend.patches import apply_xsxb_compat as compat
    with zipfile.ZipFile(compat.SOURCE_BUNDLE) as bundle:
        original = bundle.read(f"upstream/{relative}")
    patcher = getattr(compat, patcher_name)
    for data in (original, original.replace(b"\n", b"\r\n")):
        patched, changed = patcher(data)
        assert changed
        assert patcher(patched) == (patched, False)
        with pytest.raises(RuntimeError, match="SHA256"):
            patcher(data + b"\n// unknown local edits\n")
        with pytest.raises(RuntimeError, match="SHA256"):
            patcher(patched + b"\n// unknown local edits\n")


def test_shared_preset_revision_ignores_only_migration_metadata(tmp_path):
    from backend.patches.apply_xsxb_compat import REVISION_CONTENT_HELPER
    script = r'''
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const ROOT = process.cwd();
const sharedAttackTrailPresetPath = root => path.join(root, "presets.json");
''' + REVISION_CONTENT_HELPER + r'''
const file = sharedAttackTrailPresetPath(ROOT);
const hash = target => crypto.createHash("sha256").update(framecraftRevisionFileContent(target)).digest("hex");
const value = {schemaVersion: 1, presets: [{id: "custom", color: "#fff"}], migratedProjectIds: ["first"], futureField: {enabled: true}};
fs.writeFileSync(file, JSON.stringify(value, null, 2));
const initial = hash(file);
value.migratedProjectIds.push("second");
fs.writeFileSync(file, JSON.stringify(value, null, 4));
assert.equal(hash(file), initial, "new-project bookkeeping must not stale another editor");
value.presets[0].color = "#000";
fs.writeFileSync(file, JSON.stringify(value));
assert.notEqual(hash(file), initial, "real preset changes must still invalidate stale saves");
value.presets[0].color = "#fff";
value.futureField.enabled = false;
fs.writeFileSync(file, JSON.stringify(value));
assert.notEqual(hash(file), initial, "unknown fields must remain protected");
const ordinary = path.join(ROOT, "project.json");
fs.writeFileSync(ordinary, JSON.stringify({migratedProjectIds: ["first"]}));
const before = hash(ordinary);
fs.writeFileSync(ordinary, JSON.stringify({migratedProjectIds: ["second"]}));
assert.notEqual(hash(ordinary), before, "per-project files must retain exact content hashing");
console.log("revision guard verified");
'''
    result = subprocess.run([tuner.node_binary(), "-e", script], cwd=tmp_path, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert "revision guard verified" in result.stdout


def test_lite_fit_view_contains_bottom_anchored_frame_without_changing_other_modes(tmp_path):
    from backend.patches.apply_xsxb_compat import PATCHED_VIEW
    script = r'''
const assert = require("node:assert/strict");
let view;
let config = {projectKind: "frame_lite"};
let currentGroup = {id: "test"};
let images = [{}];
let selectedFrame = 0;
let devicePixelRatio = 1;
const els = {stage: {width: 640, height: 420}};
function currentFrameRect() {
  return {x: view.x - 250 * view.zoom * devicePixelRatio, y: view.y - 500 * view.zoom * devicePixelRatio,
    width: 500 * view.zoom * devicePixelRatio, height: 500 * view.zoom * devicePixelRatio};
}
''' + PATCHED_VIEW + r'''
for (const dpr of [1, 2]) {
  devicePixelRatio = dpr;
  els.stage.width = 640 * dpr;
  els.stage.height = 420 * dpr;
  fitView();
  const rect = currentFrameRect();
  assert.ok(rect.y >= 32 * dpr - 0.001);
  assert.ok(rect.x >= 32 * dpr - 0.001);
  assert.ok(rect.x + rect.width <= els.stage.width - 32 * dpr + 0.001);
  assert.ok(rect.y + rect.height <= els.stage.height - 32 * dpr + 0.001);
}
config = {projectKind: "godot"};
fitView();
assert.deepEqual(view, {zoom: 1, x: 640, y: 420});
config = {projectKind: "frame_lite"};
images = [];
fitView();
assert.deepEqual(view, {zoom: 1, x: 640, y: 420});
console.log("Lite view fit verified");
'''
    result = subprocess.run([tuner.node_binary(), "-e", script], cwd=tmp_path, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert "Lite view fit verified" in result.stdout
