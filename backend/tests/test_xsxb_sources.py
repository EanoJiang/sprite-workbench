"""Offline reconstruction checks; never read or modify the user's vendor tree."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

import pytest

from backend.patches import apply_xsxb_compat as compat


@pytest.fixture
def sources():
    with zipfile.ZipFile(compat.SOURCE_BUNDLE) as bundle:
        return {
            relative: (bundle.read(f"upstream/{relative}"), bundle.read(f"framecraft/{relative}"))
            for relative in compat.SOURCE_FILES
        }


def install(root, sources, state=0, newline=b"\n"):
    for relative, versions in sources.items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(versions[state].replace(b"\n", newline))
    saved = root / "data/lite/projects/existing/project.json"
    saved.parent.mkdir(parents=True, exist_ok=True)
    saved.write_bytes(b'{"userData":"must remain byte-identical"}\r\n')
    (root / "tools/unrelated.js").write_bytes(b"// unrelated source stays unchanged\n")


def snapshot(root):
    return {path.relative_to(root).as_posix(): path.read_bytes() for path in root.rglob("*") if path.is_file()}


@pytest.mark.parametrize("newline", [b"\n", b"\r\n"], ids=["LF", "CRLF"])
def test_clean_pinned_source_rebuilds_all_six_files_and_is_idempotent(tmp_path, sources, newline):
    root = tmp_path / "vendor"
    install(root, sources, newline=newline)
    before = snapshot(root)
    result = compat.apply_compat_patch(root)
    assert result["changed"]
    assert {item["file"] for item in result["patches"]} == set(compat.SOURCE_FILES)
    manifest = json.loads(compat.SOURCE_MANIFEST.read_text(encoding="utf-8"))
    for relative, (upstream, framecraft) in sources.items():
        assert compat.digest(upstream) == manifest["files"][relative]["upstream_sha256"]
        assert compat.digest(framecraft) == manifest["files"][relative]["framecraft_sha256"]
        assert (root / relative).read_bytes() == framecraft.replace(b"\n", newline)
    after = snapshot(root)
    assert not compat.apply_compat_patch(root)["changed"]
    assert snapshot(root) == after
    for relative in before.keys() - set(compat.SOURCE_FILES):
        assert after[relative] == before[relative]


@pytest.mark.parametrize("newline", [b"\n", b"\r\n"], ids=["LF", "CRLF"])
def test_previous_compatibility_only_installation_upgrades_without_losing_data(tmp_path, sources, newline):
    root = tmp_path / "vendor"
    install(root, sources, newline=newline)
    for relative, patcher in ((compat.RELATIVE_FILE, compat.patch_bytes), (compat.VIEW_RELATIVE_FILE, compat.patch_view_bytes)):
        target = root / relative
        target.write_bytes(patcher(target.read_bytes())[0])
    saved = (root / "data/lite/projects/existing/project.json").read_bytes()
    assert compat.apply_compat_patch(root)["changed"]
    for relative, (_, framecraft) in sources.items():
        assert (root / relative).read_bytes() == framecraft.replace(b"\n", newline)
    assert (root / "data/lite/projects/existing/project.json").read_bytes() == saved


@pytest.mark.parametrize("state", [0, 1], ids=["upstream", "framecraft"])
@pytest.mark.parametrize("relative", compat.SOURCE_FILES)
def test_unknown_edit_in_any_source_rejects_the_whole_batch(tmp_path, sources, state, relative):
    root = tmp_path / "vendor"
    install(root, sources, state=state)
    target = root / relative
    # A marker alone must never bypass the full source hash check.
    target.write_bytes(target.read_bytes() + b"\n// Framecraft direct canvas manipulation\n// unknown edit\n")
    before = snapshot(root)
    with pytest.raises(RuntimeError, match="SHA256"):
        compat.apply_compat_patch(root)
    assert snapshot(root) == before


@pytest.mark.parametrize("damage", ["unexpected_path", "duplicate_path", "source_hash"])
def test_invalid_bundle_is_rejected_before_any_source_is_written(tmp_path, sources, monkeypatch, damage):
    root = tmp_path / "vendor"
    install(root, sources)
    before = snapshot(root)
    damaged = tmp_path / "damaged.zip"
    with zipfile.ZipFile(compat.SOURCE_BUNDLE) as original, zipfile.ZipFile(damaged, "w") as bundle:
        for name in original.namelist():
            data = original.read(name)
            if damage == "source_hash" and name == f"framecraft/{compat.SOURCE_FILES[0]}":
                data += b"// tampered bundle\n"
            bundle.writestr(name, data)
        if damage == "unexpected_path":
            bundle.writestr("../../data/project.json", b"must never be extracted")
        elif damage == "duplicate_path":
            with pytest.warns(UserWarning, match="Duplicate name"):
                bundle.writestr(original.namelist()[0], b"duplicate")
    monkeypatch.setattr(compat, "SOURCE_BUNDLE", damaged)
    with pytest.raises(RuntimeError, match="paths|SHA256"):
        compat.apply_compat_patch(root)
    assert snapshot(root) == before


def test_review_patch_rebuilds_the_same_six_sources(tmp_path, sources):
    git = shutil.which("git")
    if not git:
        pytest.skip("Git is needed to audit the review diff; bundle replay itself requires no Git.")
    root = tmp_path / "vendor"
    install(root, sources)
    saved = (root / "data/lite/projects/existing/project.json").read_bytes()
    patch = Path(compat.__file__).with_name("xsxb-local.patch")
    subprocess.run([git, "init", "--quiet", str(root)], check=True, capture_output=True)
    git_apply = [git, "-c", "core.autocrlf=false", "-C", str(root), "apply"]
    subprocess.run([*git_apply, "--check", str(patch)], check=True, capture_output=True)
    subprocess.run([*git_apply, str(patch)], check=True, capture_output=True)
    for relative, (_, framecraft) in sources.items():
        assert (root / relative).read_bytes() == framecraft
    assert (root / "data/lite/projects/existing/project.json").read_bytes() == saved
    assert not compat.apply_compat_patch(root)["changed"]


def test_setup_python_entry_point_replays_the_offline_sources(tmp_path, sources):
    root = tmp_path / "vendor"
    install(root, sources)
    command = [sys.executable, "-B", str(Path(compat.__file__)), "--root", str(root)]
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    assert json.loads(result.stdout)["changed"]
    for relative, (_, framecraft) in sources.items():
        assert (root / relative).read_bytes() == framecraft
    repeated = subprocess.run(command, check=True, capture_output=True, text=True)
    assert not json.loads(repeated.stdout)["changed"]


def test_existing_temporary_names_are_preserved(tmp_path, sources):
    root = tmp_path / "vendor"
    install(root, sources)
    existing = {}
    for relative in compat.SOURCE_FILES:
        legacy_temporary = (root / relative).with_suffix(".framecraft.tmp")
        content = f"unknown existing file beside {relative}\n".encode()
        legacy_temporary.write_bytes(content)
        existing[legacy_temporary] = content
    assert compat.apply_compat_patch(root)["changed"]
    for target, content in existing.items():
        assert target.read_bytes() == content
    assert not list(root.rglob(".*.framecraft-*.tmp"))


def test_replace_failure_cleans_its_exclusive_temporary_file(tmp_path, sources, monkeypatch):
    root = tmp_path / "vendor"
    install(root, sources)
    before = snapshot(root)
    attempted = []

    def fail_replace(temporary, target):
        temporary = Path(temporary)
        assert temporary.parent == target.parent
        assert temporary.read_bytes() == sources[target.relative_to(root).as_posix()][1]
        attempted.append(temporary)
        raise OSError("simulated replacement failure")

    monkeypatch.setattr(compat.os, "replace", fail_replace)
    with pytest.raises(OSError, match="simulated replacement failure"):
        compat.apply_compat_patch(root)
    assert len(attempted) == 1
    assert not attempted[0].exists()
    assert snapshot(root) == before


def test_source_directory_link_into_project_data_is_rejected(tmp_path, sources):
    root = tmp_path / "vendor"
    data = root / "data/redirected-source"
    install(data, sources)
    link = root / "tools"
    destination = data / "tools"
    junction = False
    try:
        try:
            link.symlink_to(destination, target_is_directory=True)
        except OSError:
            if os.name != "nt":
                raise
            # Directory junction creation does not require Windows symlink privileges.
            result = subprocess.run(
                ["cmd.exe", "/c", "mklink", "/J", str(link), str(destination)], capture_output=True
            )
            assert result.returncode == 0, result.stderr
            junction = True
        before = snapshot(root / "data")
        with pytest.raises(RuntimeError, match="source path is redirected"):
            compat.apply_compat_patch(root)
        assert snapshot(root / "data") == before
    finally:
        # Remove only the link itself, never recursively traverse a junction.
        if junction:
            link.rmdir()
        elif link.is_symlink():
            link.unlink()


def test_source_file_symlink_into_project_data_is_rejected(tmp_path, sources):
    root = tmp_path / "vendor"
    install(root, sources)
    target = root / compat.SOURCE_FILES[0]
    data = root / "data/user-source.js"
    data.write_bytes(target.read_bytes())
    target.unlink()
    try:
        target.symlink_to(data)
    except OSError:
        target.write_bytes(data.read_bytes())
        if os.name != "nt":
            raise
        pytest.skip("Windows file-symlink privilege is unavailable; the directory junction is tested separately.")
    try:
        before = snapshot(root)
        with pytest.raises(RuntimeError, match="source path is redirected"):
            compat.apply_compat_patch(root)
        assert snapshot(root) == before
    finally:
        target.unlink()
