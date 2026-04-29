// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// LINEAGE — DNA-level family tree, keyed by global chromosome UUID.
//
// Every distinct chromosome gets a 32-char hex UUID at birth (8-hex prefix =
// FNV-32 of its birth world's uuid; 24-hex = crypto-random). UUIDs are global
// across all worlds in the multiverse — receivers of a portal-ejected cell
// just upsert by UUID, no local-id translation, no foreignIndex.
//
// Nodes record parents (0..N), parentBytes (per-parent byte contribution from
// replicase), birthTick, birth metadata (donor world+tick for debug), event,
// liveness. We also keep a reverse `children` index so the renderer + pruner
// can walk down cheaply.
//
// Prune policy:
//  - Terminal dead-leaf (no children ever) dropped after lineageDeadLeafGraceTicks.
//  - Chain-collapse waypoints when total > lineageMaxNodes: merge single-parent
//    single-child nodes into their parent (preserving the DAG; never merges
//    nodes with >1 parent or whose child has >1 parent).
//  - Truly cap-exceeding: drop oldest dead-leaf outright.
// ============================================================
const lineage = {
  nodes: new Map(),              // uuid -> node record
  children: new Map(),           // parentUuid -> Set<childUuid>
  chromToId: new WeakMap(),      // Uint8Array -> uuid
  redirects: new Map(),          // deletedUuid -> survivorUuid (or null) — resolves ghost UUIDs to living ancestors
  structVersion: 0,              // bumped whenever parents/children mutate — renderer watches this
  prunedSafetyDrops: 0,
  collapsedMerges: 0,
  ghostParentsRepaired: 0,       // debug: times getLineageId followed a redirect chain
};

function lineageHashPrefix(u8) {
  // FNV-1a 32-bit — cheap, good enough for visual dedup / labels.
  let h = 0x811c9dc5;
  const n = Math.min(u8.length, 64);
  for (let i = 0; i < n; i++) { h ^= u8[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

// FNV-1a over a JS string — used to derive the 8-hex world prefix of a fresh
// chromosome UUID. Identical hash for the same world.uuid means every chrom
// born in a given tab carries that tab's prefix, so the renderer can color by
// origin world by reading just the first 8 chars of any chromosome's UUID.
function _fnv32Hex(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// 32-hex-char chromosome UUID. 8-hex world prefix + 24-hex (12 random bytes).
// 96 bits of random entropy per world — collision-free in practice.
function mintChromosomeUuid() {
  const prefix = _fnv32Hex(world && world.uuid ? world.uuid : '');
  const buf = new Uint8Array(12);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < 12; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  let s = prefix;
  for (let i = 0; i < 12; i++) s += buf[i].toString(16).padStart(2, '0');
  return s;
}

// Short display form for UI labels — first 6 hex chars.
function lineageShortId(uuid) { return uuid ? uuid.slice(0, 6) : ''; }

function lineageAddChild(parentId, childId) {
  let set = lineage.children.get(parentId);
  if (!set) { set = new Set(); lineage.children.set(parentId, set); }
  set.add(childId);
}

function lineageRemoveChild(parentId, childId) {
  const set = lineage.children.get(parentId);
  if (!set) return;
  set.delete(childId);
  if (set.size === 0) lineage.children.delete(parentId);
}

// Unified entry point. Either creates a new lineage node or merges into an
// existing one, keyed by chromosome UUID. Replaces the old assignLineage +
// lineageInsertImported split.
//
// fields: {
//   uuid?,         // pre-existing UUID (portal arrival / ancestry fill); omit for fresh local birth
//   parents?,      // array of parent UUIDs
//   parentBytes?,  // per-parent byte contribution (replicase only)
//   event,         // 'replicase' | 'crossover' | 'division-mutate' | 'initial' | 'primordial' | 'editor-edit' | 'library-spawn' | 'degrade-checkpoint' | 'digest-checkpoint'
//   holder,        // 'cell' | 'free'
//   birth?,        // { worldUuid, tick } — donor's birth context; defaults to local world
//   birthTick?,    // explicit override (used for fill); defaults to birth.tick or world.tick
//   gen?,          // explicit generation depth (used for fill)
//   dedup?,        // 'local' (default) | 'none' — skip dedup ladder for foreign arrivals
// }
//
// Returns the resolved UUID (new or existing). Returns null if chrom is invalid.
function lineageUpsert(chrom, fields) {
  if (!chrom || !(chrom instanceof Uint8Array)) return null;
  fields = fields || {};

  // Buffer already bound to a node — refcount unchanged (the buffer is the same
  // logical instance, no new arrival).
  const existingByBuf = lineage.chromToId.get(chrom);
  if (existingByBuf !== undefined) return existingByBuf;

  const dedup = fields.dedup || 'local';
  const holder = fields.holder || 'cell';
  const incomingParents = fields.parents || [];
  const parentsArr = incomingParents.filter(p => typeof p === 'string' && p.length > 0 && lineage.nodes.has(p));
  // parentBytes must align with parentsArr (filter dropped some) — drop the byte
  // counts for filtered-out parents.
  let parentBytes = null;
  if (fields.parentBytes && fields.parentBytes.length === incomingParents.length) {
    parentBytes = [];
    for (let i = 0; i < incomingParents.length; i++) {
      if (parentsArr.indexOf(incomingParents[i]) >= 0) parentBytes.push(fields.parentBytes[i] || 0);
    }
  }

  // ---- Foreign / re-arrival path: caller carries the canonical UUID ----
  if (fields.uuid) {
    const uuid = fields.uuid;
    const existing = lineage.nodes.get(uuid);
    if (existing) {
      lineage.chromToId.set(chrom, uuid);
      lineageBumpCopies(existing, holder);
      // Enrich with any newly-revealed parents this fill brings.
      if (parentsArr.length) lineageEnrichParents(existing, parentsArr, parentBytes);
      return uuid;
    }
    return _lineageCreateNode(uuid, chrom, parentsArr, parentBytes, fields, holder);
  }

  // ---- Local birth path: dedup ladder before minting a fresh UUID ----

  // 1. Single-parent zero-mutation copy = same chromosome. Rebind to parent.
  if (dedup === 'local' && parentsArr.length === 1) {
    const p = lineage.nodes.get(parentsArr[0]);
    if (p && p.data && p.data.length === chrom.length) {
      let same = true;
      for (let i = 0; i < chrom.length; i++) { if (p.data[i] !== chrom[i]) { same = false; break; } }
      if (same) {
        lineage.chromToId.set(chrom, p.id);
        lineageBumpCopies(p, holder);
        return p.id;
      }
    }
  }

  // 2. Multi-parent identical-match: a recombination child can happen to be
  // byte-identical to one of its parents. Rebind onto that parent. Tiebreak:
  // most bytes contributed; equal bytes → lex-smallest parent uuid for stability.
  if (dedup === 'local' && parentsArr.length > 1) {
    let bestId = null, bestBytes = -1;
    for (let pi = 0; pi < parentsArr.length; pi++) {
      const pid = parentsArr[pi];
      const p = lineage.nodes.get(pid);
      if (!p || !p.data || p.data.length !== chrom.length) continue;
      let same = true;
      for (let k = 0; k < chrom.length; k++) {
        if (p.data[k] !== chrom[k]) { same = false; break; }
      }
      if (!same) continue;
      const bytes = parentBytes ? (parentBytes[pi] || 0) : p.data.length;
      if (bytes > bestBytes || (bytes === bestBytes && (bestId === null || pid < bestId))) {
        bestBytes = bytes; bestId = pid;
      }
    }
    if (bestId !== null) {
      const winner = lineage.nodes.get(bestId);
      lineage.chromToId.set(chrom, winner.id);
      lineageBumpCopies(winner, holder);
      return winner.id;
    }
  }

  // 3. Sibling dedup: partial replication often emits several byte-identical
  // chromosomes from the same parent set. Collapse onto the first-recorded
  // sibling so the DNA tree doesn't fan out into crowds of identical leaves.
  if (dedup === 'local' && parentsArr.length >= 1) {
    const parentKey = parentsArr.slice().sort();
    let scanPid = parentsArr[0];
    let scanSize = Infinity;
    for (const pid of parentsArr) {
      const kids = lineage.children.get(pid);
      const sz = kids ? kids.size : 0;
      if (sz < scanSize) { scanSize = sz; scanPid = pid; }
    }
    const kids = lineage.children.get(scanPid);
    if (kids) {
      for (const sid of kids) {
        const s = lineage.nodes.get(sid);
        if (!s || !s.data) continue;
        if (s.length !== chrom.length) continue;
        if (s.parents.length !== parentKey.length) continue;
        const sParents = s.parents.slice().sort();
        let parentsMatch = true;
        for (let i = 0; i < sParents.length; i++) {
          if (sParents[i] !== parentKey[i]) { parentsMatch = false; break; }
        }
        if (!parentsMatch) continue;
        let same = true;
        for (let i = 0; i < chrom.length; i++) { if (s.data[i] !== chrom[i]) { same = false; break; } }
        if (same) {
          lineage.chromToId.set(chrom, s.id);
          lineageBumpCopies(s, holder);
          return s.id;
        }
      }
    }
  }

  // No dedup hit — mint a fresh UUID.
  const newUuid = mintChromosomeUuid();
  return _lineageCreateNode(newUuid, chrom, parentsArr, parentBytes, fields, holder);
}

// Backwards-compatible thin wrapper. Existing callers pass parents/event/holder
// positionally; we forward into upsert with dedup='local'.
function assignLineage(chrom, parents, event, holder, parentBytes) {
  return lineageUpsert(chrom, { parents, parentBytes, event, holder, dedup: 'local' });
}

// Shared node creation tail. Builds the node, links into nodes/children,
// rolls up descendantsAlive on ancestors. Used by both birth and import paths.
function _lineageCreateNode(uuid, chrom, parentsArr, parentBytes, fields, holder) {
  const event = fields.event || 'unknown';
  // Checkpoint events represent the SAME chromosome losing bytes, not a new
  // descendant. Skip ancestor descendantsEver/Alive rollup so erosion doesn't
  // inflate counters every N bytes.
  const isCheckpointEvent = event === 'degrade-checkpoint' || event === 'digest-checkpoint';
  const birthMeta = fields.birth || { worldUuid: world.uuid, tick: world.tick };
  const node = {
    id: uuid,
    parents: parentsArr.slice(),
    parentBytes: parentBytes ? parentBytes.slice() : null,
    shape: chromosomeShape(chrom),
    length: chrom.length,
    hashPrefix: lineageHashPrefix(chrom),
    // Full byte snapshot frozen at birth — the inspector renders this so the user
    // sees exactly what the chromosome was at the moment it was recorded. Copy
    // (don't alias) so later in-place mutation of the buffer doesn't rewrite history.
    data: new Uint8Array(chrom),
    // birthTick: the tick this node was minted in the local world's frame for
    // local births, or the donor's frame for fill-imported ancestors. Used by
    // the inspector for display; prune uses deathTick (always local).
    birthTick: fields.birthTick != null ? fields.birthTick : birthMeta.tick,
    birth: { worldUuid: birthMeta.worldUuid, tick: birthMeta.tick },
    event,
    alive: 1,
    copies: 1,
    copiesInCells: holder === 'cell' ? 1 : 0,
    copiesInFree:  holder === 'free' ? 1 : 0,
    copiesEver: 1,
    directChildrenAlive: 0,
    descendantsEver: 0,
    descendantsAlive: 0,
    contributesToDescendants: !isCheckpointEvent,
    deathTick: 0,
    mergedCount: 0,
    primaryParentId: parentsArr.length ? parentsArr[0] : null,
    gen: fields.gen != null ? fields.gen : 0,
  };
  lineage.nodes.set(uuid, node);
  lineage.chromToId.set(chrom, uuid);
  if (node.primaryParentId && fields.gen == null) {
    const pn = lineage.nodes.get(node.primaryParentId);
    if (pn) node.gen = (pn.gen | 0) + 1;
  }
  if (parentBytes) lineageRecomputePrimary(node);

  for (const pid of parentsArr) {
    lineageAddChild(pid, uuid);
    const pn = lineage.nodes.get(pid);
    if (pn) pn.directChildrenAlive++;
  }

  if (!isCheckpointEvent) {
    const seen = new Set();
    const stack = parentsArr.slice();
    while (stack.length) {
      const pid = stack.pop();
      if (seen.has(pid)) continue;
      seen.add(pid);
      const pn = lineage.nodes.get(pid);
      if (!pn) continue;
      pn.descendantsEver++;
      pn.descendantsAlive = (pn.descendantsAlive || 0) + 1;
      for (const gp of pn.parents) stack.push(gp);
    }
  }

  lineage.structVersion++;
  return uuid;
}

// Insert a serialized ancestor node from a portal fill. Metadata only — does
// NOT touch chromToId or copy counters. The node arrives as a "ghost"
// (alive=0, copies=0) until a real chromosome buffer with this UUID shows up
// locally and lineageBumpCopies animates it.
//
// If the UUID already exists locally, this just enriches missing parent
// edges (and fills in event/birth when the local node lacks them). It never
// overwrites an existing event with the fill's — that's the user's directive:
// once a node has a birth event, that's what it is everywhere.
//
// `s` is the shape produced by _serializeLineageNode in 23e_portal_lineage.js:
//   { uuid, parents, parentBytes, event, birthTick, birth, gen, data }
function lineageImportAncestor(s) {
  if (!s || !s.uuid) return null;
  const uuid = s.uuid;
  const existing = lineage.nodes.get(uuid);
  if (existing) {
    // Enrich missing parent edges only. Don't mutate event/birth on a node
    // that already has them — local node is canonical.
    const knownParents = (s.parents || []).filter(p => typeof p === 'string' && lineage.nodes.has(p));
    if (knownParents.length) {
      const alignedBytes = (s.parentBytes && s.parentBytes.length === (s.parents || []).length)
        ? s.parents.map((p, i) => knownParents.indexOf(p) >= 0 ? s.parentBytes[i] : 0).filter((_, i) => knownParents.indexOf(s.parents[i]) >= 0)
        : null;
      lineageEnrichParents(existing, knownParents, alignedBytes);
    }
    return uuid;
  }

  const isCheckpointEvent = s.event === 'degrade-checkpoint' || s.event === 'digest-checkpoint';
  const data = s.data instanceof Uint8Array ? new Uint8Array(s.data) : new Uint8Array(0);
  const knownParents = (s.parents || []).filter(p => typeof p === 'string' && lineage.nodes.has(p));
  const alignedBytes = (s.parentBytes && s.parentBytes.length === (s.parents || []).length)
    ? (s.parents.map((p, i) => knownParents.indexOf(p) >= 0 ? (s.parentBytes[i] || 0) : null).filter(v => v !== null))
    : null;

  const node = {
    id: uuid,
    parents: knownParents,
    parentBytes: alignedBytes ? alignedBytes.slice() : null,
    shape: chromosomeShape(data),
    length: data.length,
    hashPrefix: lineageHashPrefix(data),
    data,
    birthTick: s.birthTick != null ? s.birthTick : 0,
    birth: s.birth || { worldUuid: '', tick: s.birthTick || 0 },
    event: s.event || 'unknown',
    alive: 0,
    copies: 0,
    copiesInCells: 0,
    copiesInFree: 0,
    copiesEver: 0,
    directChildrenAlive: 0,
    descendantsEver: 0,
    descendantsAlive: 0,
    contributesToDescendants: !isCheckpointEvent,
    deathTick: 0,
    mergedCount: 0,
    primaryParentId: knownParents.length ? knownParents[0] : null,
    gen: s.gen != null ? s.gen : 0,
  };
  lineage.nodes.set(uuid, node);
  for (const pid of knownParents) lineageAddChild(pid, uuid);
  if (alignedBytes) lineageRecomputePrimary(node);
  lineage.structVersion++;
  return uuid;
}

// Add new parent edges to an existing node — used when a re-arrival or
// ancestry fill brings previously-unknown ancestors. Idempotent: skips parents
// already present. Bumps directChildrenAlive on each new parent + rolls
// descendantsAlive up the new ancestor chain (skipping ancestors that were
// already reachable via existing parents — diamond-DAG-safe).
function lineageEnrichParents(node, newParents, newParentBytes) {
  if (!newParents || !newParents.length) return 0;

  // Snapshot existing ancestors BEFORE adding new edges so we know which
  // ancestors already count this node and shouldn't be double-bumped.
  const oldAncestors = new Set();
  if (node.alive && node.contributesToDescendants) {
    const stack = node.parents.slice();
    while (stack.length) {
      const pid = stack.pop();
      if (oldAncestors.has(pid)) continue;
      oldAncestors.add(pid);
      const pn = lineage.nodes.get(pid);
      if (pn) for (const gp of pn.parents) stack.push(gp);
    }
  }

  const addedParents = [];
  for (let i = 0; i < newParents.length; i++) {
    const pid = newParents[i];
    if (!pid || node.parents.indexOf(pid) >= 0) continue;
    const pn = lineage.nodes.get(pid);
    if (!pn) continue;
    node.parents.push(pid);
    if (node.parentBytes) {
      node.parentBytes.push(newParentBytes ? (newParentBytes[i] || 0) : 0);
    }
    lineageAddChild(pid, node.id);
    if (node.alive) pn.directChildrenAlive++;
    addedParents.push(pid);
  }
  if (addedParents.length === 0) return 0;

  lineageRecomputePrimary(node);

  if (node.alive && node.contributesToDescendants) {
    const seen = new Set();
    const stack = addedParents.slice();
    while (stack.length) {
      const pid = stack.pop();
      if (seen.has(pid)) continue;
      seen.add(pid);
      if (oldAncestors.has(pid)) continue;   // already counts us
      const pn = lineage.nodes.get(pid);
      if (!pn) continue;
      pn.descendantsAlive = (pn.descendantsAlive || 0) + 1;
      pn.descendantsEver++;
      for (const gp of pn.parents) stack.push(gp);
    }
  }

  lineage.structVersion++;
  return addedParents.length;
}

// DAG-safe walk: apply delta to `descendantsAlive` on every transitive ancestor.
// Used when a node's liveness transitions — birth/death/re-animation/drop/collapse.
function lineageWalkAncestorsAlive(node, delta) {
  if (!node || !node.parents || !node.parents.length) return;
  const seen = new Set();
  const stack = node.parents.slice();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const pn = lineage.nodes.get(pid);
    if (!pn) continue;
    pn.descendantsAlive = (pn.descendantsAlive || 0) + delta;
    for (const gp of pn.parents) stack.push(gp);
  }
}

// Lookup: returns the UUID for a chromosome buffer, following redirects if the
// node was deleted (collapsed/dropped). Returns null if unknown.
function getLineageId(chrom) {
  if (!chrom) return null;
  let id = lineage.chromToId.get(chrom);
  if (id === undefined) return null;
  if (lineage.redirects.size && lineage.redirects.has(id)) {
    const seen = new Set();
    let followed = false;
    while (lineage.redirects.has(id) && !seen.has(id)) { seen.add(id); id = lineage.redirects.get(id); followed = true; }
    if (followed) lineage.ghostParentsRepaired++;
    if (id && lineage.nodes.has(id)) lineage.chromToId.set(chrom, id);
    else return null;
  }
  return lineage.nodes.has(id) ? id : null;
}

function lineageGetNode(id) { return lineage.nodes.get(id); }

// Wipe all lineage state to a freshly-initialised, empty form. Called from
// restart and load — both paths replace world state, so the lineage tree must
// not carry over (otherwise nodes from the prior run dangle in the renderer).
// Also clears the renderer-side highlight set, popup selection, and bumps
// structVersion so the layout cache rebuilds.
function lineageReset() {
  lineage.nodes.clear();
  lineage.children.clear();
  lineage.chromToId = new WeakMap();
  lineage.redirects.clear();
  lineage.structVersion++;
  lineage.prunedSafetyDrops = 0;
  lineage.collapsedMerges = 0;
  lineage.ghostParentsRepaired = 0;
  if (typeof lineageHighlight !== 'undefined') lineageHighlight.ids = new Set();
  if (typeof lineageView !== 'undefined') {
    lineageView.selectedId = null;
    lineageView.hoverId = null;
    lineageView.hoverEdge = null;
  }
  if (typeof hideLineagePopup === 'function') hideLineagePopup();
}

// Bump copies on a sibling-dedup or faithful-clone rebind. Re-animates the node
// (restoring directChildrenAlive on its parents + descendantsAlive on all ancestors)
// if copies had reached 0. holder ∈ {'cell','free'} — which pool the rebound buffer is held in.
function lineageBumpCopies(node, holder) {
  node.copies = (node.copies || 0) + 1;
  node.copiesEver = (node.copiesEver || 0) + 1;
  if (holder === 'cell') node.copiesInCells = (node.copiesInCells || 0) + 1;
  else if (holder === 'free') node.copiesInFree = (node.copiesInFree || 0) + 1;
  if (!node.alive) {
    node.alive = 1;
    node.deathTick = 0;
    for (const pid of node.parents) {
      const pn = lineage.nodes.get(pid);
      if (pn) pn.directChildrenAlive++;
    }
    if (node.contributesToDescendants) lineageWalkAncestorsAlive(node, +1);
  }
}

// holder ∈ {'cell','free'} — which pool the retiring buffer came from.
function lineageMarkDead(idOrChrom, holder) {
  const id = typeof idOrChrom === 'string' ? idOrChrom : getLineageId(idOrChrom);
  if (!id) return;
  const n = lineage.nodes.get(id);
  if (!n || !n.alive) return;
  if (holder === 'cell' && n.copiesInCells > 0) n.copiesInCells--;
  else if (holder === 'free' && n.copiesInFree > 0) n.copiesInFree--;
  if (n.copies > 1) { n.copies--; return; }
  n.copies = 0;
  n.alive = 0;
  n.deathTick = world.tick;
  for (const pid of n.parents) {
    const pn = lineage.nodes.get(pid);
    if (pn && pn.directChildrenAlive > 0) pn.directChildrenAlive--;
  }
  if (n.contributesToDescendants) lineageWalkAncestorsAlive(n, -1);
}

// Transfer the lineage identity from one Uint8Array to another — same logical live
// instance, different JS object. direction ∈ {'sameCell','sameFree','cellToFree','freeToCell'}.
// Pool-crossing directions shift one count from the source pool to the destination pool.
function lineageTransfer(oldChrom, newChrom, direction) {
  const id = getLineageId(oldChrom);
  if (!id) return null;
  lineage.chromToId.set(newChrom, id);
  const n = lineage.nodes.get(id);
  if (!n) return id;
  if (direction === 'cellToFree') {
    if (n.copiesInCells > 0) n.copiesInCells--;
    n.copiesInFree = (n.copiesInFree || 0) + 1;
  } else if (direction === 'freeToCell') {
    if (n.copiesInFree > 0) n.copiesInFree--;
    n.copiesInCells = (n.copiesInCells || 0) + 1;
  }
  return id;
}

// Mint a new lineage node for a buffer that has already been assigned an id via
// earlier transfers (erosion) — e.g. every N bytes eroded, we want a checkpoint
// node with the current byte pattern. Clears the chromToId binding so upsert
// takes the new-node path, then decrements the prior node's refcount for this
// buffer (markDead handles the still-multi-holder case correctly).
function lineageCheckpoint(buf, parents, event, holder) {
  const prevId = getLineageId(buf);
  if (!prevId) return null;
  lineage.chromToId.delete(buf);
  const newId = lineageUpsert(buf, { parents, event, holder, dedup: 'local' });
  if (newId && newId !== prevId) lineageMarkDead(prevId, holder);
  return newId;
}

// Primary parent = the one contributing the most bytes relative to its own length.
// Cached on the node; call after parentBytes is populated (replicase completion).
// Also refreshes node.gen, which tracks depth via the primary-parent chain.
function lineageRecomputePrimary(node) {
  if (!node.parents.length) { node.primaryParentId = null; node.gen = 0; return; }
  if (node.parents.length === 1) {
    node.primaryParentId = node.parents[0];
  } else {
    let bestId = node.parents[0], bestBytes = -1;
    for (let i = 0; i < node.parents.length; i++) {
      const pid = node.parents[i];
      const pn = lineage.nodes.get(pid);
      if (!pn) continue;
      const bytes = node.parentBytes ? (node.parentBytes[i] || 0) : pn.length;
      if (bytes > bestBytes || (bytes === bestBytes && pid < bestId)) { bestBytes = bytes; bestId = pid; }
    }
    node.primaryParentId = bestId;
  }
  const pp = node.primaryParentId ? lineage.nodes.get(node.primaryParentId) : null;
  node.gen = pp ? (pp.gen | 0) + 1 : 0;
}

// Repair counter drift: walk every actual buffer the world holds, recompute
// copies / copiesIn{Cells,Free} / alive / directChildrenAlive / descendantsAlive
// from ground truth. Long-running sessions accumulate "phantom alive" nodes
// when upsert / markDead don't perfectly pair up across all transfer paths;
// this is the canonical fsck. Cheap: O(buffers + N + edges).
function lineageRebuildLiveness() {
  const cellCount = new Map(), freeCount = new Map();
  for (let ci = 0; ci < world.maxCells; ci++) {
    if (!world.alive[ci]) continue;
    const g = world.genomes[ci]; if (!g) continue;
    for (const chrom of g) {
      const id = getLineageId(chrom); if (!id) continue;
      cellCount.set(id, (cellCount.get(id) || 0) + 1);
    }
  }
  for (const fc of world.freeChromosomes) {
    const id = getLineageId(fc.data); if (!id) continue;
    freeCount.set(id, (freeCount.get(id) || 0) + 1);
  }

  for (const [id, n] of lineage.nodes) {
    const c = cellCount.get(id) || 0, f = freeCount.get(id) || 0;
    const wasAlive = !!n.alive;
    n.copiesInCells = c;
    n.copiesInFree  = f;
    n.copies        = c + f;
    n.alive = (n.copies > 0) ? 1 : 0;
    if (wasAlive && !n.alive && !n.deathTick) n.deathTick = world.tick;
    if (!wasAlive && n.alive) n.deathTick = 0;
  }

  for (const n of lineage.nodes.values()) n.directChildrenAlive = 0;
  for (const [pid, kids] of lineage.children) {
    const pn = lineage.nodes.get(pid); if (!pn) continue;
    let live = 0;
    for (const kid of kids) {
      const kn = lineage.nodes.get(kid);
      if (kn && kn.alive) live++;
    }
    pn.directChildrenAlive = live;
  }

  for (const n of lineage.nodes.values()) n.descendantsAlive = 0;
  for (const n of lineage.nodes.values()) {
    if (!n.alive || !n.contributesToDescendants) continue;
    lineageWalkAncestorsAlive(n, +1);
  }

  lineage.structVersion++;
}

// Manual aggressive cleanup. Reconciles counters first, then drops dead nodes
// with no living descendants ignoring the prolific-lineage pin, then collapses
// remaining 1-1 chains the same way. Wired to a "compact tree" button.
function lineageCompact() {
  lineageRebuildLiveness();
  const dropIds = [];
  for (const [id, n] of lineage.nodes) {
    if (n.alive) continue;
    if (n.directChildrenAlive > 0) continue;
    const kids = lineage.children.get(id);
    if (kids && kids.size > 0) continue;
    if ((n.descendantsAlive || 0) > 0) continue;
    dropIds.push(id);
  }
  for (const id of dropIds) lineageDropNode(id);
  lineageChainCollapse(0, /*ignorePin=*/true);
}

function lineagePrune() {
  const now = world.tick;
  const grace = CONFIG.lineageDeadLeafGraceTicks;
  const pin = CONFIG.lineagePreserveCopiesEver | 0;

  // Pass 1 — drop terminal dead-leaves past the grace window. Skip nodes that
  // ever reached the "prolific" threshold so once-successful lineages keep
  // their visual identity even after extinction.
  const dropIds = [];
  for (const [id, n] of lineage.nodes) {
    if (n.alive) continue;
    if (n.directChildrenAlive > 0) continue;
    const kids = lineage.children.get(id);
    if (kids && kids.size > 0) continue;
    if ((n.descendantsAlive || 0) > 0) continue;
    if (pin > 0 && (n.copiesEver || 0) >= pin) continue;
    if (now - n.deathTick < grace) continue;
    dropIds.push(id);
  }
  for (const id of dropIds) lineageDropNode(id);

  // Pass 2 — chain-collapse single-parent/single-child waypoints once we cross
  // the soft threshold; target the soft threshold so the tree stays compact.
  if (lineage.nodes.size >= CONFIG.lineageCollapseSoftThreshold) {
    lineageChainCollapse(CONFIG.lineageCollapseSoftThreshold);
  }

  // Pass 3 — if STILL over cap after collapse, drop oldest dead-leaves. Pinned
  // (prolific) lineages are spared even here; if the cap can't be reached
  // after dropping un-pinned leaves, we simply leave the tree slightly over.
  if (lineage.nodes.size > CONFIG.lineageMaxNodes) {
    const leaves = [];
    for (const [id, n] of lineage.nodes) {
      if (n.alive) continue;
      const kids = lineage.children.get(id);
      if (kids && kids.size > 0) continue;
      if (pin > 0 && (n.copiesEver || 0) >= pin) continue;
      leaves.push(n);
    }
    leaves.sort((a, b) => a.deathTick - b.deathTick);
    while (lineage.nodes.size > CONFIG.lineageMaxNodes && leaves.length) {
      const n = leaves.shift();
      lineageDropNode(n.id);
      lineage.prunedSafetyDrops++;
    }
  }

  // Compact redirect chains so getLineageId does one hop, not N.
  for (const [k, v] of lineage.redirects) {
    if (!lineage.redirects.has(v)) continue;
    let term = v;
    const seen = new Set([k]);
    while (lineage.redirects.has(term) && !seen.has(term)) {
      seen.add(term);
      term = lineage.redirects.get(term);
    }
    lineage.redirects.set(k, term);
  }

  lineageAssertInvariants();
}

// Merge waypoints (1 parent, 1 child, and the child has exactly 1 parent) into the parent.
// Keeps the DAG intact: never touches multi-parent nodes or forks. Pinned
// (prolific) waypoints are skipped so once-successful lineages keep their
// visual identity in the tree even when they happen to sit in a 1-1 chain.
// `ignorePin` (used by lineageCompact) lets a manual cleanup steamroll past pins.
function lineageChainCollapse(target, ignorePin) {
  const pin = ignorePin ? 0 : (CONFIG.lineagePreserveCopiesEver | 0);
  const candidates = [];
  for (const [id, n] of lineage.nodes) {
    if (n.parents.length !== 1) continue;
    const kids = lineage.children.get(id);
    if (!kids || kids.size !== 1) continue;
    const childId = kids.values().next().value;
    const child = lineage.nodes.get(childId);
    if (!child || child.parents.length !== 1) continue;
    if (pin > 0 && Math.max(n.copies | 0, n.copiesEver | 0) >= pin) continue;
    candidates.push({ id, n, childId });
  }
  // Prefer dead, older waypoints first.
  candidates.sort((a, b) => {
    if (a.n.alive !== b.n.alive) return a.n.alive - b.n.alive; // dead first
    return (a.n.deathTick || a.n.birthTick) - (b.n.deathTick || b.n.birthTick);
  });

  for (const { id, n, childId } of candidates) {
    if (lineage.nodes.size < target) break;
    if (!lineage.nodes.has(id)) continue;
    if (n.parents.length !== 1) continue;
    const kids = lineage.children.get(id);
    if (!kids || kids.size !== 1) continue;
    if (!lineage.nodes.has(childId)) continue;
    const child = lineage.nodes.get(childId);
    if (child.parents.length !== 1) continue;

    const parentId = n.parents[0];
    const parent = lineage.nodes.get(parentId);
    if (!parent) continue;

    child.parents[0] = parentId;
    if (child.parentBytes) child.parentBytes = null;
    lineageRemoveChild(id, childId);
    lineageAddChild(parentId, childId);

    if (child.primaryParentId === id) child.primaryParentId = parentId;
    lineageRecomputePrimary(child);

    const parentWasAlive = !!parent.alive;
    parent.copiesInCells = (parent.copiesInCells || 0) + (n.copiesInCells || 0);
    parent.copiesInFree  = (parent.copiesInFree  || 0) + (n.copiesInFree  || 0);
    parent.copies        = (parent.copies        || 0) + (n.copies        || 0);
    parent.copiesEver    = (parent.copiesEver    || 0) + (n.copiesEver    || 0);
    if (n.alive && !parentWasAlive) {
      parent.alive = 1;
      parent.deathTick = 0;
      for (const gpid of parent.parents) {
        const gpn = lineage.nodes.get(gpid);
        if (gpn) gpn.directChildrenAlive++;
      }
      if (parent.contributesToDescendants) lineageWalkAncestorsAlive(parent, +1);
    }
    if (n.alive && parent.directChildrenAlive > 0) parent.directChildrenAlive--;
    if (child.alive) parent.directChildrenAlive++;
    if (n.alive && n.contributesToDescendants) lineageWalkAncestorsAlive(n, -1);

    parent.mergedCount += 1 + n.mergedCount;

    lineageRemoveChild(parentId, id);
    lineage.nodes.delete(id);
    lineage.redirects.set(id, parentId);
    lineage.collapsedMerges++;
  }
  lineage.structVersion++;
}

function lineageDropNode(id) {
  const n = lineage.nodes.get(id);
  if (!n) return;

  const kids = lineage.children.get(id);
  if (kids) {
    for (const childId of kids) {
      const child = lineage.nodes.get(childId);
      if (!child) continue;
      const idx = child.parents.indexOf(id);
      if (idx >= 0) {
        child.parents.splice(idx, 1);
        if (child.parentBytes) child.parentBytes.splice(idx, 1);
      }
      for (const gp of n.parents) {
        if (!lineage.nodes.has(gp)) continue;
        if (child.parents.indexOf(gp) < 0) {
          child.parents.push(gp);
          if (child.parentBytes) child.parentBytes.push(0);
          lineageAddChild(gp, childId);
          if (child.alive) {
            const gpn = lineage.nodes.get(gp);
            if (gpn) gpn.directChildrenAlive++;
          }
        }
      }
      if (child.primaryParentId === id) lineageRecomputePrimary(child);
    }
  }

  for (const pid of n.parents) {
    lineageRemoveChild(pid, id);
    if (n.alive) {
      const pn = lineage.nodes.get(pid);
      if (pn && pn.directChildrenAlive > 0) pn.directChildrenAlive--;
    }
  }
  if (n.alive && n.contributesToDescendants) lineageWalkAncestorsAlive(n, -1);

  lineage.children.delete(id);
  lineage.nodes.delete(id);

  let survivor = null;
  for (const pid of n.parents) { if (lineage.nodes.has(pid)) { survivor = pid; break; } }
  lineage.redirects.set(id, survivor);

  lineage.structVersion++;

  lineageCascadeDropDeadAncestors(n.parents);
}

function lineageCascadeDropDeadAncestors(parents) {
  const queue = parents.slice();
  const seen = new Set();
  const grace = CONFIG.lineageDeadLeafGraceTicks;
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const pn = lineage.nodes.get(pid);
    if (!pn || pn.alive) continue;
    if (pn.directChildrenAlive > 0) continue;
    const kids = lineage.children.get(pid);
    if (kids && kids.size > 0) continue;
    if ((pn.descendantsAlive || 0) > 0) continue;
    if (world.tick - pn.deathTick < grace) continue;
    const up = pn.parents.slice();
    lineageDropNode(pid);
    for (const gp of up) queue.push(gp);
  }
}

function lineageStats() {
  let alive = 0, ghost = 0, dead = 0, copies = 0;
  for (const n of lineage.nodes.values()) {
    if (!n.alive) { dead++; continue; }
    copies += n.copies || 1;
    if ((n.copiesInCells || 0) > 0) alive++;
    else ghost++;
  }
  return { total: lineage.nodes.size, alive, ghost, dead, copies, merges: lineage.collapsedMerges };
}

// Debug-only: walk every live buffer the world holds and assert the per-node
// counters match. Gated on CONFIG.lineageDebugAssert so production runs pay nothing.
function lineageAssertInvariants() {
  if (!CONFIG.lineageDebugAssert) return;

  const cellCount = new Map(), freeCount = new Map();
  for (let ci = 0; ci < world.maxCells; ci++) {
    if (!world.alive[ci]) continue;
    const g = world.genomes[ci]; if (!g) continue;
    for (const chrom of g) {
      const id = getLineageId(chrom); if (!id) continue;
      cellCount.set(id, (cellCount.get(id) || 0) + 1);
    }
  }
  for (const fc of world.freeChromosomes) {
    const id = getLineageId(fc.data); if (!id) continue;
    freeCount.set(id, (freeCount.get(id) || 0) + 1);
  }

  for (const [id, n] of lineage.nodes) {
    const c = cellCount.get(id) || 0, f = freeCount.get(id) || 0;
    if ((n.copiesInCells || 0) !== c) console.error(`[lineage INV-1] copiesInCells drift ${id}: node=${n.copiesInCells} observed=${c}`);
    if ((n.copiesInFree  || 0) !== f) console.error(`[lineage INV-1] copiesInFree drift ${id}: node=${n.copiesInFree} observed=${f}`);
    if ((n.copies || 0) !== c + f)    console.error(`[lineage INV-1] copies drift ${id}: node=${n.copies} observed=${c + f}`);
    if (!!n.alive !== ((n.copies || 0) > 0)) console.error(`[lineage INV-1] alive drift ${id}: alive=${n.alive} copies=${n.copies}`);
  }

  for (const [id, kids] of lineage.children) {
    const n = lineage.nodes.get(id); if (!n) continue;
    let live = 0;
    for (const kid of kids) { const kn = lineage.nodes.get(kid); if (kn && kn.alive) live++; }
    if (n.directChildrenAlive !== live) console.error(`[lineage INV-2] directChildrenAlive drift ${id}: node=${n.directChildrenAlive} observed=${live}`);
  }

  for (const [id, n] of lineage.nodes) {
    const seen = new Set();
    const stack = [...(lineage.children.get(id) || [])];
    let cnt = 0;
    while (stack.length) {
      const d = stack.pop();
      if (seen.has(d)) continue;
      seen.add(d);
      const dn = lineage.nodes.get(d); if (!dn) continue;
      if (dn.alive && dn.contributesToDescendants) cnt++;
      const kids = lineage.children.get(d);
      if (kids) for (const k of kids) stack.push(k);
    }
    if ((n.descendantsAlive || 0) !== cnt) console.error(`[lineage INV-3] descendantsAlive drift ${id}: node=${n.descendantsAlive} observed=${cnt}`);
  }
}
