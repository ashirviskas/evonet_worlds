// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// MULTIVERSE VIEWER — right-panel UI for the multiverse topology,
// portal traffic counters, recent-crossing log, and per-world stats
// sparklines. Pure DOM/canvas painters — never mutates sim state.
//
// Data sources:
//   world.uuid / world.color / world.multiverseX/Y       — self identity
//   world.knownWorlds: Map<uuid, {mx,my,color,lastSeenTick,statsHistory?}>
//   world.statsHistory                                   — self-broadcast samples
//   world.portalCrossings                                — per-side counters + recent log
//   BUILD_INFO (global, defined by build.py)             — version stamp
// ============================================================

(function () {
  // ---- Identity row + build stamp -------------------------------------------

  function updateWorldIdentity() {
    const swatch = document.getElementById('world-color-swatch');
    const idText = document.getElementById('world-id-text');
    const coordText = document.getElementById('world-coord-text');
    if (!swatch || !idText || !coordText) return;
    if (world.color) swatch.style.background = world.color;
    idText.textContent = world.uuid ? world.uuid.slice(0, 8) : '…';
    coordText.textContent = world.multiverseReady
      ? `(${world.multiverseX}, ${world.multiverseY})`
      : '';
  }

  function updateBuildStamp() {
    const el = document.getElementById('build-stamp');
    if (!el) return;
    if (typeof BUILD_INFO !== 'undefined' && BUILD_INFO) {
      el.textContent = `build: ${BUILD_INFO.commit} · ${BUILD_INFO.builtAt}`;
    } else {
      el.textContent = 'build: dev';
    }
  }

  // ---- Topology canvas ------------------------------------------------------

  function _drawMultiverseTopology(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, w, h);

    if (!world.uuid) return;

    const cells = [];
    cells.push({
      uuid: world.uuid, mx: world.multiverseX | 0, my: world.multiverseY | 0,
      color: world.color || '#888', isSelf: true,
    });
    if (world.knownWorlds) {
      for (const [uuid, e] of world.knownWorlds) {
        cells.push({ uuid, mx: e.mx | 0, my: e.my | 0, color: e.color || '#888', isSelf: false });
      }
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of cells) {
      if (c.mx < minX) minX = c.mx;
      if (c.mx > maxX) maxX = c.mx;
      if (c.my < minY) minY = c.my;
      if (c.my > maxY) maxY = c.my;
    }
    const gridW = (maxX - minX) + 1;
    const gridH = (maxY - minY) + 1;
    const margin = 14;
    const cellSizePx = Math.max(20, Math.min(48,
      Math.floor(Math.min((w - margin * 2) / gridW, (h - margin * 2) / gridH))));
    const offsetX = Math.floor((w - cellSizePx * gridW) / 2);
    const offsetY = Math.floor((h - cellSizePx * gridH) / 2);
    const cellPos = (mx, my) => ({
      cx: offsetX + (mx - minX) * cellSizePx + cellSizePx / 2,
      cy: offsetY + (my - minY) * cellSizePx + cellSizePx / 2,
    });

    // Edges between adjacent cells (manhattan distance == 1).
    ctx.lineWidth = 2;
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i], b = cells[j];
        if (Math.abs(a.mx - b.mx) + Math.abs(a.my - b.my) !== 1) continue;
        const pa = cellPos(a.mx, a.my), pb = cellPos(b.mx, b.my);
        ctx.strokeStyle = '#666';
        ctx.beginPath();
        ctx.moveTo(pa.cx, pa.cy);
        ctx.lineTo(pb.cx, pb.cy);
        ctx.stroke();
      }
    }

    // Tiles.
    const tileSize = Math.floor(cellSizePx * 0.7);
    for (const c of cells) {
      const p = cellPos(c.mx, c.my);
      ctx.fillStyle = c.color;
      ctx.fillRect(p.cx - tileSize / 2, p.cy - tileSize / 2, tileSize, tileSize);
      if (c.isSelf) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.strokeRect(p.cx - tileSize / 2 - 1, p.cy - tileSize / 2 - 1, tileSize + 2, tileSize + 2);
      }
      ctx.fillStyle = '#000';
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c.uuid.slice(0, 4), p.cx, p.cy);
    }
  }

  // ---- Sparkline (used in per-world rows) -----------------------------------

  function _drawSparkline(canvas, samples, key, color) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, w, h);
    if (!samples || samples.length < 2) return;
    let minV = Infinity, maxV = -Infinity;
    for (const s of samples) {
      const v = +s[key] || 0;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    if (!isFinite(minV) || !isFinite(maxV)) return;
    if (maxV === minV) maxV = minV + 1;
    ctx.strokeStyle = color || '#8cf';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const v = +samples[i][key] || 0;
      const x = (i / (samples.length - 1)) * (w - 2) + 1;
      const y = h - 1 - ((v - minV) / (maxV - minV)) * (h - 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // ---- Crossings text + recent log ------------------------------------------

  const SIDE_ARROW = { left: '←', right: '→', top: '↑', bottom: '↓' };

  function _renderCrossings() {
    const el = document.getElementById('multiverse-crossings');
    if (!el) return;
    const c = world.portalCrossings;
    if (!c) { el.innerHTML = ''; return; }
    const parts = [];
    for (const side of ['left', 'right', 'top', 'bottom']) {
      const inN = c.in[side] | 0, outN = c.out[side] | 0;
      const dim = (inN + outN) === 0;
      parts.push(
        `<div style="opacity:${dim ? 0.5 : 1};">` +
        `<span style="color:#8cf;">${SIDE_ARROW[side]} ${side}</span> ` +
        `<span style="color:#bbb;">in: ${inN}</span> ` +
        `<span style="color:#bbb;">out: ${outN}</span>` +
        `</div>`
      );
    }
    el.innerHTML = parts.join('');
  }

  function _renderRecentLog() {
    const el = document.getElementById('multiverse-log');
    if (!el) return;
    const c = world.portalCrossings;
    if (!c || !c.recent.length) { el.innerHTML = '<span style="color:#555;">no crossings yet</span>'; return; }
    const lines = [];
    for (let i = c.recent.length - 1; i >= 0; i--) {
      const r = c.recent[i];
      const arrow = r.dir === 'out' ? '→' : '←';
      const peer = r.peerUuid ? r.peerUuid.slice(0, 8) : '?';
      const color = r.dir === 'out' ? '#fc8' : '#8cf';
      lines.push(
        `<div>` +
        `<span style="color:#666;">t=${r.tick}</span> ` +
        `<span style="color:${color};">${r.dir} ${arrow} ${r.side}</span> ` +
        `<span style="color:#aaa;">peer=${peer}</span>` +
        `</div>`
      );
    }
    el.innerHTML = lines.join('');
  }

  // ---- Per-world rows (color swatch + uuid + (mx,my) + sparkline) -----------

  function _renderWorldList() {
    const el = document.getElementById('multiverse-worlds');
    if (!el) return;

    // Build a stable, sorted list (self first, then known worlds by mx,my).
    const rows = [];
    if (world.uuid) {
      rows.push({
        uuid: world.uuid,
        mx: world.multiverseX | 0, my: world.multiverseY | 0,
        color: world.color || '#888',
        isSelf: true,
        samples: world.statsHistory,
        lastSeenTick: world.tick,
      });
    }
    if (world.knownWorlds) {
      const remotes = [];
      for (const [uuid, e] of world.knownWorlds) {
        remotes.push({
          uuid, mx: e.mx | 0, my: e.my | 0,
          color: e.color || '#888',
          isSelf: false,
          samples: e.statsHistory || [],
          lastSeenTick: e.lastSeenTick | 0,
        });
      }
      remotes.sort((a, b) => a.my - b.my || a.mx - b.mx || a.uuid.localeCompare(b.uuid));
      rows.push(...remotes);
    }

    // Diff-by-uuid: rebuild only when the uuid set changed; else update inner
    // text / sparkline canvases in place. Cheap and avoids dom thrash.
    const existing = new Map();
    for (const node of el.children) existing.set(node.dataset.uuid, node);
    const newSet = new Set(rows.map(r => r.uuid));
    for (const [uuid, node] of existing) {
      if (!newSet.has(uuid)) el.removeChild(node);
    }

    for (const r of rows) {
      let node = existing.get(r.uuid);
      if (!node) {
        node = document.createElement('div');
        node.dataset.uuid = r.uuid;
        node.style.cssText = 'display:flex; align-items:center; gap:6px; padding:2px 4px; background:#161616; border-radius:3px;';
        node.innerHTML =
          `<span class="mvw-swatch" style="width:12px; height:12px; border-radius:2px; flex-shrink:0;"></span>` +
          `<span class="mvw-id" style="color:#ddd; font-family:monospace; font-size:10px;"></span>` +
          `<span class="mvw-coord" style="color:#888; font-size:10px;"></span>` +
          `<span class="mvw-pop" style="color:#bbb; font-size:10px; margin-left:6px;"></span>` +
          `<canvas class="mvw-spark" width="80" height="20" style="margin-left:auto; background:#0a0a0a; border:1px solid #222; border-radius:2px;"></canvas>` +
          `<span class="mvw-age" style="color:#666; font-size:9px;"></span>`;
        el.appendChild(node);
      }
      const swatch = node.querySelector('.mvw-swatch');
      swatch.style.background = r.color;
      swatch.style.border = r.isSelf ? '1px solid #fff' : '1px solid #333';
      node.querySelector('.mvw-id').textContent = r.uuid.slice(0, 8) + (r.isSelf ? ' (self)' : '');
      node.querySelector('.mvw-coord').textContent = `(${r.mx},${r.my})`;
      const last = r.samples && r.samples.length ? r.samples[r.samples.length - 1] : null;
      node.querySelector('.mvw-pop').textContent = last ? `pop ${last.numCells}` : 'pop —';
      _drawSparkline(node.querySelector('.mvw-spark'), r.samples, 'numCells', r.color);
      const ageTicks = world.tick - (r.lastSeenTick | 0);
      node.querySelector('.mvw-age').textContent = r.isSelf
        ? ''
        : (ageTicks >= 0 ? `${ageTicks}t ago` : '');
    }
  }

  // ---- Public update API ----------------------------------------------------

  function updateMultiverseViewer() {
    updateWorldIdentity();
    const topo = document.getElementById('multiverse-topo');
    if (topo) _drawMultiverseTopology(topo);
    _renderCrossings();
    _renderWorldList();
    _renderRecentLog();
  }

  // Expose to the global scope (matches the no-module convention used across
  // the rest of the bundle — see README "How the JS is stitched").
  window.updateWorldIdentity = updateWorldIdentity;
  window.updateBuildStamp = updateBuildStamp;
  window.updateMultiverseViewer = updateMultiverseViewer;
})();
