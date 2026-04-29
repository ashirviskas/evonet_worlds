// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// PORTAL LINEAGE — eject / catch / lazy ancestry fetch.
// ============================================================
// Identity is via global chromosome UUID (see mintChromosomeUuid in 14b_lineage).
// UUIDs are global across all worlds in the multiverse — receivers of a
// portal-ejected cell upsert by UUID; no local-id translation, no foreignIndex.
//
// We do NOT tag chromosomes with portal-* events. The lineage node's `event`
// records HOW it was born (replicase, division-mutate, initial, ...) and
// stays that way everywhere. Provenance is recorded once in `node.birth =
// { worldUuid, tick }` at creation time. Portal hops just transport the
// chromosome and pull in any tree the receiver doesn't have yet.
//
// Donor side:
//   portalEject(i, side)  — ship cell state + each genome's serialized lineage
//                           node (so the receiver knows the chromosome's birth
//                           context immediately). Decrement donor's copy counts.
//   replyLineageFill(req) — serve a BFS subtree (depth-bounded, full DAG)
//                           rooted at the requested chromosome UUIDs.
//
// Receiver side:
//   catchJumper(payload)  — import each genome's serialized node as metadata,
//                           bind cell buffer + bump copies (animates ghost
//                           ancestors → alive when they were already known),
//                           request ancestry fill for any nodes whose parents
//                           aren't yet local.
//   mergeLineageFill(p)   — two-pass: insert all incoming ancestor nodes as
//                           ghosts, then enrich each one's parent edges.
// ============================================================

const SIDE_OPP = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };

// Pending fills per srcWorldUuid msgId — { uuids, timeoutHandle }.
// We don't tag events on timeout; tracking is just so we can ignore stale
// late-arriving fills.
const portalPending = new Map();

// ---- DONOR SIDE -----------------------------------------------------------

function portalEject(i, side) {
  const dstUuid = world.neighbors[side];
  if (!dstUuid) return false;

  // 1) Capture cell state into a structured-cloneable payload BEFORE we evict.
  const cell = _serializeCellState(i, side);

  // 2) Capture genomes + their lineage nodes (event, parents, birth, ...).
  // Shipping the node alongside the bytes means the receiver sees the
  // chromosome's *real* birth event from the moment it lands — no
  // placeholder, no `portal-in` relabeling.
  const genomes = [];
  const g = world.genomes[i];
  if (g) {
    for (let c = 0; c < g.length; c++) {
      const chrom = g[c];
      const uuid = getLineageId(chrom);
      if (!uuid) continue;
      const donorNode = lineage.nodes.get(uuid);
      genomes.push({
        uuid,
        data: new Uint8Array(chrom),
        node: donorNode ? _serializeLineageNode(donorNode) : null,
      });
    }
  }

  // 3) Build + send the eject payload.
  portalBusSend({
    type: 'portal-eject',
    srcWorldUuid: world.uuid,
    srcTick: world.tick,
    srcSide: side,
    dstWorldUuid: dstUuid,
    cell,
    genomes,
  });

  // 4) Record the crossing for the multiverse viewer.
  _recordPortalCrossing('out', side, dstUuid);

  // 5) Evict the donor slot. portalEvictCell drops the cell-pool copy counts
  // for these chromosomes so the donor's lineage tree stays accurate.
  portalEvictCell(i);
  return true;
}

// Append to the rolling crossing log + bump per-side counters.
function _recordPortalCrossing(dir, side, peerUuid) {
  const c = world.portalCrossings;
  if (!c) return;
  if (c[dir] && c[dir][side] != null) c[dir][side]++;
  c.recent.push({ dir, side, peerUuid, tick: world.tick, ts: Date.now() });
  const cap = CONFIG.multiverseRecentLogCap;
  if (c.recent.length > cap) c.recent.splice(0, c.recent.length - cap);
}

// Like killCell but doesn't release internal proteins / subslot proteins /
// chromosomes as free chromosomes — the cell is leaving in one piece. Each
// chromosome's lineage cell-pool count is decremented (lineageMarkDead) so
// the donor's tree counters stay consistent with reality. Replicase jobs are
// cancelled (they don't survive the trip in v1).
function portalEvictCell(cellIdx) {
  // Drop cell-pool lineage counts for every chromosome leaving with the cell.
  // Without this, donor's copiesInCells lingers at +1 forever per ejected
  // chromosome, which manifests as "phantom alive" lineage nodes.
  const genome = world.genomes[cellIdx];
  if (genome) {
    for (let c = 0; c < genome.length; c++) {
      lineageMarkDead(genome[c], 'cell');
    }
  }

  replicaseFreeAllForCell(cellIdx);
  gridRemoveCell(cellIdx);
  world.alive[cellIdx] = 0;
  world.numCells--;
  for (let t = 0; t < 64; t++) world.internalProteins[cellIdx * 64 + t] = 0;
  world.cytoOccMask[cellIdx * 2] = 0;
  world.cytoOccMask[cellIdx * 2 + 1] = 0;
  for (let s = 0; s < NUM_SLOTS; s++) {
    world.slotOpen[cellIdx * NUM_SLOTS + s] = 0;
    for (let ss = 0; ss < NUM_SUBSLOTS; ss++) {
      const si = subIdx(cellIdx, s, ss);
      world.subslotType[si] = 255;
      world.subslotCount[si] = 0;
    }
  }
  for (let w = 0; w < 3; w++) world.subslotOccMask[cellIdx * 3 + w] = 0;
  for (let s = 0; s < NUM_SLOTS; s++) for (let t = 0; t < 64; t++) world.slotTypeCount[(cellIdx * NUM_SLOTS + s) * 64 + t] = 0;
  for (let t = 0; t < 64; t++) world.decayNextCyto[cellIdx * 64 + t] = 0;
  for (let k = 0; k < TOTAL_SUBSLOTS_PER_CELL; k++) world.decayNextSub[cellIdx * TOTAL_SUBSLOTS_PER_CELL + k] = 0;
  world.genomes[cellIdx] = null;
  world.membraneDividing[cellIdx] = 0;
}

function _serializeCellState(i, srcSide) {
  const W = CONFIG.worldWidth, H = CONFIG.worldHeight;
  const posPerp = (srcSide === 'left' || srcSide === 'right') ? world.pos_y[i] / H : world.pos_x[i] / W;

  const subStart = i * TOTAL_SUBSLOTS_PER_CELL;
  const slotTypeStart = i * NUM_SLOTS * 64;

  return {
    posPerp,
    vel_x: world.vel_x[i], vel_y: world.vel_y[i],
    radius: world.radius[i],
    energy: world.energy[i],
    cellUpkeep: world.cellUpkeep[i],
    membraneHP: world.membraneHP[i],
    age: world.age[i],
    generation: world.generation[i],
    dividing: world.dividing[i],
    membraneDividing: world.membraneDividing[i],
    internalProteins: new Uint16Array(world.internalProteins.subarray(i * 64, i * 64 + 64)),
    subslotType:  new Uint8Array(world.subslotType.subarray(subStart, subStart + TOTAL_SUBSLOTS_PER_CELL)),
    subslotCount: new Uint8Array(world.subslotCount.subarray(subStart, subStart + TOTAL_SUBSLOTS_PER_CELL)),
    slotOpen:     new Uint8Array(world.slotOpen.subarray(i * NUM_SLOTS, i * NUM_SLOTS + NUM_SLOTS)),
    slotTypeCount: new Uint8Array(world.slotTypeCount.subarray(slotTypeStart, slotTypeStart + NUM_SLOTS * 64)),
    cytoOccMask:    new Uint32Array(world.cytoOccMask.subarray(i * 2, i * 2 + 2)),
    subslotOccMask: new Uint32Array(world.subslotOccMask.subarray(i * 3, i * 3 + 3)),
    ribo_chromIdx: world.ribo_chromIdx[i], ribo_offset: world.ribo_offset[i],
    ribo_holding: world.ribo_holding[i], ribo_heldOpcode: world.ribo_heldOpcode[i],
    ribo_searchMode: world.ribo_searchMode[i], ribo_searchByte: world.ribo_searchByte[i],
    ribo_searchTicks: world.ribo_searchTicks[i], ribo_tickCounter: world.ribo_tickCounter[i],
  };
}

// ---- RECEIVER SIDE --------------------------------------------------------

function catchJumper(payload) {
  const idx = _findFreeSlot();
  if (idx === -1) return;   // receiver is full — drop. Donor already evicted.

  const W = CONFIG.worldWidth, H = CONFIG.worldHeight;
  const dstSide = SIDE_OPP[payload.srcSide] || 'left';
  const r = payload.cell.radius || CONFIG.spawnRadius;
  let px, py;
  switch (dstSide) {
    case 'left':   px = r;     py = payload.cell.posPerp * H; break;
    case 'right':  px = W - r; py = payload.cell.posPerp * H; break;
    case 'top':    py = r;     px = payload.cell.posPerp * W; break;
    case 'bottom': py = H - r; px = payload.cell.posPerp * W; break;
  }
  py = Math.max(r, Math.min(H - r, py));
  px = Math.max(r, Math.min(W - r, px));

  _restoreCellState(idx, payload.cell, px, py);

  // Pass 1 — import each genome's lineage node as metadata (creates a ghost
  // if fresh, or enriches missing parents if already known). This preserves
  // the donor's birth event and parent edges immediately.
  const requestedUuids = [];
  for (const g of payload.genomes) {
    const wasKnown = lineage.nodes.has(g.uuid);
    if (g.node) lineageImportAncestor(g.node);
    // Whether wasKnown or freshly imported, request ancestry so we get the
    // node's grandparents+ that aren't shipped with the cell.
    if (!wasKnown) requestedUuids.push(g.uuid);
  }

  // Pass 2 — bind cell buffers and bump copies. The bumpCopies call animates
  // a freshly-imported ghost (alive=0 → alive=1) and rolls up
  // descendantsAlive on its ancestors. For nodes that were already alive
  // locally (round-trip / re-arrival), it just increments the cell-pool count.
  const genomes = [];
  for (const g of payload.genomes) {
    const chrom = new Uint8Array(g.data);
    lineage.chromToId.set(chrom, g.uuid);
    const node = lineage.nodes.get(g.uuid);
    if (node) lineageBumpCopies(node, 'cell');
    genomes.push(chrom);
  }

  world.genomes[idx] = genomes;
  world.alive[idx] = 1;
  world.numCells++;
  gridAddCell(idx);
  lineage.structVersion++;

  _recordPortalCrossing('in', dstSide, payload.srcWorldUuid);

  if (requestedUuids.length > 0) {
    const reqMsgId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    portalBusSend({
      type: 'portal-lineage-request',
      msgId: reqMsgId,
      srcWorldUuid: world.uuid,
      dstWorldUuid: payload.srcWorldUuid,
      uuids: requestedUuids,
      depth: CONFIG.portalAncestryDepth,
    });
    const handle = setTimeout(() => {
      // Donor never replied. We just drop the pending entry — no event flip,
      // the genome's local node stays as-is with whatever parents were
      // already known. If anyone else has the data we'll hear about it later.
      portalPending.delete(reqMsgId);
    }, CONFIG.portalFillTimeoutMs);
    portalPending.set(reqMsgId, { uuids: requestedUuids, timeoutHandle: handle });
  }
}

function _restoreCellState(idx, cell, px, py) {
  world.pos_x[idx] = px; world.pos_y[idx] = py;
  world.vel_x[idx] = cell.vel_x || 0; world.vel_y[idx] = cell.vel_y || 0;
  world.radius[idx] = cell.radius || CONFIG.spawnRadius;
  if (world.radius[idx] > world.maxRadius) world.maxRadius = world.radius[idx];
  world.energy[idx] = cell.energy || 0;
  world.cellUpkeep[idx] = cell.cellUpkeep || CONFIG.metabolismCost;
  world.membraneHP[idx] = cell.membraneHP || CONFIG.membraneMaxHP;
  world.age[idx] = cell.age || 0;
  world.parentId[idx] = -1;
  world.generation[idx] = cell.generation || 0;
  world.dividing[idx] = cell.dividing || 0;
  world.membraneDividing[idx] = cell.membraneDividing || 0;
  world.replicase_activeCount[idx] = 0;

  if (cell.internalProteins) world.internalProteins.set(cell.internalProteins, idx * 64);
  if (cell.subslotType)  world.subslotType.set(cell.subslotType,  idx * TOTAL_SUBSLOTS_PER_CELL);
  if (cell.subslotCount) world.subslotCount.set(cell.subslotCount, idx * TOTAL_SUBSLOTS_PER_CELL);
  if (cell.slotOpen)     world.slotOpen.set(cell.slotOpen,         idx * NUM_SLOTS);
  if (cell.slotTypeCount) world.slotTypeCount.set(cell.slotTypeCount, idx * NUM_SLOTS * 64);
  if (cell.cytoOccMask)    world.cytoOccMask.set(cell.cytoOccMask,    idx * 2);
  if (cell.subslotOccMask) world.subslotOccMask.set(cell.subslotOccMask, idx * 3);

  world.ribo_chromIdx[idx]  = cell.ribo_chromIdx  || 0;
  world.ribo_offset[idx]    = cell.ribo_offset    || 0;
  world.ribo_holding[idx]   = cell.ribo_holding   || 0;
  world.ribo_heldOpcode[idx]= cell.ribo_heldOpcode|| 0;
  world.ribo_searchMode[idx]= cell.ribo_searchMode|| 0;
  world.ribo_searchByte[idx]= cell.ribo_searchByte|| 0;
  world.ribo_searchTicks[idx]=cell.ribo_searchTicks||0;
  world.ribo_tickCounter[idx]=cell.ribo_tickCounter||0;

  for (let t = 0; t < 64; t++) world.decayNextCyto[idx * 64 + t] = 0;
  for (let k = 0; k < TOTAL_SUBSLOTS_PER_CELL; k++) world.decayNextSub[idx * TOTAL_SUBSLOTS_PER_CELL + k] = 0;
}

// Donor side: BFS the local lineage DAG up to `depth` from each requested
// UUID. Includes ALL parents at each node (full DAG, not just primary).
function replyLineageFill(req) {
  const collected = new Map();
  const queue = [];
  for (const uuid of req.uuids || []) {
    if (lineage.nodes.has(uuid)) queue.push({ id: uuid, d: 0 });
  }
  while (queue.length) {
    const { id, d } = queue.shift();
    if (collected.has(id)) continue;
    const n = lineage.nodes.get(id);
    if (!n) continue;
    collected.set(id, _serializeLineageNode(n));
    if (d >= req.depth) continue;
    for (const pid of n.parents) if (lineage.nodes.has(pid)) queue.push({ id: pid, d: d + 1 });
  }

  portalBusSend({
    type: 'portal-lineage-fill',
    srcWorldUuid: world.uuid,
    dstWorldUuid: req.srcWorldUuid,
    respondsTo: req.msgId,
    requestedUuids: req.uuids || [],
    nodes: [...collected.values()],
  });
}

function _serializeLineageNode(n) {
  return {
    uuid: n.id,
    parents: n.parents.slice(),
    parentBytes: n.parentBytes ? n.parentBytes.slice() : null,
    data: new Uint8Array(n.data),
    event: n.event,
    birthTick: n.birthTick,
    birth: n.birth || { worldUuid: world.uuid, tick: n.birthTick },
    gen: n.gen | 0,
  };
}

// Receiver side: two-pass. Pass 1 imports every node as ghost metadata.
// Pass 2 enriches parent edges (now all parent UUIDs in the fill exist
// locally so no edges are dropped due to insertion order).
function mergeLineageFill(payload) {
  const incoming = payload.nodes || [];

  // Pass 1: insert all nodes (or merely register-known) without any parent
  // wiring. lineageImportAncestor handles both fresh ghost insertion and
  // existing-node updates idempotently.
  for (const n of incoming) {
    lineageImportAncestor({
      uuid: n.uuid,
      parents: [],   // wire in pass 2
      parentBytes: null,
      data: n.data,
      event: n.event,
      birthTick: n.birthTick,
      birth: n.birth,
      gen: n.gen,
    });
  }

  // Pass 2: now every UUID in the fill exists locally — wire parent edges.
  for (const n of incoming) {
    const node = lineage.nodes.get(n.uuid);
    if (!node) continue;
    const parents = (n.parents || []).filter(p => lineage.nodes.has(p));
    if (!parents.length) continue;
    const alignedBytes = (n.parentBytes && n.parentBytes.length === (n.parents || []).length)
      ? n.parents.map((p, i) => parents.indexOf(p) >= 0 ? (n.parentBytes[i] || 0) : null).filter(v => v !== null)
      : null;
    lineageEnrichParents(node, parents, alignedBytes);
  }

  if (payload.respondsTo && portalPending.has(payload.respondsTo)) {
    const ent = portalPending.get(payload.respondsTo);
    clearTimeout(ent.timeoutHandle);
    portalPending.delete(payload.respondsTo);
  }

  lineage.structVersion++;
}
