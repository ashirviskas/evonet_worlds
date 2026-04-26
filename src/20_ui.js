// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// UI
// ============================================================
function updateStats() {
  const el = document.getElementById('stats');
  let totalE = 0, n = 0;
  for (let i = 0; i < world.maxCells; i++) if (world.alive[i]) { n++; totalE += world.energy[i]; }
  const tpsStr = (typeof currentTps !== 'undefined') ? currentTps.toFixed(1) : '—';
  el.innerHTML = `Tick: ${world.tick} | TPS: ${tpsStr}<br>Cells: ${n}<br>Total Energy: ${totalE.toFixed(1)}<br>Avg Energy: ${n ? (totalE / n).toFixed(1) : 0}<br>Photons: ${world.photonCount}<br>Free proteins: ${world.freePCount}<br>Free chroms: ${world.freeChromosomes.length}<br>Replicase: ${world.milestones.replicaseCompleted}ok/${world.milestones.replicaseFailed}fail<br>Memb divs: ${world.milestones.membraneDivisions} | Absorb: ${world.milestones.chromAbsorptions}`;
}

function updateMilestones() {
  const el = document.getElementById('milestones');
  const m = world.milestones;
  const items = [
    { done: m.cellReached500 > 0, label: 'Cell reached 500 energy', count: m.cellReached500 },
    { done: m.cellMakingDivider > 0, label: 'Cell producing divider', count: m.cellMakingDivider },
    { done: m.divisionsTotal > 0, label: 'Division occurred', count: m.divisionsTotal },
    { done: m.threeGenLineage >= 3, label: '3+ gen lineage', count: m.threeGenLineage > 0 ? 'gen ' + m.threeGenLineage : 0 },
    { done: m.cellSurvived10k > 0, label: 'Cell survived 10k', count: m.cellSurvived10k },
    { done: m.maxPopulation >= 50, label: 'Pop reached 50+', count: 'max: ' + m.maxPopulation },
    { done: m.cellMoved > 0, label: 'Cell self-propelled', count: m.cellMoved },
    { done: m.photonsAbsorbed > 0, label: 'Photons absorbed', count: m.photonsAbsorbed },
    { done: m.membraneDivisions > 0, label: 'Membrane division', count: m.membraneDivisions },
    { done: m.replicaseCompleted > 0, label: 'Replicase success', count: m.replicaseCompleted },
    { done: m.chromAbsorptions > 0, label: 'Chrom absorbed', count: m.chromAbsorptions },
    { done: m.chromEjections > 0, label: 'Chrom ejected', count: m.chromEjections },
  ];
  let h = '<b style="color:#8af">Milestones</b><br>';
  for (const it of items) {
    h += `${it.done ? '<span class="ms-check">[v]</span>' : '<span class="ms-uncheck">[ ]</span>'} ${it.label} <span class="ms-count">(${it.count})</span><br>`;
  }
  el.innerHTML = h;
}

function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); }
function proteinTip(info) { return `<span class='tip-title'>${esc(info.name)}</span>\n<span class='tip-desc'>${esc(info.desc)}</span>`; }
function proteinBadge(type, showCount) {
  const info = PROTEIN_INFO[type];
  const label = showCount !== undefined ? `${type}x${showCount}` : type;
  return `<span class="protein-badge" style="background:${info.color}; color:#000" data-tip="${proteinTip(info)}">${label}</span>`;
}

// ============================================================
// MULTI-INSPECT POPUPS
//
// Multiple popups can be open at once (one per inspected entity). Plain
// canvas-click swaps the selection (closes others); shift/ctrl/cmd-click
// adds a popup alongside the current ones.
//
// State map keys popups by `${kind}:${idx}` so a re-click on an already-
// inspected entity just brings its popup to front.
// ============================================================
const inspectPopups = new Map(); // `${kind}:${idx}` -> { el, kind, idx }
let inspectZTop = 150;
const INSPECT_POPUP_CAP = 12;

function popupKey(kind, idx) { return kind + ':' + idx; }

function bringInspectToFront(rec) {
  inspectZTop++;
  rec.el.style.zIndex = String(inspectZTop);
}

function openInspectPopup(kind, idx) {
  if (idx < 0) return;
  const k = popupKey(kind, idx);
  const existing = inspectPopups.get(k);
  if (existing) { bringInspectToFront(existing); updateInspectPopup(existing); return; }
  // Cap: silently close oldest. Map iteration order is insertion order.
  if (inspectPopups.size >= INSPECT_POPUP_CAP) {
    const [oldest] = inspectPopups.keys();
    const [ok, oi] = oldest.split(':');
    closeInspectPopup(ok, +oi);
  }
  const el = document.createElement('div');
  el.className = 'inspect-popup';
  el.style.display = 'flex';
  el.style.flexDirection = 'column';
  const w = Math.min(420, window.innerWidth - 60);
  const h = Math.min(560, window.innerHeight - 80);
  const rightPanel = document.getElementById('panel');
  const rpr = rightPanel ? rightPanel.getBoundingClientRect() : { left: window.innerWidth };
  // Cascade so a flurry of shift-clicks doesn't stack at one spot.
  const off = inspectPopups.size * 24;
  el.style.width = w + 'px';
  el.style.height = h + 'px';
  el.style.left = Math.max(20, rpr.left - w - 20 - off) + 'px';
  el.style.top = (60 + off) + 'px';
  inspectZTop++;
  el.style.zIndex = String(inspectZTop);
  el.innerHTML =
    `<div class="inspect-title-bar">` +
      `<span class="inspect-title">…</span>` +
      `<span style="flex:1;"></span>` +
      `<button class="inspect-close">✕</button>` +
    `</div>` +
    `<div class="inspect-body"></div>`;
  document.getElementById('inspect-popups').appendChild(el);
  const rec = { el, kind, idx };
  inspectPopups.set(k, rec);

  el.querySelector('.inspect-close').addEventListener('click', () => closeInspectPopup(kind, idx));
  // Bring to front on any mousedown anywhere in the popup (capture so child clicks still register the bring).
  el.addEventListener('mousedown', () => bringInspectToFront(rec), true);
  if (typeof makeDraggable === 'function') makeDraggable(el, el.querySelector('.inspect-title-bar'));
  // Per-popup body action delegation. Defined in 23_editor_library.js.
  if (typeof inspectActionDelegate === 'function') {
    el.querySelector('.inspect-body').addEventListener('mousedown', inspectActionDelegate);
  }
  updateInspectPopup(rec);
}

function closeInspectPopup(kind, idx) {
  const k = popupKey(kind, idx);
  const rec = inspectPopups.get(k);
  if (!rec) return;
  rec.el.remove();
  inspectPopups.delete(k);
  if (kind === 'cell') {
    selectedCells.delete(idx);
    if (selectedCell === idx) selectedCell = -1;
  } else if (kind === 'freeChrom') {
    selectedFreeChroms.delete(idx);
    if (selectedFreeChrom === idx) selectedFreeChrom = -1;
  } else if (kind === 'freeProtein') {
    selectedFreeProteins.delete(idx);
    if (selectedFreeProtein === idx) selectedFreeProtein = -1;
  }
}

function closeAllInspectPopups() {
  for (const k of [...inspectPopups.keys()]) {
    const [kind, idx] = k.split(':');
    closeInspectPopup(kind, +idx);
  }
}

// updateInspect: refresh every open popup's body (called every tick + on
// explicit user actions). Live entities re-render; dead entities auto-close.
function updateInspect() {
  for (const rec of [...inspectPopups.values()]) updateInspectPopup(rec);
}

function updateInspectPopup(rec) {
  const { el, kind, idx } = rec;
  const titleEl = el.querySelector('.inspect-title');
  const bodyEl  = el.querySelector('.inspect-body');
  if (kind === 'freeProtein') {
    if (idx < 0 || !world.freeP_alive[idx]) { closeInspectPopup(kind, idx); return; }
    const info = PROTEIN_INFO[world.freeP_type[idx]];
    titleEl.textContent = `Free Protein #${idx}`;
    bodyEl.innerHTML = `Type: ${proteinBadge(world.freeP_type[idx])} ${esc(info.name)}<br>` +
      `Pos: (${world.freeP_x[idx].toFixed(1)}, ${world.freeP_y[idx].toFixed(1)})<br>` +
      `Vel: (${world.freeP_vx[idx].toFixed(3)}, ${world.freeP_vy[idx].toFixed(3)})<br>` +
      `Decay rate: ${CONFIG.freeProteinDecayRate}<br>` +
      `<span style="color:#888">${esc(info.desc)}</span>`;
    return;
  }
  if (kind === 'freeChrom') {
    if (idx < 0 || idx >= world.freeChromosomes.length) { closeInspectPopup(kind, idx); return; }
    const fc = world.freeChromosomes[idx];
    titleEl.textContent = `Free Chromosome #${idx}`;
    let h = `Shape: ${chromosomeShape(fc.data)} | Length: ${fc.data.length} bytes<br>`;
    h += `Pos: (${fc.x.toFixed(1)}, ${fc.y.toFixed(1)})<br>`;
    h += `Age: ${fc.age} | Degrades every ${CONFIG.freeChromDegradeTicks} ticks<br>`;
    h += `<div style="display:flex; gap:4px; margin-top:4px; flex-wrap:wrap;">`;
    h += `<button data-action="edit" data-kind="free" data-idx="${idx}" style="font-size:10px; padding:2px 6px;">Edit</button>`;
    h += `<button data-action="copy-free" data-idx="${idx}" style="font-size:10px; padding:2px 6px;">Copy</button>`;
    h += `<button data-action="save-lib" data-kind="free" data-idx="${idx}" style="font-size:10px; padding:2px 6px;">Save to library</button>`;
    if (getLineageId(fc.data) > 0) {
      h += `<button data-action="jump-lineage" data-kind="free" data-idx="${idx}" style="font-size:10px; padding:2px 6px;">Lineage</button>`;
    }
    h += `</div>`;
    h += renderDnaFull(fc.data, 'DNA');
    bodyEl.innerHTML = h;
    return;
  }
  // kind === 'cell'
  if (idx < 0 || !world.alive[idx]) { closeInspectPopup(kind, idx); return; }
  const i = idx;
  titleEl.textContent = `Cell #${i} (gen ${world.generation[i]})`;
  let h = '';
  h += `<div style="display:flex; gap:4px; margin-bottom:4px;">`;
  h += `<button data-action="divide" data-cell="${i}" style="font-size:10px; padding:2px 6px;">Force Divide</button>`;
  h += `<button data-action="kill" data-cell="${i}" style="font-size:10px; padding:2px 6px; background:#3a1818; border-color:#622;">Kill Cell</button>`;
  h += `</div>`;
  h += `Pos: (${world.pos_x[i].toFixed(1)}, ${world.pos_y[i].toFixed(1)})<br>`;
  h += `Energy: ${world.energy[i].toFixed(1)} / ${CONFIG.energyCap}${world.energy[i] <= 0 ? ' <span style="color:#f88">[FROZEN]</span>' : ''}<br>`;
  const stored = cellTotalProteinCount(i, 36);
  const empty = cellTotalProteinCount(i, 35);
  if (stored > 0 || empty > 0) {
    h += `<span style="color:#888">Storage: <span style="color:#8f8">${stored} stored</span> / <span style="color:#aaa">${empty} empty</span></span><br>`;
  }
  h += `Membrane HP: ${world.membraneHP[i].toFixed(1)} / ${CONFIG.membraneMaxHP}<br>`;
  h += `Age: ${world.age[i]}<br>`;
  const dr = getCellDegradationRate(i);
  h += `DNA deg: ${dr > 0 ? dr.toFixed(6) : 'none'}<br>`;
  h += `Parent: ${world.parentId[i]} | Vel: (${world.vel_x[i].toFixed(2)}, ${world.vel_y[i].toFixed(2)})<br>`;
  h += `Dividing: ${world.dividing[i] ? world.dividing[i] + '/' + CONFIG.divisionTicks : 'no'}<br>`;
  h += `Memb div: ${world.membraneDividing[i] ? world.membraneDividing[i] + '/' + CONFIG.divisionTicks : 'no'} (memb: ${world.internalProteins[i * 64 + 19]}/${CONFIG.membraneDivisionThreshold})<br>`;
  if (world.replicase_activeCount[i] > 0) {
    h += `Replicase: ${world.replicase_activeCount[i]} job(s)<br>`;
    for (let s = 0; s < CONFIG.maxReplicaseJobs; s++) {
      if (!world.replicase_job_alive[s] || world.replicase_job_cellIdx[s] !== i) continue;
      h += `&nbsp;&nbsp;shape ${world.replicase_job_targetShape[s]}, ${world.replicase_job_progress[s]}b, ${world.replicase_job_ticksLeft[s]} ticks left<br>`;
    }
  }

  // Ribosome
  h += `<br><b>Ribosome</b><br>`;
  h += `Chrom: ${world.ribo_chromIdx[i]}, Off: ${world.ribo_offset[i]}`;
  h += world.ribo_holding[i] ? ` | Hold: 0x${world.ribo_heldOpcode[i].toString(16).padStart(2,'0')}` : '';
  h += world.ribo_searchMode[i] ? ` | Search: 0x${world.ribo_searchByte[i].toString(16).padStart(2,'0')} (${world.ribo_searchTicks[i]})` : '';
  h += '<br>';

  // Slots — each slot is a horizontal row of 10 subslot cells
  h += `<br><b>Slots</b><br>`;
  const slotNames = ['Memb', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
  for (let s = 0; s < NUM_SLOTS; s++) {
    const isOpen = world.slotOpen[i * NUM_SLOTS + s];
    h += `<div style="display:flex; align-items:center; gap:3px; margin:2px 0;${isOpen ? '' : ' opacity:0.3'}">`;
    h += `<span style="width:32px; font-weight:bold; flex-shrink:0; font-size:10px">${slotNames[s]}${isOpen ? '' : '*'}</span>`;
    for (let ss = 0; ss < NUM_SUBSLOTS; ss++) {
      const si = subIdx(i, s, ss);
      const pt = world.subslotType[si], cnt = world.subslotCount[si];
      if (pt < 64 && cnt > 0) {
        const info = PROTEIN_INFO[pt];
        h += `<span style="width:24px; height:18px; display:inline-flex; align-items:center; justify-content:center; background:${info.color}; color:#000; font-size:8px; border-radius:2px; cursor:default" data-tip="${proteinTip(info)}\nx${cnt}">${cnt}</span>`;
      } else {
        h += `<span style="width:24px; height:18px; display:inline-flex; align-items:center; justify-content:center; background:#1a1a1a; border:1px solid #333; border-radius:2px; font-size:8px; color:#444">-</span>`;
      }
    }
    h += `</div>`;
  }

  // Cytoplasm
  h += `<br><b>Cytoplasm</b><br><div style="display:flex; flex-wrap:wrap; gap:2px;">`;
  for (let t = 0; t < 64; t++) {
    const c = world.internalProteins[i * 64 + t];
    const info = PROTEIN_INFO[t];
    if (c > 0) {
      h += `<span class="protein-badge" style="background:${info.color}; color:#000; min-width:28px; text-align:center" data-tip="${proteinTip(info)}">${t}:${c}</span>`;
    } else {
      h += `<span class="protein-badge" style="background:#222; color:#444; min-width:28px; text-align:center; border:1px solid #333" data-tip="${proteinTip(info)}">${t}</span>`;
    }
  }
  h += `</div>`;

  // Genome
  h += `<br><b>Genome</b> `;
  const genome = world.genomes[i];
  if (genome) {
    h += `(${genome.length} chrom)<br>`;
    for (let c = 0; c < genome.length; c++) {
      const chrom = genome[c];
      h += `<div style="margin:4px 0; padding:3px; border:1px solid #2a2a2a; border-radius:3px;">`;
      h += `<div style="display:flex; gap:4px; flex-wrap:wrap; margin-bottom:2px;">`;
      h += `<button data-action="edit" data-kind="cell" data-cell="${i}" data-chrom="${c}" style="font-size:10px; padding:1px 5px;">Edit</button>`;
      h += `<button data-action="save-lib" data-kind="cell" data-cell="${i}" data-chrom="${c}" style="font-size:10px; padding:1px 5px;">Save</button>`;
      h += `<button data-action="eject" data-cell="${i}" data-chrom="${c}" style="font-size:10px; padding:1px 5px;">Eject</button>`;
      if (getLineageId(chrom) > 0) {
        h += `<button data-action="jump-lineage" data-kind="cell" data-cell="${i}" data-chrom="${c}" style="font-size:10px; padding:1px 5px;">Lineage</button>`;
      }
      h += `</div>`;
      const ribOff = (world.ribo_chromIdx[i] === c) ? world.ribo_offset[i] : -1;
      h += renderDnaFull(chrom, `[${c}]`, ribOff);
      h += `</div>`;
    }
  }

  bodyEl.innerHTML = h;
}

// Esc closes the most-recently-opened popup. Repeated Esc walks back through
// the stack. Map iteration order is insertion order, so the last entry is the
// most recent.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (inspectPopups.size === 0) return;
  const active = document.activeElement;
  const tag = active && active.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  let lastKey = null;
  for (const k of inspectPopups.keys()) lastKey = k;
  if (!lastKey) return;
  const [kind, idx] = lastKey.split(':');
  closeInspectPopup(kind, +idx);
});

function buildProteinLegend() {
  const el = document.getElementById('protein-legend');
  let h = '';
  for (let i = 0; i < 64; i++) {
    const info = PROTEIN_INFO[i];
    h += `<div class="legend-swatch" style="background:${info.color}" data-tip="${proteinTip(info)}">${i}</div>`;
  }
  el.innerHTML = h;
}
