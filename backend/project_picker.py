"""A separate, user-initiated native directory picker (no web-server Tk state)."""
from __future__ import annotations

import json
from pathlib import Path
import sys


def main() -> None:
    import tkinter as tk
    from tkinter import filedialog

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    initial = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()
    while not initial.is_dir() and initial != initial.parent:
        initial = initial.parent
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        selected = filedialog.askdirectory(parent=root, title="选择帧动画工程列表保存文件夹", initialdir=str(initial), mustexist=True)
        print(json.dumps({"directory": str(Path(selected).resolve()) if selected else None}, ensure_ascii=False))
    finally:
        root.destroy()


if __name__ == "__main__":
    main()
