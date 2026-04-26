// ============================================================
// RENDERING
// ============================================================
const canvas = document.getElementById('world');
const ctx = canvas.getContext('2d');
let camera = { x: 0, y: 0, zoom: 1 };
// Selection state.
//
// Multi-select: each entity kind has a Set of currently-inspected indices.
// Each entry corresponds to an open inspect popup. Sets give O(1) hit-tests in
// the per-frame highlight loops (see selected* checks below).
//
// "Primary" scalars are the most-recently-clicked of each kind; existing code
// paths that act on a single selection (Force Divide / Kill / Copy Genome
// buttons in the right panel, save/load resume, editor jump-back) keep
// reading the scalar. Updated on every add/close.
const selectedCells = new Set();
const selectedFreeProteins = new Set();
const selectedFreeChroms = new Set();
let selectedCell = -1;
let selectedFreeProtein = -1;
let selectedFreeChrom = -1;

// Debug: spatial-grid bucket visualization. 0=off, 1=cell grid, 2=free-protein grid.
let showBuckets = 0;

// Precomputed hsl() strings — avoids ~72k fillStyle string parses per frame at
// 1k+ cells. Indexed by `pType * 10 + fillBucket` where
// fillBucket = ((pCount * 10 / MAX_SUB_PROTEINS) | 0), clamped 0..9.
const PROTEIN_HSL_LUT = (() => {
  const lut = new Array(64 * 10);
  for (let t = 0; t < 64; t++) {
    const hsl = PROTEIN_HSL[t] || [0, 0, 50];
    for (let b = 0; b < 10; b++) {
      const fill = b / 9;
      // Full saturation always; fill level encoded in lightness so low-count
      // subslots stay vivid (the old saturation-scaling turned them grey).
      const lit = Math.round(hsl[2] * (0.6 + fill * 0.4));
      lut[t * 10 + b] = `hsl(${hsl[0]}, ${hsl[1]}%, ${lit}%)`;
    }
  }
  return lut;
})();
const PROTEIN_HSL_PLAIN = (() => {
  const out = new Array(256);
  for (let t = 0; t < 256; t++) {
    const h = PROTEIN_HSL[t] || [0, 0, 50];
    out[t] = `hsl(${h[0]}, ${h[1]}%, ${h[2]}%)`;
  }
  return out;
})();

function resizeCanvas() {
  const c = document.getElementById('canvas-container');
  canvas.width = c.clientWidth; canvas.height = c.clientHeight;
  camera.zoom = Math.min(canvas.width / CONFIG.worldWidth, canvas.height / CONFIG.worldHeight);
}

function worldToScreen(wx, wy) {
  return { x: (wx - camera.x) * camera.zoom + canvas.width / 2, y: (wy - camera.y) * camera.zoom + canvas.height / 2 };
}
function screenToWorld(sx, sy) {
  return { x: (sx - canvas.width / 2) / camera.zoom + camera.x, y: (sy - canvas.height / 2) / camera.zoom + camera.y };
}

function render() {
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // World boundary
  const wtl = worldToScreen(0, 0), wbr = worldToScreen(CONFIG.worldWidth, CONFIG.worldHeight);
  ctx.strokeStyle = '#333'; ctx.strokeRect(wtl.x, wtl.y, wbr.x - wtl.x, wbr.y - wtl.y);

  // Debug: spatial-grid bucket heatmap (toggle with B).
  if (showBuckets) {
    const grid = showBuckets === 2 ? world.freePGrid : world.grid;
    const label = showBuckets === 2 ? 'free proteins' : 'cells';
    const gcs = world.gridCellSize, gw = world.gridW, gh = world.gridH;
    for (let by = 0; by < gh; by++) {
      for (let bx = 0; bx < gw; bx++) {
        const b = grid[by * gw + bx];
        const n = b.length;
        if (n === 0) continue;
        // Heatmap: 1 → green, growing → yellow → red. Cap at 10 for color scale.
        const t = Math.min(1, n / 10);
        const r = Math.round(60 + t * 195);
        const g = Math.round(200 - t * 160);
        ctx.fillStyle = `rgba(${r}, ${g}, 60, 0.28)`;
        const tl = worldToScreen(bx * gcs, by * gcs);
        const sz = gcs * camera.zoom;
        ctx.fillRect(tl.x, tl.y, sz, sz);
        // Count label (only when zoomed in enough and bucket has > 1)
        if (sz > 18 && n > 1) {
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.font = `${Math.min(12, sz * 0.4) | 0}px monospace`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(String(n), tl.x + sz / 2, tl.y + sz / 2);
        }
      }
    }
    // Grid lines at coarser spacing if we're zoomed out.
    if (gcs * camera.zoom >= 4) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let bx = 0; bx <= gw; bx++) {
        const x = worldToScreen(bx * gcs, 0).x;
        ctx.moveTo(x, wtl.y); ctx.lineTo(x, wbr.y);
      }
      for (let by = 0; by <= gh; by++) {
        const y = worldToScreen(0, by * gcs).y;
        ctx.moveTo(wtl.x, y); ctx.lineTo(wbr.x, y);
      }
      ctx.stroke();
    }
    // HUD label.
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(8, 8, 220, 22);
    ctx.fillStyle = '#9f9';
    ctx.font = '12px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(`[B] bucket viz: ${label}`, 14, 19);
  }

  // Light source glow
  const lcx = CONFIG.worldWidth / 2, lcy = CONFIG.worldHeight / 2;
  const lorb = Math.min(lcx, lcy) * 0.6;
  const lsx = lcx + Math.cos(world.lightSourceAngle) * lorb;
  const lsy = lcy + Math.sin(world.lightSourceAngle) * lorb;
  const lsScreen = worldToScreen(lsx, lsy);
  const lsR = CONFIG.lightSourceRadius * camera.zoom;
  const grad = ctx.createRadialGradient(lsScreen.x, lsScreen.y, 0, lsScreen.x, lsScreen.y, lsR);
  grad.addColorStop(0, 'rgba(255, 255, 100, 0.15)');
  grad.addColorStop(0.5, 'rgba(255, 255, 50, 0.05)');
  grad.addColorStop(1, 'rgba(255, 255, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(lsScreen.x - lsR, lsScreen.y - lsR, lsR * 2, lsR * 2);

  // Photons — fade with age
  for (let p = 0; p < CONFIG.maxPhotons; p++) {
    if (!world.photon_alive[p]) continue;
    const ps = worldToScreen(world.photon_x[p], world.photon_y[p]);
    const ageFade = Math.max(0.5, 1 - world.photon_age[p] / CONFIG.photonLifetime * 0.5);
    ctx.fillStyle = `rgba(255, 255, 150, ${ageFade})`;
    ctx.fillRect(ps.x - 1, ps.y - 1, 2, 2);
  }

  // Free proteins — small diamond (rotated square), no transforms.
  // Selection set captured once outside hot loop; Set.has is O(1).
  const selPSet = selectedFreeProteins;
  const hasSelP = selPSet.size > 0;
  for (let p = 0; p < CONFIG.maxFreeProteins; p++) {
    if (!world.freeP_alive[p]) continue;
    const ps = worldToScreen(world.freeP_x[p], world.freeP_y[p]);
    ctx.fillStyle = PROTEIN_HSL_PLAIN[world.freeP_type[p]];
    // Diamond shape via path (cheap — 4 vertices, no transforms)
    ctx.beginPath();
    ctx.moveTo(ps.x, ps.y - 2.5);
    ctx.lineTo(ps.x + 2, ps.y);
    ctx.lineTo(ps.x, ps.y + 2.5);
    ctx.lineTo(ps.x - 2, ps.y);
    ctx.closePath();
    ctx.fill();
    if (hasSelP && selPSet.has(p)) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
      ctx.strokeRect(ps.x - 5, ps.y - 5, 10, 10);
    }
  }

  // Lineage highlight — build per-frame set of cells carrying any highlighted
  // lineage id. Gated on size so idle cost is zero. Free-chromosome matches are
  // tested inline in that loop (no precompute needed).
  const hlIds = lineageHighlight.ids;
  const hlActive = hlIds.size > 0;
  const hlCellSet = hlActive ? new Set() : null;
  if (hlActive) {
    for (let ci = 0; ci < world.maxCells; ci++) {
      if (!world.alive[ci]) continue;
      const g = world.genomes[ci];
      if (!g) continue;
      for (let c = 0; c < g.length; c++) {
        if (hlIds.has(getLineageId(g[c]))) { hlCellSet.add(ci); break; }
      }
    }
  }
  const HL_COLOR = 'hsl(290, 90%, 65%)';

  // Free chromosomes — small rectangles, axis-aligned (no rotation) for speed.
  // Show gene bands only when they'd actually be visible (bandH >= 1px).
  const czoom = camera.zoom;
  for (let i = 0; i < world.freeChromosomes.length; i++) {
    const fc = world.freeChromosomes[i];
    const ps = worldToScreen(fc.x, fc.y);
    const shape = chromosomeShape(fc.data);
    const hue = (shape * 36) % 360;
    const fade = Math.max(0.3, 1 - fc.age / (CONFIG.freeChromDegradeTicks * fc.data.length + 1));

    const halfW = 3 * czoom;
    const halfH = Math.max(halfW, Math.min(halfW * 3, fc.data.length * 0.4 * czoom));

    // At very low zoom, just a single pixel
    if (halfW < 1) {
      ctx.fillStyle = `hsl(${hue}, 60%, 50%)`;
      ctx.fillRect(ps.x | 0, ps.y | 0, 1, 1);
      continue;
    }

    // Body
    ctx.fillStyle = `hsl(${hue}, 30%, 20%)`;
    ctx.fillRect(ps.x - halfW, ps.y - halfH, halfW * 2, halfH * 2);

    // Gene bands (only if visible and worth drawing)
    const maxBands = Math.min(fc.data.length, Math.floor((halfH * 2) / 1.5));
    if (maxBands >= 2 && halfW > 1.5) {
      const bandH = (halfH * 2) / maxBands;
      const stride = fc.data.length / maxBands;
      const bandW = halfW * 2 - 1;
      const xLeft = ps.x - halfW + 0.5;
      const yTop = ps.y - halfH;
      const data = fc.data;
      for (let b = 0; b < maxBands; b++) {
        const byte = data[(b * stride) | 0];
        ctx.fillStyle = `hsl(${(byte * 1.41) | 0}, 70%, 55%)`;
        ctx.fillRect(xLeft, yTop + b * bandH, bandW, bandH);
      }
    }

    // Border (thin)
    ctx.strokeStyle = `hsl(${hue}, 80%, 70%)`;
    ctx.lineWidth = 0.7;
    ctx.strokeRect(ps.x - halfW, ps.y - halfH, halfW * 2, halfH * 2);

    if (hlActive && hlIds.has(getLineageId(fc.data))) {
      ctx.strokeStyle = HL_COLOR; ctx.lineWidth = 2;
      ctx.strokeRect(ps.x - halfW - 4, ps.y - halfH - 4, halfW * 2 + 8, halfH * 2 + 8);
    }
    if (selectedFreeChroms.has(i)) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.strokeRect(ps.x - halfW - 3, ps.y - halfH - 3, halfW * 2 + 6, halfH * 2 + 6);
    }
  }

  // Draw cells
  for (let i = 0; i < world.maxCells; i++) {
    if (!world.alive[i]) continue;
    const pos = worldToScreen(world.pos_x[i], world.pos_y[i]);
    const r = world.radius[i] * camera.zoom;
    if (r < 1) continue;
    if (pos.x + r < 0 || pos.x - r > canvas.width || pos.y + r < 0 || pos.y - r > canvas.height) continue;

    const hpR = Math.min(1, Math.max(0, world.membraneHP[i] / CONFIG.membraneMaxHP));
    const eR = Math.min(1, Math.max(0, world.energy[i] / 100));

    // --- Cell body first (big circle, most of the radius) ---
    const membraneZone = r * 0.25; // rings only use 25% of outer radius
    const coreR = r - membraneZone;

    // Membrane elongation visualization
    const memProg = world.membraneDividing[i];
    const memCount = world.internalProteins[i * 64 + 19];
    const elongation = memProg > 0 ? 1 + (memProg / CONFIG.divisionTicks) * 0.5
      : (memCount > 0 ? 1 + (memCount / CONFIG.membraneDivisionThreshold) * 0.3 : 1);

    // ============================================================
    // DYNAMIC CELL COLOR
    //   hue        = lineage identity (genome hash) + small drift per generation
    //   saturation = energy (low E -> grey, high E -> vivid)
    //   lightness  = HP (wounded -> dark, healthy -> bright)
    //   modulation:
    //     - dividing cells brighten + saturate
    //     - critical energy (<15%) pulses lightness (visible "dying" heartbeat)
    //     - very young cells (age < 60) get a brightness boost (newborn glow)
    //     - aged cells (past degradation start) shift slightly desaturated
    // ============================================================
    const genome = world.genomes[i];
    let baseHue = 200; // fallback for missing genome
    if (genome && genome[0] && genome[0].length > 0) {
      const g0 = genome[0];
      // Mix first 4 bytes for a stable lineage hue. Multipliers picked to spread hashes.
      let h = (g0[0] | 0) * 73;
      if (g0.length > 1) h += (g0[1] | 0) * 151;
      if (g0.length > 2) h += (g0[2] | 0) * 211;
      if (g0.length > 3) h += (g0[3] | 0) * 17;
      baseHue = h % 360;
      if (baseHue < 0) baseHue += 360;
    }
    // Generation drift: small hue rotation per generation so descendants drift
    // visibly but stay recognizable as the same lineage.
    const gen = world.generation[i];
    let hue = (baseHue + (gen * 3)) % 360;

    // Saturation from energy (35% .. 95%). Starving cells visibly desaturate.
    let sat = 35 + eR * 60;
    // Lightness from HP (15% .. 60%). Dying cells go dark.
    let lit = 15 + hpR * 45;

    // Newborn boost: cells under 60 ticks old glow brighter.
    const age = world.age[i];
    if (age < 60) {
      const youthBoost = (60 - age) / 60; // 1 .. 0
      lit += youthBoost * 18;
      sat += youthBoost * 10;
    }

    // Aging tint: past degradation start, drain saturation slightly so old
    // colonies visually "fade" relative to fresh ones.
    if (age > CONFIG.degradationStartAge) {
      const oldness = Math.min(1, (age - CONFIG.degradationStartAge) / CONFIG.degradationStartAge);
      sat -= oldness * 25;
    }

    // Division flash: brighten and saturate while membrane is elongating.
    if (elongation > 1.01) {
      const divPhase = elongation - 1; // 0 .. ~0.5
      lit += divPhase * 40;
      sat = Math.min(100, sat + divPhase * 30);
    }

    // Critical-energy heartbeat: cells below 15% energy pulse lightness.
    // Uses world.tick directly so all dying cells pulse in sync — easy to spot.
    if (eR < 0.15) {
      const danger = (0.15 - eR) / 0.15; // 0..1
      const pulse = Math.sin(world.tick * 0.25) * 0.5 + 0.5; // 0..1
      lit += danger * pulse * 18;
      // Bleed hue toward red for the most desperate cells (hue interpolation)
      // Pull hue toward 0/360 (red) by up to `danger` amount.
      const targetRed = hue > 180 ? 360 : 0;
      hue = hue + (targetRed - hue) * danger * 0.4;
    }

    // Clamp
    if (sat < 0) sat = 0; else if (sat > 100) sat = 100;
    if (lit < 5) lit = 5; else if (lit > 75) lit = 75;

    const cellFill = `hsl(${hue|0}, ${sat|0}%, ${lit|0}%)`;

    if (elongation > 1.01) {
      ctx.save();
      ctx.translate(pos.x, pos.y);
      ctx.scale(elongation, 1 / elongation);
      ctx.beginPath();
      ctx.arc(0, 0, coreR, 0, Math.PI * 2);
      ctx.fillStyle = cellFill;
      ctx.fill();
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, coreR, 0, Math.PI * 2);
      ctx.fillStyle = cellFill;
      ctx.fill();
    }

    // --- 3 dots inside core, colored by first 3 genome bytes ---
    // Body now carries lineage hue, so dots must contrast: offset by 180°
    // (complementary) plus per-dot rotation, and force high lightness.
    if (coreR > 3) {
      const dotR = Math.max(1.5, coreR * 0.22);
      for (let d = 0; d < 3; d++) {
        const da = d * Math.PI * 2 / 3 - Math.PI / 2;
        const ddist = coreR * 0.4;
        let dotColor = 'rgba(255,255,255,0.55)';
        if (genome && genome[0] && genome[0].length > d) {
          const b = genome[0][d];
          // Complementary hue (+180) + per-dot 40° rotation; high light/sat to pop.
          const dh = ((b * 137) + 180 + d * 40) % 360;
          dotColor = `hsl(${dh}, 85%, 70%)`;
        }
        ctx.beginPath();
        ctx.arc(pos.x + Math.cos(da) * ddist, pos.y + Math.sin(da) * ddist, dotR, 0, Math.PI * 2);
        ctx.fillStyle = dotColor;
        ctx.fill();
      }
    }

    // --- Membrane rings (slot 0): thin bands in the outer 25% ---
    if (membraneZone > 1) {
      const ringThick = membraneZone / NUM_SUBSLOTS;
      for (let ss = 0; ss < NUM_SUBSLOTS; ss++) {
        const si = subIdx(i, 0, ss);
        const pType = world.subslotType[si];
        const pCount = world.subslotCount[si];
        if (pType >= 64 || pCount === 0) continue;

        const outerR = r - ss * ringThick;
        const innerR = outerR - ringThick + 0.3; // small gap between rings

        let fillBucket = (pCount * 10 / MAX_SUB_PROTEINS) | 0;
        if (fillBucket > 9) fillBucket = 9;

        ctx.beginPath();
        ctx.arc(pos.x, pos.y, outerR, 0, Math.PI * 2);
        ctx.arc(pos.x, pos.y, innerR, Math.PI * 2, 0, true);
        ctx.closePath();
        ctx.fillStyle = PROTEIN_HSL_LUT[pType * 10 + fillBucket];
        ctx.fill();
      }
    }

    // --- Special slots (1-6): towers at angular positions ---
    // Gated at r > 10 because below that each stacked subslot is <0.5 px tall
    // and invisible; rendering them costs ~60 arcs/cell for no visual benefit.
    if (r > 10) {
      const towerH = Math.max(3, r * 0.5);
      const towerW = Math.max(2, r * 0.25);
      for (let s = 1; s < NUM_SLOTS; s++) {
        const angle = (s - 1) * (Math.PI * 2 / 6);
        const innerR = r - towerH * 0.35;
        const outerR2 = r + towerH * 0.65;
        const halfAng = Math.atan2(towerW, r);

        // Draw subslots as stacked segments inside the tower
        const segH = (outerR2 - innerR) / NUM_SUBSLOTS;
        let hasAny = false;

        for (let ss = 0; ss < NUM_SUBSLOTS; ss++) {
          const si = subIdx(i, s, ss);
          const pType = world.subslotType[si];
          const pCount = world.subslotCount[si];
          if (pType < 64 && pCount > 0) hasAny = true;

          const segInner = innerR + ss * segH;
          const segOuter = innerR + (ss + 1) * segH;

          ctx.beginPath();
          ctx.arc(pos.x, pos.y, segOuter, angle - halfAng, angle + halfAng);
          ctx.arc(pos.x, pos.y, segInner, angle + halfAng, angle - halfAng, true);
          ctx.closePath();

          if (pType < 64 && pCount > 0) {
            let fb = (pCount * 10 / MAX_SUB_PROTEINS) | 0;
            if (fb > 9) fb = 9;
            ctx.fillStyle = PROTEIN_HSL_LUT[pType * 10 + fb];
            ctx.fill();
          } else {
            ctx.strokeStyle = 'rgba(60,60,60,0.25)';
            ctx.lineWidth = 0.3;
            ctx.stroke();
          }
        }

        // Tower outline
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, outerR2, angle - halfAng, angle + halfAng);
        ctx.arc(pos.x, pos.y, innerR, angle + halfAng, angle - halfAng, true);
        ctx.closePath();
        ctx.strokeStyle = hasAny ? 'rgba(200,200,200,0.3)' : 'rgba(60,60,60,0.2)';
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }
    }

    // Lineage highlight ring — drawn slightly outside the selected-ring radius.
    if (hlCellSet && hlCellSet.has(i)) {
      ctx.beginPath(); ctx.arc(pos.x, pos.y, r + 3.5, 0, Math.PI * 2);
      ctx.strokeStyle = HL_COLOR; ctx.lineWidth = 2; ctx.stroke();
    }
    // Selected
    if (selectedCells.has(i)) {
      ctx.beginPath(); ctx.arc(pos.x, pos.y, r + 2, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    }
    // Dividing
    if (world.dividing[i]) {
      ctx.beginPath(); ctx.arc(pos.x, pos.y, r + 1, 0, Math.PI * 2);
      ctx.strokeStyle = '#ff0'; ctx.lineWidth = 1; ctx.stroke();
    }
    // Membrane dividing (cyan ring)
    if (world.membraneDividing[i]) {
      ctx.beginPath(); ctx.arc(pos.x, pos.y, r + 1.5, 0, Math.PI * 2);
      ctx.strokeStyle = '#0ff'; ctx.lineWidth = 1; ctx.stroke();
    }
    // Replicase active (magenta dot)
    const rjc = world.replicase_activeCount[i];
    if (rjc > 0) {
      // One dot per active job, arranged horizontally above the cell.
      const n = rjc > 6 ? 6 : rjc;
      ctx.fillStyle = '#f0f';
      for (let d = 0; d < n; d++) {
        ctx.beginPath();
        ctx.arc(pos.x + (d - (n - 1) / 2) * 5, pos.y - r - 3, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  if (typeof renderLineage === 'function') renderLineage();
}
