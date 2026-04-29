// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// WORLD STATS — local high-cadence sampler + popup with charts.
// Population, energy, free pools, and per-chromosome-lineage live counts
// are sampled every CONFIG.worldStatsSampleTicks ticks into
// world.worldStatsHistory. The popup (#stats-popup) draws line + stacked
// area charts off that buffer; sampling is gated on world.worldStatsEnabled
// so when the popup is hidden you can pause to save CPU.
// ============================================================

(function () {
  // ---- Sampler --------------------------------------------------------------

  function _countChromosomeLineages() {
    // Returns Map<lineageId, liveCellCount>. Counts each cell once per distinct
    // chromosome lineage in its genome (so a cell with 2 copies of the same
    // chromosome lid contributes 1 to that lid).
    const counts = new Map();
    for (let i = 0; i < world.maxCells; i++) {
      if (!world.alive[i]) continue;
      const g = world.genomes[i];
      if (!g) continue;
      const seenInCell = new Set();
      for (let c = 0; c < g.length; c++) {
        const lid = getLineageId(g[c]);
        if (lid <= 0 || seenInCell.has(lid)) continue;
        seenInCell.add(lid);
        counts.set(lid, (counts.get(lid) || 0) + 1);
      }
    }
    return counts;
  }

  function worldStatsSampleTick() {
    if (!world.worldStatsEnabled) return;
    if ((world.tick % CONFIG.worldStatsSampleTicks) !== 0) return;

    let n = 0, totalE = 0;
    for (let i = 0; i < world.maxCells; i++) {
      if (world.alive[i]) { n++; totalE += world.energy[i]; }
    }
    const m = world.milestones || {};
    const sample = {
      tick: world.tick,
      ts: Date.now(),
      numCells: n,
      totalEnergy: totalE,
      avgEnergy: n ? totalE / n : 0,
      photons: world.photonCount | 0,
      freeP: world.freePCount | 0,
      freeChrom: world.freeChromosomes ? world.freeChromosomes.length : 0,
      replicaseOk: m.replicaseCompleted | 0,
      replicaseFail: m.replicaseFailed | 0,
      membDivisions: m.membraneDivisions | 0,
      chromAbsorptions: m.chromAbsorptions | 0,
      chromCounts: _countChromosomeLineages(),
    };
    world.worldStatsHistory.push(sample);
    const cap = CONFIG.worldStatsHistory;
    if (world.worldStatsHistory.length > cap) {
      world.worldStatsHistory.splice(0, world.worldStatsHistory.length - cap);
    }
  }

  // ---- Chart drawers --------------------------------------------------------

  function _formatNum(v) {
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(1);
  }

  function _drawAxisAndLabel(ctx, w, h, maxV, currentLabel, color) {
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, w, h);
    // y=0 baseline.
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h - 0.5);
    ctx.lineTo(w, h - 0.5);
    ctx.stroke();
    // max-value marker line.
    ctx.fillStyle = '#666';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(_formatNum(maxV), 2, 2);
    // Current value at right.
    if (currentLabel != null) {
      ctx.fillStyle = color || '#8cf';
      ctx.textAlign = 'right';
      ctx.fillText(currentLabel, w - 4, 2);
    }
  }

  function _drawStatsLine(canvas, samples, key, color) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    if (!samples || samples.length < 2) {
      _drawAxisAndLabel(ctx, w, h, 0, '—', color);
      return;
    }
    let maxV = 0;
    for (const s of samples) {
      const v = +s[key] || 0;
      if (v > maxV) maxV = v;
    }
    if (maxV === 0) maxV = 1;
    const last = samples[samples.length - 1];
    const lastV = +last[key] || 0;
    _drawAxisAndLabel(ctx, w, h, maxV, _formatNum(lastV), color);
    ctx.strokeStyle = color || '#8cf';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const v = +samples[i][key] || 0;
      const x = (i / (samples.length - 1)) * (w - 2) + 1;
      const y = h - 1 - (v / maxV) * (h - 14);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function _drawStatsMulti(canvas, samples, keys, colors) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    if (!samples || samples.length < 2) {
      _drawAxisAndLabel(ctx, w, h, 0, '—', '#bbb');
      return;
    }
    let maxV = 0;
    for (const s of samples) {
      for (const k of keys) {
        const v = +s[k] || 0;
        if (v > maxV) maxV = v;
      }
    }
    if (maxV === 0) maxV = 1;
    _drawAxisAndLabel(ctx, w, h, maxV, '', '#bbb');
    for (let kI = 0; kI < keys.length; kI++) {
      const k = keys[kI];
      ctx.strokeStyle = colors[kI] || '#8cf';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i < samples.length; i++) {
        const v = +samples[i][k] || 0;
        const x = (i / (samples.length - 1)) * (w - 2) + 1;
        const y = h - 1 - (v / maxV) * (h - 14);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // Legend.
    ctx.font = '9px monospace';
    ctx.textBaseline = 'top';
    let xOff = 4;
    for (let kI = 0; kI < keys.length; kI++) {
      ctx.fillStyle = colors[kI] || '#8cf';
      const label = keys[kI];
      ctx.fillRect(xOff, 14, 8, 2);
      ctx.fillText(label, xOff + 12, 11);
      xOff += 16 + ctx.measureText(label).width;
    }
  }

  function _lidColor(lid) {
    return `hsl(${(lid * 47) % 360}, 65%, 55%)`;
  }

  function _selectTopLineages(samples, k) {
    // Union of top-K lineages from each sample, ranked by max count seen.
    // Keeps the same set persistent across redraws so colors don't reshuffle
    // between frames.
    const peakByLid = new Map();
    for (const s of samples) {
      if (!s.chromCounts) continue;
      for (const [lid, count] of s.chromCounts) {
        const prev = peakByLid.get(lid) || 0;
        if (count > prev) peakByLid.set(lid, count);
      }
    }
    const sorted = [...peakByLid.entries()].sort((a, b) => b[1] - a[1]);
    return sorted.slice(0, k).map(e => e[0]);
  }

  function _drawStatsChromosomes(canvas, samples) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, w, h);
    if (!samples || samples.length < 2) {
      _drawAxisAndLabel(ctx, w, h, 0, '—', '#bbb');
      _renderChromosomeLegend([]);
      return;
    }
    const topLids = _selectTopLineages(samples, CONFIG.worldStatsTopChromosomes);
    const topSet = new Set(topLids);

    // Per-sample stack: [topLid totals..., other]
    let maxStack = 0;
    const stacks = samples.map(s => {
      const arr = new Array(topLids.length + 1).fill(0);
      if (!s.chromCounts) return arr;
      for (const [lid, count] of s.chromCounts) {
        const idx = topLids.indexOf(lid);
        if (idx >= 0) arr[idx] = count;
        else arr[arr.length - 1] += count;
      }
      let total = 0;
      for (const v of arr) total += v;
      if (total > maxStack) maxStack = total;
      return arr;
    });
    if (maxStack === 0) maxStack = 1;

    _drawAxisAndLabel(ctx, w, h, maxStack, '', '#bbb');

    const N = samples.length;
    const stripX = (i) => (i / (N - 1)) * (w - 2) + 1;

    // Stacked area: walk bottom-up, draw each band as a polygon.
    let prevTopY = new Array(N).fill(h - 1);
    for (let bandI = 0; bandI < topLids.length + 1; bandI++) {
      const lid = bandI < topLids.length ? topLids[bandI] : null;
      const fill = lid != null ? _lidColor(lid) : 'rgba(120,120,120,0.6)';
      ctx.fillStyle = fill;
      ctx.beginPath();
      // Bottom edge: previous top, walked left-to-right then right-to-left.
      ctx.moveTo(stripX(0), prevTopY[0]);
      const newTopY = new Array(N);
      for (let i = 0; i < N; i++) {
        const v = stacks[i][bandI];
        const top = prevTopY[i] - (v / maxStack) * (h - 14);
        newTopY[i] = top;
        ctx.lineTo(stripX(i), top);
      }
      for (let i = N - 1; i >= 0; i--) {
        ctx.lineTo(stripX(i), prevTopY[i]);
      }
      ctx.closePath();
      ctx.fill();
      prevTopY = newTopY;
    }

    _renderChromosomeLegend(topLids);
  }

  function _renderChromosomeLegend(topLids) {
    const el = document.getElementById('stats-chart-chrom-legend');
    if (!el) return;
    if (!topLids.length) { el.innerHTML = '<span style="color:#666;">no live lineages</span>'; return; }
    const parts = topLids.map(lid =>
      `<span style="display:inline-flex; align-items:center; gap:3px;">` +
      `<span style="width:9px; height:9px; background:${_lidColor(lid)}; border-radius:1px;"></span>` +
      `<span style="color:#bbb;">lid:${lid}</span>` +
      `</span>`
    );
    parts.push(
      `<span style="display:inline-flex; align-items:center; gap:3px;">` +
      `<span style="width:9px; height:9px; background:rgba(120,120,120,0.6); border-radius:1px;"></span>` +
      `<span style="color:#888;">other</span>` +
      `</span>`
    );
    el.innerHTML = parts.join(' ');
  }

  // ---- Popup show/hide/drag -------------------------------------------------

  let statsPopupVisible = false;

  function openStatsPopup() {
    const popup = document.getElementById('stats-popup');
    const btn = document.getElementById('btn-stats');
    if (!popup) return;
    popup.style.display = 'flex';
    if (btn) btn.classList.add('active');
    statsPopupVisible = true;
    const idEl = document.getElementById('stats-popup-id');
    if (idEl && world.uuid) idEl.textContent = world.uuid.slice(0, 8);
    updateStatsPopup();
  }

  function closeStatsPopup() {
    const popup = document.getElementById('stats-popup');
    const btn = document.getElementById('btn-stats');
    if (popup) popup.style.display = 'none';
    if (btn) btn.classList.remove('active');
    statsPopupVisible = false;
  }

  function toggleStatsPopup() {
    if (statsPopupVisible) closeStatsPopup();
    else openStatsPopup();
  }

  function _wireStatsPopupDrag() {
    const popup = document.getElementById('stats-popup');
    const bar = document.getElementById('stats-popup-titlebar');
    if (!popup || !bar) return;
    let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
    bar.addEventListener('mousedown', (e) => {
      // Ignore clicks on titlebar buttons / inputs.
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'LABEL') return;
      dragging = true;
      const rect = popup.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startLeft = rect.left; startTop = rect.top;
      // Switch from right-anchored to left-anchored so dragging works naturally.
      popup.style.left = startLeft + 'px';
      popup.style.top = startTop + 'px';
      popup.style.right = 'auto';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      const left = Math.max(0, Math.min(window.innerWidth - 80, startLeft + dx));
      const top = Math.max(0, Math.min(window.innerHeight - 40, startTop + dy));
      popup.style.left = left + 'px';
      popup.style.top = top + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  // ---- Update tick (called from main loop while popup is visible) -----------

  function updateStatsPopup() {
    if (!statsPopupVisible) return;
    const samples = world.worldStatsHistory;
    const body = document.getElementById('stats-popup-body');
    if (!body) return;
    for (const canvas of body.querySelectorAll('canvas.stats-chart')) {
      const key = canvas.dataset.key;
      if (key) {
        // Single line — pick a sensible color per metric.
        const color = key === 'totalEnergy' ? '#fc8'
          : key === 'avgEnergy' ? '#ff8'
          : '#8cf';
        _drawStatsLine(canvas, samples, key, color);
      } else if (canvas.dataset.keys) {
        const keys = canvas.dataset.keys.split(',');
        const colors = (canvas.dataset.colors || '').split(',');
        _drawStatsMulti(canvas, samples, keys, colors);
      }
    }
    const chromCanvas = document.getElementById('stats-chart-chromosomes');
    if (chromCanvas) _drawStatsChromosomes(chromCanvas, samples);
  }

  // ---- Wire DOM handlers ----------------------------------------------------

  function _wireDom() {
    const btn = document.getElementById('btn-stats');
    if (btn) btn.addEventListener('click', toggleStatsPopup);
    const close = document.getElementById('stats-popup-close');
    if (close) close.addEventListener('click', closeStatsPopup);
    const toggle = document.getElementById('stats-sampling-toggle');
    if (toggle) toggle.addEventListener('change', (e) => {
      world.worldStatsEnabled = !!e.target.checked;
    });
    _wireStatsPopupDrag();
  }
  _wireDom();

  // Public API.
  window.worldStatsSampleTick = worldStatsSampleTick;
  window.updateStatsPopup = updateStatsPopup;
  window.openStatsPopup = openStatsPopup;
  window.closeStatsPopup = closeStatsPopup;
  window.toggleStatsPopup = toggleStatsPopup;
  Object.defineProperty(window, 'statsPopupVisible', { get: () => statsPopupVisible });
})();
