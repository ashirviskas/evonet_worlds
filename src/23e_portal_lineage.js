// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// PORTAL LINEAGE — eject / catch / lazy ancestry fetch.
// ============================================================
// Donor side:
//   portalEject(i, side)  — capture cell state, mark donor lineage, postMessage,
//                           evict the slot.
//   replyLineageFill(req) — serve a BFS subtree (depth-bounded, full DAG)
//                           rooted at the requested local lineage ids.
//
// Receiver side:
//   catchJumper(payload)  — slot the cell at the opposite portal, register
//                           genome lineage with foreignIndex, request fill if
//                           any genome's ancestry is unknown locally.
//   mergeLineageFill(p)   — splice incoming ancestor nodes into the local
//                           tree, promote pending → portal-in.
// ============================================================

const SIDE_OPP = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };

// Pending fills per srcWorldUuid msgId — { foreignIds, timeoutHandle, perGenome }.
// perGenome is the list of local pending node ids that need their parents
// wired up once the fill arrives.
const portalPending = new Map();

// ---- DONOR SIDE -----------------------------------------------------------

function portalEject(i, side) {
  const dstUuid = world.neighbors[side];
  if (!dstUuid) return false;

  // 1) Capture cell state into a structured-cloneable payload BEFORE we evict
  //    (eviction clears the per-cell typed arrays).
  const cell = _serializeCellState(i, side);

  // 2) Capture genomes + their foreign-tagged lineage ids. The receiver uses
  //    these to either dedup against its foreignIndex or open a pending node
  //    that triggers a portal-lineage-request.
  const genomes = [];
  const localLineageIdsForOut = [];
  const g = world.genomes[i];
  if (g) {
    for (let c = 0; c < g.length; c++) {
      const chrom = g[c];
      const lid = getLineageId(chrom);
      if (lid <= 0) continue;
      const node = lineage.nodes.get(lid);
      // Origin perspective for the receiver:
      //  - If this chrom was already a portal-in from somewhere else, preserve
      //    the original origin so the chain of custody is unbroken across hops.
      //  - Otherwise the origin is us.
      const origUuid  = node && node.originWorldUuid  ? node.originWorldUuid  : world.uuid;
      const origLocal = node && node.originLocalId != null ? node.originLocalId : lid;
      genomes.push({
        data: new Uint8Array(chrom),
        originWorldUuid: origUuid,
        originLocalId: origLocal,
      });
      localLineageIdsForOut.push(lid);
    }
  }

  // 3) Tag the donor's primary lineage node(s) with portal-out.
  for (const lid of localLineageIdsForOut) {
    const node = lineage.nodes.get(lid);
    if (!node) continue;
    node.event = 'portal-out';
    node.dstWorldUuid = dstUuid;
    node.portalSide = side;
  }
  lineage.structVersion++;

  // 4) Build + send the eject payload.
  portalBusSend({
    type: 'portal-eject',
    srcWorldUuid: world.uuid,
    srcTick: world.tick,
    srcSide: side,
    dstWorldUuid: dstUuid,
    cell,
    genomes,
  });

  // 5) Evict the donor slot. Custom — skip protein/chromosome release because
  //    everything went with the cell to the receiver. Replicase jobs are
  //    cancelled (they don't survive the trip in v1).
  portalEvictCell(i);
  return true;
}

// Like killCell but does NOT release internal proteins / subslot proteins /
// chromosomes as free chromosomes — the cell is leaving in one piece.
// Replicase jobs are cancelled (transient state; receiver re-enters naturally).
function portalEvictCell(cellIdx) {
  replicaseFreeAllForCell(cellIdx);
  gridRemoveCell(cellIdx);
  world.alive[cellIdx] = 0;
  world.numCells--;
  // Clear per-cell typed arrays so the slot is reusable.
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
  // posPerp: the perpendicular axis at the wall. For left/right walls, that's y;
  // for top/bottom walls, that's x. Receiver maps to its own world dimensions.
  const W = CONFIG.worldWidth, H = CONFIG.worldHeight;
  const posPerp = (srcSide === 'left' || srcSide === 'right') ? world.pos_y[i] / H : world.pos_x[i] / W;

  // Slice per-cell typed array regions so we ship just this cell's bytes.
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

  // Clamp posPerp into the strip (we only eject inside the strip, and the
  // donor's strip frac matches ours — defensive clamp anyway).
  py = Math.max(r, Math.min(H - r, py));
  px = Math.max(r, Math.min(W - r, px));

  _restoreCellState(idx, payload.cell, px, py);

  // Lineage / genomes.
  const localLineageIds = [];
  const pendingForeign = [];
  const pendingLocalIds = [];
  const genomes = [];
  for (const g of payload.genomes) {
    const chrom = new Uint8Array(g.data);
    // Round-trip detection: if the genome's origin uuid is OURS, this cell
    // was born here and is coming home. Look up by local id directly — the
    // node lives in lineage.nodes, NOT in foreignIndex (which only holds
    // nodes imported from other worlds).
    let existing = -1;
    if (g.originWorldUuid === world.uuid && g.originLocalId != null
        && lineage.nodes.has(g.originLocalId)) {
      existing = g.originLocalId;
    } else {
      existing = lineageLookupForeign(g.originWorldUuid, g.originLocalId);
    }
    let lid;
    if (existing > 0) {
      // Already in our tree — bump copies on this node, rebind chrom buffer.
      const node = lineage.nodes.get(existing);
      lid = existing;
      if (node) {
        node.event = 'portal-revisit';
        node.srcWorldUuid = payload.srcWorldUuid;
        node.srcTick = payload.srcTick;
        lineageBumpCopies(node, 'cell');
      }
      lineage.chromToId.set(chrom, lid);
    } else {
      // Fresh — insert as portal-in-pending; we'll request ancestry below.
      lid = lineageInsertImported(chrom, {
        parents: [],
        originWorldUuid: g.originWorldUuid,
        originLocalId: g.originLocalId,
        event: 'portal-in-pending',
        srcWorldUuid: payload.srcWorldUuid,
        srcTick: payload.srcTick,
      }, 'cell');
      pendingForeign.push({ originWorldUuid: g.originWorldUuid, originLocalId: g.originLocalId });
      pendingLocalIds.push(lid);
    }
    genomes.push(chrom);
    localLineageIds.push(lid);
  }

  world.genomes[idx] = genomes;
  world.alive[idx] = 1;
  world.numCells++;
  gridAddCell(idx);
  lineage.structVersion++;

  // Ask the donor for ancestry, if any genome is fresh.
  if (pendingForeign.length > 0) {
    const reqMsgId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    portalBusSend({
      type: 'portal-lineage-request',
      msgId: reqMsgId,
      srcWorldUuid: world.uuid,
      dstWorldUuid: payload.srcWorldUuid,
      requestedForeignIds: pendingForeign,
      depth: CONFIG.portalAncestryDepth,
    });
    const handle = setTimeout(() => {
      // Donor likely closed — orphan the still-pending nodes.
      for (const lid of pendingLocalIds) {
        const n = lineage.nodes.get(lid);
        if (n && n.event === 'portal-in-pending') n.event = 'portal-in-orphan';
      }
      lineage.structVersion++;
      portalPending.delete(reqMsgId);
    }, CONFIG.portalFillTimeoutMs);
    portalPending.set(reqMsgId, { foreignIds: pendingForeign, pendingLocalIds, timeoutHandle: handle });
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
  world.parentId[idx] = -1;   // foreign — local parent slot does not exist
  world.generation[idx] = cell.generation || 0;
  world.dividing[idx] = cell.dividing || 0;
  world.membraneDividing[idx] = cell.membraneDividing || 0;
  world.replicase_activeCount[idx] = 0;

  // Per-cell typed-array regions.
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

  // Reset decay countdowns — cell starts fresh in the new world's tick frame.
  for (let t = 0; t < 64; t++) world.decayNextCyto[idx * 64 + t] = 0;
  for (let k = 0; k < TOTAL_SUBSLOTS_PER_CELL; k++) world.decayNextSub[idx * TOTAL_SUBSLOTS_PER_CELL + k] = 0;
}

// Donor side: BFS the local lineage DAG up to `depth` from each requested
// foreign id (only those whose origin is OUR uuid — anything else, we don't
// own). Includes ALL parents at each node (full DAG, not just primary).
function replyLineageFill(req) {
  const collected = new Map();   // localId -> serialized node
  const queue = [];
  for (const f of req.requestedForeignIds || []) {
    if (f.originWorldUuid !== world.uuid) continue;   // not ours to serve
    const startId = f.originLocalId;
    if (lineage.nodes.has(startId)) queue.push({ id: startId, d: 0 });
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
    requestedForeignIds: req.requestedForeignIds || [],
    nodes: [...collected.values()],
  });
}

function _serializeLineageNode(n) {
  return {
    localId: n.id,
    parents: n.parents.slice(),
    data: new Uint8Array(n.data),
    event: n.event,
    birthTick: n.birthTick,
    gen: n.gen | 0,
    // Preserve multi-hop provenance: if this node came in from somewhere else
    // before, ship that origin instead of overwriting with ours.
    originWorldUuid: n.originWorldUuid,
    originLocalId: n.originLocalId,
  };
}

// Receiver side: insert ancestor nodes, build foreign→local remap, wire
// pending portal-in-pending nodes' parents to the now-imported ancestors.
function mergeLineageFill(payload) {
  const fromUuid = payload.srcWorldUuid;
  const remap = new Map();   // donor's localId -> our localId
  // Two passes: first allocate IDs (and dedup against foreignIndex), second
  // rewrite parent arrays.
  const incoming = payload.nodes || [];
  for (const n of incoming) {
    // Origin uuid for this node: if the donor flagged it as already foreign
    // (multi-hop), keep that; otherwise it originated in the donor's world.
    const origUuid = n.originWorldUuid || fromUuid;
    const origLocal = (n.originLocalId != null) ? n.originLocalId : n.localId;
    const existing = lineageLookupForeign(origUuid, origLocal);
    if (existing > 0) {
      remap.set(n.localId, existing);
      continue;
    }
    // Fresh — insert with empty parents (we rewrite next pass).
    const chrom = new Uint8Array(n.data);
    const localId = lineageInsertImported(chrom, {
      parents: [],
      originWorldUuid: origUuid,
      originLocalId: origLocal,
      event: n.event || 'portal-in',
      birthTick: n.birthTick,
      gen: n.gen,
    }, 'free');
    // Imported ancestors aren't held by any cell on our side — bump down the
    // cell-pool counter (insertImported defaulted to 'free' so we're fine).
    remap.set(n.localId, localId);
  }
  // Pass 2: rewrite parents for nodes we just inserted, and roll up
  // descendantsAlive on ancestors. lineageInsertImported's rollup runs at
  // insert time but parents may not have existed yet, so re-roll once the
  // wiring is complete.
  for (const n of incoming) {
    const localId = remap.get(n.localId);
    if (!localId) continue;
    const node = lineage.nodes.get(localId);
    if (!node) continue;
    if (!n.parents || !n.parents.length) continue;
    if (node.parents.length) continue;   // already wired (existing dedup hit)
    const newParents = [];
    for (const pid of n.parents) {
      const lp = remap.get(pid);
      if (lp && lineage.nodes.has(lp)) newParents.push(lp);
    }
    node.parents = newParents;
    node.primaryParentId = newParents.length ? newParents[0] : -1;
    for (const pp of newParents) {
      lineageAddChild(pp, localId);
      const pn = lineage.nodes.get(pp);
      if (pn) pn.directChildrenAlive++;
    }
    if (newParents.length) {
      const pn = lineage.nodes.get(newParents[0]);
      if (pn) node.gen = (pn.gen | 0) + 1;
      lineageWalkAncestorsAlive(node, +1);
    }
  }

  // Promote any pending portal-in-pending nodes to portal-in. Pass 2 above
  // already wired their parents (since pending nodes have parents=[] before
  // merge, and the fill carries each node's parents — pass 2 finds matching
  // origin via remap and wires). Here we just relabel.
  if (payload.respondsTo && portalPending.has(payload.respondsTo)) {
    const ent = portalPending.get(payload.respondsTo);
    clearTimeout(ent.timeoutHandle);
    for (const localId of ent.pendingLocalIds) {
      const node = lineage.nodes.get(localId);
      if (node && node.event === 'portal-in-pending') node.event = 'portal-in';
    }
    portalPending.delete(payload.respondsTo);
  }

  lineage.structVersion++;
}
