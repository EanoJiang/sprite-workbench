"""Rebuild the audited Framecraft changes to six pinned XSXB source files.

Upstream: sparklecatta-lang/XSXB-Frame-Tuner, MIT,
revision cb061e15132b9250feebd34a18a3fd023197837c.
See docs/licenses/LICENSE.XSXB-Frame-Tuner for upstream attribution and license.
xsxb-local.patch is the reviewable diff; xsxb_sources.zip and its SHA256
manifest provide the same sources for offline, newline-independent replay.
No unrelated source revision, unknown source edits, or user data is overwritten.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import zipfile

SOURCE_PATCH_ID = "framecraft-xsxb-integration-v1"
SOURCE_REVISION = "cb061e15132b9250feebd34a18a3fd023197837c"
SOURCE_BUNDLE = Path(__file__).with_name("xsxb_sources.zip")
SOURCE_MANIFEST = Path(__file__).with_name("xsxb_sources.json")
SOURCE_FILES = (
    "tools/animation_tuner/public/app.js",
    "tools/animation_tuner/public/index.html",
    "tools/frame_tuner_lite/import_frames.js",
    "tools/frame_tuner_lite/public/lite.css",
    "tools/frame_tuner_lite/public/lite.js",
    "tools/frame_tuner_lite/server.js",
)
RELATIVE_FILE = Path("tools/frame_tuner_lite/server.js")
VIEW_RELATIVE_FILE = Path("tools/animation_tuner/public/app.js")
ORIGINAL_SHA256 = {
    "97c1258e0dd4cca44cef3ba430eee4a6059f07230792d4977fb7f8b9cecb1a62",  # LF
    "a4b7dd7aa9ce40b3c7d0682bb84624fc9fc369c66292f5dfd0ee1ccc0d19fcb6",  # CRLF
}
VIEW_ORIGINAL_SHA256 = {
    "b1071751224c33c287dd3f79d20fcfbb4ec9fbbde7b27a114e9de6d247e300de",  # LF
    "bfebf12c32453cd1a30d5c87651eb3a43b42fa1fedf5aefc7fb4c11f42b76570",  # CRLF
}

ORIGINAL_VIEW = '''function fitView() {
  view = { zoom: 1, x: els.stage.width / 2, y: els.stage.height / 2 };
}'''

PATCHED_VIEW = '''function fitView() {
  view = { zoom: 1, x: els.stage.width / 2, y: els.stage.height / 2 };
  // Framecraft compatibility: fit Lite previews without altering saved transforms.
  if (config?.projectKind !== "frame_lite" || !currentGroup || !images[selectedFrame]) return;
  const centered = view;
  view = { zoom: 1, x: 0, y: 0 };
  const rect = currentFrameRect();
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
      || !rect.width || !rect.height) {
    view = centered;
    return;
  }
  const padding = 32 * devicePixelRatio;
  const zoom = Math.min(1,
    Math.max(1, els.stage.width - padding * 2) / Math.abs(rect.width),
    Math.max(1, els.stage.height - padding * 2) / Math.abs(rect.height));
  view = {
    zoom,
    x: els.stage.width / 2 - (rect.x + rect.width / 2) * zoom,
    y: els.stage.height / 2 - (rect.y + rect.height / 2) * zoom,
  };
}'''

ORIGINAL_FUNCTION = r'''function projectConfigRevision(project) {
  const target = store.paths(project);
  const hash = crypto.createHash("sha256");
  for (const filePath of [
    target.manifest,
    target.tuning,
    target.frameAudio,
    target.frameImageAttachments,
    target.attackTrails,
    sharedAttackTrailPresetPath(ROOT),
  ]) {
    hash.update(path.basename(filePath));
    hash.update("\0");
    hash.update(fs.existsSync(filePath) ? fs.readFileSync(filePath) : Buffer.alloc(0));
    hash.update("\0");
  }
  return hash.digest("hex");
}'''

REVISION_CONTENT_HELPER = r'''// Framecraft compatibility: migration bookkeeping cannot invalidate other projects.
function framecraftRevisionFileContent(filePath) {
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath) : Buffer.alloc(0);
  if (filePath !== sharedAttackTrailPresetPath(ROOT)) return content;
  try {
    const value = JSON.parse(content.toString("utf8").replace(/^\uFEFF/, ""));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      delete value.migratedProjectIds;
      return Buffer.from(JSON.stringify(value));
    }
  } catch {}
  return content;
}'''

PATCHED_FUNCTION = REVISION_CONTENT_HELPER + "\n\n" + ORIGINAL_FUNCTION.replace(
    "    hash.update(fs.existsSync(filePath) ? fs.readFileSync(filePath) : Buffer.alloc(0));",
    "    hash.update(framecraftRevisionFileContent(filePath));",
)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def patch_bytes(data: bytes) -> tuple[bytes, bool]:
    return _patch_exact(data, ORIGINAL_FUNCTION, PATCHED_FUNCTION, ORIGINAL_SHA256)


def patch_view_bytes(data: bytes) -> tuple[bytes, bool]:
    return _patch_exact(data, ORIGINAL_VIEW, PATCHED_VIEW, VIEW_ORIGINAL_SHA256)


def _patch_exact(data: bytes, old: str, new: str, known_hashes: set[str]) -> tuple[bytes, bool]:
    newline = "\r\n" if b"\r\n" in data else "\n"
    original = old.replace("\n", newline).encode("utf-8")
    replacement = new.replace("\n", newline).encode("utf-8")
    if digest(data) in known_hashes:
        if data.count(original) != 1:
            raise RuntimeError("XSXB 源码锚点不匹配，已停止应用兼容补丁。")
        return data.replace(original, replacement, 1), True
    # Known patched means reversing the exact patch reproduces the entire pinned file.
    if data.count(replacement) == 1 and digest(data.replace(replacement, original, 1)) in known_hashes:
        return data, False
    raise RuntimeError("XSXB 源码 SHA256 与固定版本或已知兼容补丁不符；请重新运行 setup.ps1 检查源码，现有调参数据不会被修改。")


def _load_source_bundle() -> dict[str, tuple[bytes, bytes]]:
    """Read only the six fixed paths, verifying every bundled source first."""
    manifest = json.loads(SOURCE_MANIFEST.read_text(encoding="utf-8"))
    if manifest.get("revision") != SOURCE_REVISION or set(manifest.get("files", {})) != set(SOURCE_FILES):
        raise RuntimeError("XSXB source manifest does not match the pinned revision and six source paths.")
    sources = {}
    with zipfile.ZipFile(SOURCE_BUNDLE) as bundle:
        expected_names = {f"{state}/{relative}" for state in ("upstream", "framecraft") for relative in SOURCE_FILES}
        names = bundle.namelist()
        if len(names) != len(expected_names) or set(names) != expected_names:
            raise RuntimeError("XSXB source bundle contains unexpected or duplicate paths.")
        for relative in SOURCE_FILES:
            upstream = bundle.read(f"upstream/{relative}")
            framecraft = bundle.read(f"framecraft/{relative}")
            hashes = manifest["files"][relative]
            if digest(upstream) != hashes["upstream_sha256"] or digest(framecraft) != hashes["framecraft_sha256"]:
                raise RuntimeError(f"XSXB source bundle SHA256 mismatch: {relative}")
            sources[relative] = upstream, framecraft
    return sources


def apply_compat_patch(root: Path | None = None) -> dict:
    root = (root or Path(__file__).resolve().parents[1] / "vendor/XSXB-Frame-Tuner").resolve()
    sources = _load_source_bundle()
    validated = []
    for relative, (upstream, framecraft) in sources.items():
        target = root / relative
        if target.is_symlink() or target.resolve() != target:
            raise RuntimeError(f"XSXB source path is redirected: {relative}")
        source = target.read_bytes()
        normalized = source.replace(b"\r\n", b"\n")
        known_hashes = {digest(upstream), digest(framecraft)}
        # Also accept installations that previously received only the two
        # compatibility fixes. All other local edits must retain a full hash match.
        if relative == RELATIVE_FILE.as_posix():
            known_hashes.add(digest(patch_bytes(upstream)[0]))
        elif relative == VIEW_RELATIVE_FILE.as_posix():
            known_hashes.add(digest(patch_view_bytes(upstream)[0]))
        if digest(normalized) not in known_hashes:
            raise RuntimeError(f"XSXB source SHA256 mismatch: {relative}. Unknown source edits and existing project data are preserved.")
        patched = framecraft.replace(b"\n", b"\r\n") if b"\r\n" in source else framecraft
        validated.append((relative, target, patched, source != patched))
    # Validate the whole batch before writing any source. No data/ paths are read
    # or written, and an unknown edit in any of the six files rejects the batch.
    results = []
    for relative, target, patched, changed in validated:
        if changed:
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(
                    dir=target.parent, prefix=f".{target.name}.framecraft-", suffix=".tmp", delete=False
                ) as pending:
                    temporary = Path(pending.name)
                    pending.write(patched)
                os.replace(temporary, target)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
        results.append({"patch": SOURCE_PATCH_ID, "changed": changed, "file": relative, "sha256": digest(patched)})
    return {"changed": any(item["changed"] for item in results), "patches": results}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path)
    args = parser.parse_args()
    print(json.dumps(apply_compat_patch(args.root), ensure_ascii=False))
