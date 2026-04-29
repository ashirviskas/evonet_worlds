#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Matas Minelga
"""Assemble poc.html from poc.template.html + src/*.js.

Run: python3 build.py   (from topics/evo_net/)
"""
import datetime
import json
import subprocess
from pathlib import Path

HERE = Path(__file__).parent
TEMPLATE = HERE / "poc.template.html"
SRC_DIR = HERE / "src"
OUT = HERE / "poc.html"
JS_MARKER = "<!-- JS_BUNDLE -->"
BUILD_MARKER = "<!-- BUILD_INFO -->"


def _git_short_commit():
    try:
        commit = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=HERE, stderr=subprocess.DEVNULL, text=True,
        ).strip()
    except Exception:
        return "unknown"
    try:
        dirty = subprocess.check_output(
            ["git", "status", "--porcelain"],
            cwd=HERE, stderr=subprocess.DEVNULL, text=True,
        ).strip()
        if dirty:
            commit += "-dirty"
    except Exception:
        pass
    return commit


js_files = sorted(SRC_DIR.glob("*.js"))
parts = []
for f in js_files:
    parts.append(f"// ===== {f.name} =====")
    parts.append(f.read_text())
bundle = "\n".join(parts)

commit = _git_short_commit()
built_at = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
build_info_js = (
    f"const BUILD_INFO = Object.freeze({{ "
    f"commit: {json.dumps(commit)}, "
    f"builtAt: {json.dumps(built_at)} }});"
)

template = TEMPLATE.read_text()
for marker in (JS_MARKER, BUILD_MARKER):
    if marker not in template:
        raise SystemExit(f"marker {marker!r} not found in {TEMPLATE}")
out_html = template.replace(BUILD_MARKER, build_info_js).replace(JS_MARKER, bundle)
OUT.write_text(out_html)
print(f"built {OUT.name} ({OUT.stat().st_size} bytes, {len(js_files)} js files, commit {commit})")
