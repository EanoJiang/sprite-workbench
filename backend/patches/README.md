# XSXB source integration

Upstream: [sparklecatta-lang/XSXB-Frame-Tuner](https://github.com/sparklecatta-lang/XSXB-Frame-Tuner),
fixed revision `cb061e15132b9250feebd34a18a3fd023197837c`.
Copyright (c) 2026 sparklecatta-lang. Upstream is MIT licensed; see
[`docs/licenses/LICENSE.XSXB-Frame-Tuner`](../../docs/licenses/LICENSE.XSXB-Frame-Tuner).

`xsxb-local.patch` is the reviewable diff from that revision to the six Framecraft
source files. It preserves the canvas selection/move/scale tools, import anchor
selection, save-and-return bridge, Lite preview fitting, and preset revision fix.
It contains only `tools/` source changes; user projects and migrated preset data
are excluded.

`xsxb_sources.zip` contains the exact LF upstream and Framecraft versions of those
six files. `xsxb_sources.json` records their SHA256 values and provenance. The
compressed bundle also supplies offline test fixtures without depending on an
installed vendor tree or Git history.

`setup.ps1` already invokes `apply_xsxb_compat.py` after cloning the pinned source.
That entry point checks all six installed files and the complete bundle before
writing. It accepts the pinned source, the previous two compatibility fixes, or
the exact bundled Framecraft source, with LF or CRLF. Repeated runs are idempotent.
Unknown edits reject the whole batch; no `data/` files are read or written.

To verify a separate installation, run:

```powershell
.venv\Scripts\python.exe backend\patches\apply_xsxb_compat.py --root <XSXB-directory>
```

When changing the integration, update the review patch, bundled source versions,
and manifest together. Run `backend/tests/test_xsxb_sources.py` to verify exact
reconstruction, repeat execution, newline handling, and rejection of unknown edits.
