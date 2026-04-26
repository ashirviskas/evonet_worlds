#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Matas Minelga
"""Assemble poc.html from poc.template.html + src/*.js.

Run: python3 build.py   (from topics/evo_net/)
"""
from pathlib import Path

HERE = Path(__file__).parent
TEMPLATE = HERE / "poc.template.html"
SRC_DIR = HERE / "src"
OUT = HERE / "poc.html"
MARKER = "<!-- JS_BUNDLE -->"

js_files = sorted(SRC_DIR.glob("*.js"))
parts = []
for f in js_files:
    parts.append(f"// ===== {f.name} =====")
    parts.append(f.read_text())
bundle = "\n".join(parts)

template = TEMPLATE.read_text()
if MARKER not in template:
    raise SystemExit(f"marker {MARKER!r} not found in {TEMPLATE}")
OUT.write_text(template.replace(MARKER, bundle))
print(f"built {OUT.name} ({OUT.stat().st_size} bytes, {len(js_files)} js files)")
