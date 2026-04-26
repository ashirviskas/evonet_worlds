// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// SAVE / LOAD WORLD
// ============================================================
// Snapshot the full simulation state to a downloadable JSON file, and restore
// it later. Typed arrays are base64-encoded as raw bytes. Genomes and free
// chromosomes carry their own lineage ids so the WeakMap chromToId can be
// rebuilt without path-walking. Spatial grids are NOT saved — they're rebuilt
// from positions via the existing rebuildGrid / rebuildFreeProteinGrid helpers.

const SAVE_VERSION = 1;

const TA_CTORS = { Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float32Array, Float64Array };

function _encTA(v) {
  if (v == null) return null;
  const u8 = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let s = '';
  const C = 0x8000;
  for (let i = 0; i < u8.length; i += C) s += String.fromCharCode.apply(null, u8.subarray(i, i + C));
  return { _ta: v.constructor.name, b64: btoa(s) };
}

function _decTA(e) {
  if (e == null) return null;
  const Ctor = TA_CTORS[e._ta];
  if (!Ctor) throw new Error(`Unknown typed-array class: ${e._ta}`);
  const bin = atob(e.b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Ctor(u8.buffer, u8.byteOffset, u8.byteLength / Ctor.BYTES_PER_ELEMENT);
}

// Explicit list of world.* typed-array fields that we round-trip. Anything not
// in this list is either a scalar (handled below) or rebuildable (grids).
const WORLD_TA_FIELDS = [
  'alive', 'pos_x', 'pos_y', 'vel_x', 'vel_y',
  'radius', 'energy', 'membraneHP', 'age', 'parentId', 'generation',
  'subslotType', 'subslotCount', 'slotOpen', 'internalProteins',
  'cytoOccMask', 'subslotOccMask', 'slotTypeCount',
  'decayNextCyto', 'decayNextSub',
  'ribo_chromIdx', 'ribo_offset', 'ribo_holding', 'ribo_heldOpcode',
  'ribo_searchMode', 'ribo_searchByte', 'ribo_searchTicks', 'ribo_tickCounter',
  'dividing',
  'interactionLeft', 'interactionRight', 'decayRates', 'energyField',
  'photon_x', 'photon_y', 'photon_vx', 'photon_vy', 'photon_alive', 'photon_age', 'photon_energy',
  'photonLive', 'photonLiveIdx',
  'freeP_x', 'freeP_y', 'freeP_vx', 'freeP_vy', 'freeP_type', 'freeP_alive',
  'freePLive', 'freePLiveIdx', 'freePGridIdx',
  'cellGridIdx',
  'replicase_job_alive', 'replicase_job_cellIdx', 'replicase_job_sourceIdx',
  'replicase_job_targetShape', 'replicase_job_progress', 'replicase_job_ticksLeft',
  'replicase_job_phase', 'replicase_job_holding', 'replicase_job_heldOpcode',
  'replicase_job_scanStart', 'replicase_job_scanRemaining',
  'replicase_activeCount', 'membraneDividing',
];

const WORLD_SCALAR_FIELDS = [
  'tick', 'numCells', 'maxCells',
  'photonCount', 'photonLiveCount',
  'freePCount', 'freePLiveCount',
  'replicase_nextSlot',
  'lightSourceAngle',
  'gridCellSize', 'gridW', 'gridH',
  'energyFieldW', 'energyFieldH',
];

function _normLineageNode(n) {
  const out = {};
  for (const k in n) {
    const v = n[k];
    if (v == null) out[k] = v;
    else if (v instanceof Uint8Array) out[k] = _encTA(v);
    else if (v instanceof Set) out[k] = Array.from(v);
    else if (v instanceof Map) out[k] = Array.from(v.entries());
    else out[k] = v;
  }
  return out;
}

function _denormLineageNode(n) {
  const out = {};
  for (const k in n) {
    const v = n[k];
    if (v && typeof v === 'object' && v._ta) out[k] = _decTA(v);
    else out[k] = v;
  }
  return out;
}

function serializeWorld() {
  const wSnap = { ta: {}, scalar: {} };
  for (const k of WORLD_TA_FIELDS) wSnap.ta[k] = _encTA(world[k]);
  for (const k of WORLD_SCALAR_FIELDS) wSnap.scalar[k] = world[k];
  wSnap.milestones = { ...world.milestones };

  // Genomes: per-cell array of chromosomes, each with bytes + carried lineage id.
  wSnap.genomes = world.genomes.map(g => g ? g.map(ch => {
    const enc = _encTA(ch);
    enc.lineageId = getLineageId(ch);
    return enc;
  }) : null);

  // Free chromosomes.
  wSnap.freeChromosomes = world.freeChromosomes.map(fc => {
    const enc = _encTA(fc.data);
    enc.lineageId = getLineageId(fc.data);
    return { x: fc.x, y: fc.y, vx: fc.vx, vy: fc.vy, age: fc.age, data: enc };
  });

  // Replicase per-job variable-length state.
  wSnap.replicase_job_output = world.replicase_job_output.map(x => x == null ? null : Array.from(x));
  wSnap.replicase_job_sourceRef = world.replicase_job_sourceRef.map(x => x == null ? null : _encTA(x));
  wSnap.replicase_job_sourceBytes = world.replicase_job_sourceBytes.map(x => x == null ? null : Array.from(x.entries()));

  const lSnap = {
    nextId: lineage.nextId,
    structVersion: lineage.structVersion,
    nodes: Array.from(lineage.nodes.entries()).map(([id, n]) => [id, _normLineageNode(n)]),
    children: Array.from(lineage.children.entries()).map(([id, set]) => [id, Array.from(set)]),
    redirects: Array.from(lineage.redirects.entries()),
  };

  return {
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    tick: world.tick,
    config: { ...CONFIG },
    rngState: world.rng.getState ? world.rng.getState() : null,
    camera: { x: camera.x, y: camera.y, zoom: camera.zoom },
    selectedCell,
    world: wSnap,
    lineage: lSnap,
  };
}

function downloadWorld() {
  const snap = serializeWorld();
  const json = JSON.stringify(snap);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `evo_world_tick${world.tick}_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  console.log(`Saved ${(json.length / 1048576).toFixed(2)} MB  ·  ${a.download}`);
}

async function loadWorldFromFile(file) {
  const text = await file.text();
  const snap = JSON.parse(text);
  if (snap.version !== SAVE_VERSION) throw new Error(`Unknown save version: ${snap.version}`);

  running = false;

  // 1. CONFIG first.
  Object.assign(CONFIG, snap.config);

  // 2. World typed arrays + scalars.
  for (const k of WORLD_TA_FIELDS) {
    if (snap.world.ta[k] != null) world[k] = _decTA(snap.world.ta[k]);
  }
  for (const k of WORLD_SCALAR_FIELDS) {
    if (snap.world.scalar[k] !== undefined) world[k] = snap.world.scalar[k];
  }
  world.milestones = { ...snap.world.milestones };

  // 3. Genomes + free chromosomes.
  world.genomes = snap.world.genomes.map(g => g ? g.map(ch => _decTA(ch)) : null);
  world.freeChromosomes = snap.world.freeChromosomes.map(fc => ({
    x: fc.x, y: fc.y, vx: fc.vx, vy: fc.vy, age: fc.age, data: _decTA(fc.data),
  }));

  // 4. Replicase variable-length job state.
  world.replicase_job_output    = snap.world.replicase_job_output.map(x => x == null ? null : x.slice());
  world.replicase_job_sourceRef = snap.world.replicase_job_sourceRef.map(x => x == null ? null : _decTA(x));
  world.replicase_job_sourceBytes = snap.world.replicase_job_sourceBytes.map(x => x == null ? null : new Map(x));

  // 5. Lineage. Wipe stale UI state (highlight, view selection, popup) before
  // restoring snapshot — otherwise prior-run ids dangle in the renderer. After
  // reset, reassign lineage members from the snapshot (we can't go through
  // assignLineage here because nodes already carry their ids).
  lineageReset();
  lineage.nextId = snap.lineage.nextId;
  lineage.structVersion = snap.lineage.structVersion;
  lineage.nodes = new Map(snap.lineage.nodes.map(([id, n]) => [id, _denormLineageNode(n)]));
  lineage.children = new Map(snap.lineage.children.map(([id, arr]) => [id, new Set(arr)]));
  lineage.redirects = new Map(snap.lineage.redirects);
  lineage.chromToId = new WeakMap();

  // Backfill `gen` for legacy saves (BFS from roots, gen = primary-parent's gen + 1).
  if (lineage.nodes.size && [...lineage.nodes.values()].some(n => n.gen === undefined)) {
    for (const n of lineage.nodes.values()) n.gen = -1;
    const queue = [];
    for (const [id, n] of lineage.nodes) {
      if (!(n.primaryParentId > 0) || !lineage.nodes.has(n.primaryParentId)) {
        n.gen = 0; queue.push(id);
      }
    }
    while (queue.length) {
      const pid = queue.shift();
      const pn = lineage.nodes.get(pid); if (!pn) continue;
      const kids = lineage.children.get(pid); if (!kids) continue;
      for (const kid of kids) {
        const kn = lineage.nodes.get(kid); if (!kn) continue;
        if (kn.primaryParentId !== pid) continue;
        if (kn.gen >= 0) continue;
        kn.gen = (pn.gen | 0) + 1;
        queue.push(kid);
      }
    }
    // Any node still at -1 (cycle / detached primary chain) → fall back to 0.
    for (const n of lineage.nodes.values()) if (n.gen < 0) n.gen = 0;
  }

  // Re-register each chromosome with its carried lineage id.
  for (let ci = 0; ci < world.maxCells; ci++) {
    const g = world.genomes[ci];
    if (!g) continue;
    const savedG = snap.world.genomes[ci];
    for (let k = 0; k < g.length; k++) {
      const lid = savedG[k] && savedG[k].lineageId;
      if (lid > 0) lineage.chromToId.set(g[k], lid);
    }
  }
  for (let i = 0; i < world.freeChromosomes.length; i++) {
    const lid = snap.world.freeChromosomes[i] && snap.world.freeChromosomes[i].data.lineageId;
    if (lid > 0) lineage.chromToId.set(world.freeChromosomes[i].data, lid);
  }

  // Reconcile counters with actual buffers (saved snapshot can carry phantom
  // alive nodes from pre-save drift), then run normal-policy prune once so
  // newly-dead nodes from the rebuild start their grace clock from now.
  lineageRebuildLiveness();
  lineagePrune();

  // 6. Rebuild spatial grids. Clear buckets + per-item indices, then the
  // existing incremental rebuilders re-insert from current positions.
  for (let i = 0; i < world.grid.length; i++) world.grid[i].length = 0;
  world.cellGridIdx.fill(-1);
  rebuildGrid();
  for (let i = 0; i < world.freePGrid.length; i++) world.freePGrid[i].length = 0;
  world.freePGridIdx.fill(-1);
  rebuildFreeProteinGrid();

  // 7. RNG.
  world.rng = makeRNG(CONFIG.seed);
  if (snap.rngState && world.rng.setState) world.rng.setState(snap.rngState);

  // 8. Camera, selection. Restored selection is opened as a single popup (the
  // multi-popup state isn't snapshotted — all extra popups close on load).
  camera.x = snap.camera.x; camera.y = snap.camera.y; camera.zoom = snap.camera.zoom;
  closeAllInspectPopups();
  selectedCell = (typeof snap.selectedCell === 'number') ? snap.selectedCell : -1;
  if (selectedCell >= 0 && world.alive[selectedCell]) {
    selectedCells.add(selectedCell);
    openInspectPopup('cell', selectedCell);
  } else {
    selectedCell = -1;
  }

  render(); updateStats(); updateInspect(); updateMilestones();
  console.log(`Loaded world  ·  tick ${world.tick}  ·  ${world.numCells} cells  ·  ${lineage.nodes.size} lineage nodes`);
}
