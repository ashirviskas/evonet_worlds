// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// CHROMOSOME EDITOR + LIBRARY + CLIPBOARD
// ============================================================
function parseHexBytes(str) {
  const tokens = str.trim().split(/[\s,\n]+/).filter(Boolean);
  const out = [];
  for (const t of tokens) {
    // Accept "0xNN", "NN", or "#..." comments (skip)
    if (t.startsWith('#') || t.startsWith('//')) return null; // treat as line comment
    const clean = t.replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]{1,2}$/.test(clean)) return null;
    const n = parseInt(clean, 16);
    if (isNaN(n) || n < 0 || n > 255) return null;
    out.push(n);
  }
  return new Uint8Array(out);
}

function parseHexWithComments(str) {
  // Strip comment lines (# ...), join rest
  const clean = str.split('\n').filter(l => !l.trim().startsWith('#')).join(' ');
  return parseHexBytes(clean);
}

let editorCtx = null; // { kind: 'free'|'cell'|'new', cellIdx, chromIdx, onSave }

function editChromosome(kind, idx, chromIdx) {
  let data;
  if (kind === 'free') {
    data = world.freeChromosomes[idx].data;
  } else if (kind === 'cell') {
    data = world.genomes[idx][chromIdx];
  }
  openEditor({ kind, cellIdx: idx, chromIdx, data });
}
window.editChromosome = editChromosome;

function openEditor(ctx) {
  editorCtx = ctx;
  const modal = document.getElementById('editor-modal');
  modal.style.display = 'flex';
  const title = document.getElementById('editor-title');
  const textarea = document.getElementById('editor-hex');
  if (ctx.kind === 'new') {
    title.textContent = 'New Chromosome';
    textarea.value = '';
  } else {
    title.textContent = `Edit ${ctx.kind === 'free' ? 'Free' : 'Cell'} Chromosome`;
    textarea.value = Array.from(ctx.data).map(b => b.toString(16).padStart(2, '0')).join(' ');
  }
  updateEditorDecoded();
}

function updateEditorDecoded() {
  const textarea = document.getElementById('editor-hex');
  const decoded = document.getElementById('editor-decoded');
  const err = document.getElementById('editor-error');
  const parsed = parseHexWithComments(textarea.value);
  if (!parsed) {
    err.textContent = 'Invalid hex — use bytes like "1f 23 a0 05"';
    decoded.textContent = '';
    return null;
  }
  err.textContent = '';
  if (parsed.length === 0) { decoded.textContent = '(empty)'; return parsed; }
  const lines = decodeChromosome(parsed);
  decoded.innerHTML = lines.map(l => `<span style="color:${l.color}">${esc(l.text)}</span>`).join('\n');
  return parsed;
}

document.getElementById('editor-close').addEventListener('click', () => { document.getElementById('editor-modal').style.display = 'none'; });
document.getElementById('editor-hex').addEventListener('input', updateEditorDecoded);
document.getElementById('editor-random').addEventListener('click', () => {
  const len = 32 + Math.floor(Math.random() * 64);
  const bytes = [];
  for (let i = 0; i < len; i++) bytes.push(Math.floor(Math.random() * 256).toString(16).padStart(2, '0'));
  document.getElementById('editor-hex').value = bytes.join(' ');
  updateEditorDecoded();
});
document.getElementById('editor-copy').addEventListener('click', () => {
  const data = updateEditorDecoded();
  if (!data) return;
  const hex = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
  navigator.clipboard.writeText(hex);
});
document.getElementById('editor-save').addEventListener('click', () => {
  const data = updateEditorDecoded();
  if (!data || !editorCtx) return;
  const errEl = document.getElementById('editor-error');
  // Look up the target by original buffer reference, not index — the sim keeps
  // ticking while the modal is open, so indices (free-chromosome array, cell's
  // genome array after division/chromase) can shift out from under us.
  if (editorCtx.kind === 'free') {
    const origBuf = editorCtx.data;
    const idx = world.freeChromosomes.findIndex(fc => fc.data === origBuf);
    if (idx < 0) { errEl.textContent = 'Free chromosome no longer exists (degraded/absorbed)'; return; }
    const fc = world.freeChromosomes[idx];
    lineageMarkDead(fc.data, 'free');
    if (data.length === 0) {
      world.freeChromosomes.splice(idx, 1);
      closeInspectPopup('freeChrom', idx);
    } else {
      const buf = new Uint8Array(data);
      assignLineage(buf, [], 'editor-edit', 'free');
      fc.data = buf;
    }
  } else if (editorCtx.kind === 'cell') {
    if (!world.alive[editorCtx.cellIdx]) { errEl.textContent = 'Cell died — cannot apply edit'; return; }
    const genome = world.genomes[editorCtx.cellIdx];
    if (!genome) { errEl.textContent = 'Cell has no genome'; return; }
    const origBuf = editorCtx.data;
    const idx = genome.indexOf(origBuf);
    if (idx < 0) { errEl.textContent = 'Chromosome no longer in this cell (divided/chromase/replaced)'; return; }
    lineageMarkDead(genome[idx], 'cell');
    if (data.length === 0) {
      genome.splice(idx, 1);
    } else {
      const buf = new Uint8Array(data);
      assignLineage(buf, [], 'editor-edit', 'cell');
      genome[idx] = buf;
    }
  } else if (editorCtx.kind === 'new') {
    // Spawn as free chromosome in world center
    assignLineage(data, [], 'library-spawn', 'free');
    spawnFreeChromosome(world.rng.nextRange(200, CONFIG.worldWidth - 200), world.rng.nextRange(200, CONFIG.worldHeight - 200), data, 'sameFree');
  }
  document.getElementById('editor-modal').style.display = 'none';
  updateInspect();
});
document.getElementById('editor-save-to-lib').addEventListener('click', () => {
  const data = updateEditorDecoded();
  if (!data) return;
  const name = prompt('Name for this chromosome:', `chrom_${Date.now().toString(36)}`);
  if (!name) return;
  saveToLibrary(name, data);
});

// Library (localStorage, per seed)
function libraryKey() { return `evosim_library_seed_${CONFIG.seed}`; }
function loadLibrary() {
  try {
    const raw = localStorage.getItem(libraryKey());
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}
function saveLibraryObj(obj) {
  try { localStorage.setItem(libraryKey(), JSON.stringify(obj)); } catch (e) { alert('Save failed: ' + e.message); }
}
function saveToLibrary(name, data) {
  const lib = loadLibrary();
  lib[name] = { hex: Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' '), savedAt: Date.now() };
  saveLibraryObj(lib);
}
function saveChromToLibrary(kind, idx, chromIdx) {
  let data;
  if (kind === 'free') data = world.freeChromosomes[idx].data;
  else if (kind === 'cell') data = world.genomes[idx][chromIdx];
  if (!data) return;
  const name = prompt('Name for this chromosome:', `chrom_${Date.now().toString(36)}`);
  if (!name) return;
  saveToLibrary(name, data);
}
window.saveChromToLibrary = saveChromToLibrary;

// Seed-specific library preloads — known interesting chromosomes populated on
// first load so new users have a starting point without needing to import.
const LIBRARY_PRESETS = {
  42: {
    natural_survivor: '45 53 a8 14 43 16 13 b1 49 c0 35 7f b4 f4 03 5b 11 4f 33 25 e6 fb 84 f6',
  },
};
(function preloadLibraryDefaults() {
  const presets = LIBRARY_PRESETS[CONFIG.seed];
  if (!presets) return;
  const lib = loadLibrary();
  let changed = false;
  for (const [name, hex] of Object.entries(presets)) {
    if (!lib[name]) { lib[name] = { hex, savedAt: Date.now() }; changed = true; }
  }
  if (changed) saveLibraryObj(lib);
})();

function copyFreeChromToClipboard(idx) {
  const fc = world.freeChromosomes[idx];
  if (!fc) return;
  const hex = Array.from(fc.data).map(b => b.toString(16).padStart(2, '0')).join(' ');
  navigator.clipboard.writeText(hex);
}
window.copyFreeChromToClipboard = copyFreeChromToClipboard;

function ejectChromosome(cellIdx, chromIdx) {
  const genome = world.genomes[cellIdx];
  if (!genome || chromIdx >= genome.length) return;
  const chrom = genome[chromIdx];
  spawnFreeChromosome(world.pos_x[cellIdx], world.pos_y[cellIdx], chrom, 'cellToFree');
  genome.splice(chromIdx, 1);
  if (world.ribo_chromIdx[cellIdx] >= genome.length) { world.ribo_chromIdx[cellIdx] = 0; world.ribo_offset[cellIdx] = 0; }
  world.milestones.chromEjections++;
  updateInspect();
}
window.ejectChromosome = ejectChromosome;

function renderLibrary() {
  const lib = loadLibrary();
  document.getElementById('library-seed').textContent = CONFIG.seed;
  const list = document.getElementById('library-list');
  const names = Object.keys(lib).sort();
  if (names.length === 0) {
    list.innerHTML = '<div style="color:#666; font-style:italic;">(empty — save chromosomes from the editor or inspector)</div>';
    return;
  }
  list.innerHTML = names.map(name => {
    const entry = lib[name];
    const bytes = entry.hex.split(/\s+/).length;
    const en = esc(name);
    return `<div style="display:flex; gap:4px; align-items:center; padding:4px; border:1px solid #333; border-radius:3px;">
      <span style="flex:1; font-size:11px;">${en} <span style="color:#666;">(${bytes} bytes)</span></span>
      <button data-lib-action="edit" data-name="${en}" style="font-size:10px; padding:2px 6px;">Edit</button>
      <button data-lib-action="spawn-free" data-name="${en}" style="font-size:10px; padding:2px 6px;">Spawn free</button>
      <button data-lib-action="spawn-org" data-name="${en}" style="font-size:10px; padding:2px 6px;">Spawn organism</button>
      <button data-lib-action="delete" data-name="${en}" style="font-size:10px; padding:2px 6px; background:#532;">Del</button>
    </div>`;
  }).join('');
}

// Library click delegation (on stable parent)
document.getElementById('library-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-lib-action]');
  if (!btn) return;
  const action = btn.dataset.libAction;
  const name = btn.dataset.name;
  if (action === 'edit') libraryLoadToEditor(name);
  else if (action === 'spawn-free') librarySpawnFree(name);
  else if (action === 'spawn-org') librarySpawnOrganism(name);
  else if (action === 'delete') libraryDelete(name);
});
window.libraryLoadToEditor = function(name) {
  const lib = loadLibrary();
  const entry = lib[name]; if (!entry) return;
  const data = parseHexBytes(entry.hex); if (!data) return;
  document.getElementById('library-modal').style.display = 'none';
  openEditor({ kind: 'new', data });
  document.getElementById('editor-hex').value = entry.hex;
  updateEditorDecoded();
};
window.librarySpawnFree = function(name) {
  const lib = loadLibrary();
  const entry = lib[name]; if (!entry) return;
  const data = parseHexBytes(entry.hex); if (!data) return;
  assignLineage(data, [], 'library-spawn', 'free');
  spawnFreeChromosome(world.rng.nextRange(200, CONFIG.worldWidth - 200), world.rng.nextRange(200, CONFIG.worldHeight - 200), data, 'sameFree');
};
window.librarySpawnOrganism = function(name) {
  const lib = loadLibrary();
  const entry = lib[name]; if (!entry) return;
  const data = parseHexBytes(entry.hex); if (!data) return;
  spawnOrganismWithChromosome(data);
};
window.libraryDelete = function(name) {
  if (!confirm(`Delete "${name}"?`)) return;
  const lib = loadLibrary();
  delete lib[name];
  saveLibraryObj(lib);
  renderLibrary();
};

function spawnOrganismWithChromosome(data) {
  const idx = spawnCell(world.rng.nextRange(100, CONFIG.worldWidth - 100), world.rng.nextRange(100, CONFIG.worldHeight - 100), -1, 0);
  if (idx < 0) return -1;
  // spawnCell seeded one random chromosome + lineage node; retire it before replacing.
  const prior = world.genomes[idx];
  if (prior) for (const c of prior) lineageMarkDead(c, 'cell');
  const chrom = new Uint8Array(data);
  world.genomes[idx] = [chrom];
  assignLineage(chrom, [], 'library-spawn', 'cell');
  world.energy[idx] = CONFIG.initialEnergy * 2;
  return idx;
}
window.spawnOrganismWithChromosome = spawnOrganismWithChromosome;

// Event delegation for inspector buttons. Each inspect popup wires this onto
// its own .inspect-body via openInspectPopup. We use mousedown on the body
// rather than click on the buttons so DOM-replacement (innerHTML rewrite per
// tick) doesn't drop in-flight clicks.
function inspectActionDelegate(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  e.preventDefault();
  const action = btn.dataset.action;
  const kind = btn.dataset.kind;
  const cellIdx = btn.dataset.cell ? parseInt(btn.dataset.cell) : -1;
  const chromIdx = btn.dataset.chrom ? parseInt(btn.dataset.chrom) : -1;
  const idx = btn.dataset.idx ? parseInt(btn.dataset.idx) : -1;
  if (action === 'edit') {
    if (kind === 'free') editChromosome('free', idx, 0);
    else editChromosome('cell', cellIdx, chromIdx);
  } else if (action === 'save-lib') {
    if (kind === 'free') saveChromToLibrary('free', idx, 0);
    else saveChromToLibrary('cell', cellIdx, chromIdx);
  } else if (action === 'eject') {
    ejectChromosome(cellIdx, chromIdx);
  } else if (action === 'copy-free') {
    copyFreeChromToClipboard(idx);
  } else if (action === 'jump-lineage') {
    let chrom = null;
    if (kind === 'free') {
      const fc = world.freeChromosomes[idx];
      if (fc) chrom = fc.data;
    } else {
      const g = world.genomes[cellIdx];
      if (g) chrom = g[chromIdx];
    }
    const lid = chrom ? getLineageId(chrom) : -1;
    if (lid > 0) jumpToLineage(lid);
  } else if (action === 'kill') {
    if (cellIdx >= 0 && world.alive[cellIdx]) {
      killCell(cellIdx);
      // Closes the popup for this cell (selection cleanup happens there).
      closeInspectPopup('cell', cellIdx);
      render(); updateStats(); updateInspect();
    }
  } else if (action === 'divide') {
    if (cellIdx >= 0 && world.alive[cellIdx]) {
      divideCell(cellIdx);
      render(); updateStats(); updateInspect();
    }
  }
}

document.getElementById('btn-library').addEventListener('click', () => {
  const modal = document.getElementById('library-modal');
  modal.style.display = 'flex';
  renderLibrary();
});
document.getElementById('library-close').addEventListener('click', () => { document.getElementById('library-modal').style.display = 'none'; });
document.getElementById('library-clear').addEventListener('click', () => {
  if (!confirm(`Clear ALL chromosomes for seed ${CONFIG.seed}?`)) return;
  localStorage.removeItem(libraryKey());
  renderLibrary();
});
document.getElementById('library-export').addEventListener('click', () => {
  const lib = loadLibrary();
  navigator.clipboard.writeText(JSON.stringify(lib, null, 2));
});

document.getElementById('btn-new-chrom').addEventListener('click', () => { openEditor({ kind: 'new', data: new Uint8Array(0) }); });
document.getElementById('btn-spawn-from-clip').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    const data = parseHexWithComments(text);
    if (!data || data.length === 0) { alert('Clipboard does not contain valid hex bytes'); return; }
    spawnOrganismWithChromosome(data);
  } catch (e) { alert('Clipboard read failed: ' + e.message); }
});
document.getElementById('btn-free-from-clip').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    const data = parseHexWithComments(text);
    if (!data || data.length === 0) { alert('Clipboard does not contain valid hex bytes'); return; }
    assignLineage(data, [], 'library-spawn', 'free');
    spawnFreeChromosome(world.rng.nextRange(200, CONFIG.worldWidth - 200), world.rng.nextRange(200, CONFIG.worldHeight - 200), data, 'sameFree');
  } catch (e) { alert('Clipboard read failed: ' + e.message); }
});
