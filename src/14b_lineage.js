// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// LINEAGE — DNA-level family tree.
//
// Every distinct Uint8Array chromosome that ever exists gets a monotonic
// lineage id. Nodes record parents (0..N), parentBytes (per-parent byte
// contribution from replicase), birthTick, event, liveness. We also keep a
// reverse `children` index so the renderer + pruner can walk down cheaply.
//
// Prune policy:
//  - Terminal dead-leaf (no children ever) dropped after lineageDeadLeafGraceTicks.
//  - Chain-collapse waypoints when total > lineageMaxNodes: merge single-parent
//    single-child nodes into their parent (preserving the DAG; never merges
//    nodes with >1 parent or whose child has >1 parent).
//  - Truly cap-exceeding: drop oldest dead-leaf outright.
// ============================================================
const lineage = {
  nextId: 1,
  nodes: new Map(),              // id -> node record
  children: new Map(),           // parentId -> Set<childId>
  chromToId: new WeakMap(),      // Uint8Array -> id
  redirects: new Map(),          // deletedId -> survivorId (or -1 if truly orphaned) — resolves ghost IDs to living ancestors
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

// holder ∈ {'cell', 'free'} — which pool the new buffer is held in. Drives the
// per-pool counters that back the renderer's alive/ghost/dead tri-state.
// parentBytes is the per-parent contribution array from replicase (aligned with
// `parents`); optional, used only for the multi-parent identical-match tiebreak.
function assignLineage(chrom, parents, event, holder, parentBytes) {
  if (!chrom || !(chrom instanceof Uint8Array)) return -1;
  const existing = lineage.chromToId.get(chrom);
  if (existing !== undefined) return existing;

  const parentsArr = parents ? parents.filter(p => p > 0 && lineage.nodes.has(p)) : [];

  // Zero-mutation single-parent copy = same chromosome, not a new lineage entry.
  // Rebind the fresh buffer onto the parent's id and return it.
  if (parentsArr.length === 1) {
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

  // Multi-parent identical-match: a recombination child can happen to be
  // byte-identical to one of its parents. Rebind onto that parent rather than
  // minting a redundant lineage node. Tiebreak: parent that contributed the
  // most bytes; equal bytes → smallest parent id (matches lineageRecomputePrimary).
  if (parentsArr.length > 1) {
    let bestId = -1, bestBytes = -1;
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
      if (bytes > bestBytes || (bytes === bestBytes && (bestId < 0 || pid < bestId))) {
        bestBytes = bytes; bestId = pid;
      }
    }
    if (bestId > 0) {
      const winner = lineage.nodes.get(bestId);
      lineage.chromToId.set(chrom, winner.id);
      lineageBumpCopies(winner, holder);
      return winner.id;
    }
  }

  // Sibling dedup: partial replication often emits several byte-identical
  // chromosomes from the same parent set. Collapse them onto the first-recorded
  // sibling so the DNA tree doesn't fan out into crowds of identical leaves.
  if (parentsArr.length >= 1) {
    const parentKey = parentsArr.slice().sort((a, b) => a - b);
    // Scan children of the parent with the smallest child-set (cheapest).
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
        const sParents = s.parents.slice().sort((a, b) => a - b);
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

  const id = lineage.nextId++;
  // Checkpoint events (degradation / digestion) represent the SAME chromosome
  // losing bytes, not a new descendant. We mark these so ancestor counters
  // don't inflate every 8 bytes of erosion.
  const isCheckpointEvent = event === 'degrade-checkpoint' || event === 'digest-checkpoint';
  const node = {
    id,
    parents: parentsArr,
    parentBytes: null,         // aligned with parents[]; null for non-replicase events
    shape: chromosomeShape(chrom),
    length: chrom.length,
    hashPrefix: lineageHashPrefix(chrom),
    // Full byte snapshot frozen at birth — the inspector renders this so the user
    // sees exactly what the chromosome was at the moment it was recorded. Copy
    // (don't alias) so later in-place mutation of the buffer doesn't rewrite history.
    data: new Uint8Array(chrom),
    birthTick: world.tick,
    event: event || 'unknown',
    alive: 1,
    copies: 1,                 // total live byte-identical instances collapsed onto this node
    copiesInCells: holder === 'cell' ? 1 : 0,
    copiesInFree:  holder === 'free' ? 1 : 0,
    copiesEver: 1,             // cumulative count — includes rebinds, never decremented
    directChildrenAlive: 0,
    descendantsEver: 0,        // monotonic; inspector-only stat. Not read by prune.
    descendantsAlive: 0,       // current count of transitively-alive descendants; retention key.
    // Whether this node's own liveness counts toward its ancestors' descendantsAlive.
    // False for checkpoints — degradation is the same chromosome, not a new descendant.
    contributesToDescendants: !isCheckpointEvent,
    deathTick: 0,
    mergedCount: 0,            // how many collapsed waypoints are "summarised" by this node
    primaryParentId: parentsArr.length ? parentsArr[0] : -1, // recomputed once parentBytes is set
    gen: 0,                    // generation depth via primary-parent chain; recomputed with primaryParentId
  };
  lineage.nodes.set(id, node);
  lineage.chromToId.set(chrom, id);
  if (node.primaryParentId > 0) {
    const pn = lineage.nodes.get(node.primaryParentId);
    if (pn) node.gen = (pn.gen | 0) + 1;
  }

  // Reverse index + rollups.
  for (const pid of parentsArr) {
    lineageAddChild(pid, id);
    const pn = lineage.nodes.get(pid);
    if (pn) pn.directChildrenAlive++;
  }

  // descendantsEver + descendantsAlive rollup on ancestor chain (bounded by
  // seen-set to handle DAG merges). Checkpoint nodes are the same chromosome,
  // not a new descendant — skip the rollup entirely for them.
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
  return id;
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

function getLineageId(chrom) {
  if (!chrom) return -1;
  let id = lineage.chromToId.get(chrom);
  if (id === undefined) return -1;
  // Follow redirects if the node was deleted (collapsed/dropped).
  if (lineage.redirects.size && lineage.redirects.has(id)) {
    const seen = new Set();
    let followed = false;
    while (lineage.redirects.has(id) && !seen.has(id)) { seen.add(id); id = lineage.redirects.get(id); followed = true; }
    if (followed) lineage.ghostParentsRepaired++;
    if (id > 0 && lineage.nodes.has(id)) lineage.chromToId.set(chrom, id); // collapse chain for next time
    else return -1;
  }
  return lineage.nodes.has(id) ? id : -1;
}

function lineageGetNode(id) { return lineage.nodes.get(id); }

// Wipe all lineage state to a freshly-initialised, empty form. Called from
// restart and load — both paths replace world state, so the lineage tree must
// not carry over (otherwise nodes from the prior run dangle in the renderer).
// Also clears the renderer-side highlight set, popup selection, and bumps
// structVersion so the layout cache rebuilds.
function lineageReset() {
  lineage.nextId = 1;
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
    lineageView.selectedId = -1;
    lineageView.hoverId = -1;
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
  const id = typeof idOrChrom === 'number' ? idOrChrom : getLineageId(idOrChrom);
  if (id <= 0) return;
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
  if (id <= 0) return id;
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
// node with the current byte pattern. Clears the chromToId binding so assignLineage
// takes the new-node path, then decrements the prior node's refcount for this
// buffer (markDead handles the still-multi-holder case correctly).
function lineageCheckpoint(buf, parents, event, holder) {
  const prevId = getLineageId(buf);
  if (prevId <= 0) return -1;
  lineage.chromToId.delete(buf);
  const newId = assignLineage(buf, parents, event, holder);
  if (newId > 0 && newId !== prevId) lineageMarkDead(prevId, holder);
  return newId;
}

// Primary parent = the one contributing the most bytes relative to its own length.
// Cached on the node; call after parentBytes is populated (replicase completion).
// Also refreshes node.gen, which tracks depth via the primary-parent chain.
function lineageRecomputePrimary(node) {
  if (!node.parents.length) { node.primaryParentId = -1; node.gen = 0; return; }
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
  const pp = node.primaryParentId > 0 ? lineage.nodes.get(node.primaryParentId) : null;
  node.gen = pp ? (pp.gen | 0) + 1 : 0;
}

// Repair counter drift: walk every actual buffer the world holds, recompute
// copies / copiesIn{Cells,Free} / alive / directChildrenAlive / descendantsAlive
// from ground truth. Long-running sessions accumulate "phantom alive" nodes
// when assignLineage / lineageMarkDead don't perfectly pair up across all
// transfer paths; this is the canonical fsck. Cheap: O(buffers + N + edges).
function lineageRebuildLiveness() {
  const cellCount = new Map(), freeCount = new Map();
  for (let ci = 0; ci < world.maxCells; ci++) {
    if (!world.alive[ci]) continue;
    const g = world.genomes[ci]; if (!g) continue;
    for (const chrom of g) {
      const id = getLineageId(chrom); if (id <= 0) continue;
      cellCount.set(id, (cellCount.get(id) || 0) + 1);
    }
  }
  for (const fc of world.freeChromosomes) {
    const id = getLineageId(fc.data); if (id <= 0) continue;
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
    if (kids && kids.size > 0) continue; // still has descendants in the graph
    if ((n.descendantsAlive || 0) > 0) continue;                             // subtree still has live descendants — keep
    if (pin > 0 && (n.copiesEver || 0) >= pin) continue;                     // pinned: prolific lineage preserved
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
    // Re-verify (earlier collapses may have changed this node's situation).
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

    // Rewire: child's parent becomes `parentId` (was `id`).
    child.parents[0] = parentId;
    if (child.parentBytes) {
      // Scale to the new parent's length — approximate; we don't know the historical byte path.
      // Use the child's own length as a safe stand-in (frac = child.length / parent.length mapped later).
      // Simpler: drop parentBytes after collapse; renderer falls back to frac=1.0.
      child.parentBytes = null;
    }
    lineageRemoveChild(id, childId);
    lineageAddChild(parentId, childId);

    // Transfer primary-parent if it pointed at the waypoint, then refresh gen.
    if (child.primaryParentId === id) child.primaryParentId = parentId;
    lineageRecomputePrimary(child);

    // Transfer refcount state from waypoint into the kept parent. Post-collapse,
    // chromosomes whose chromToId still points at K will resolve to P via the
    // redirect below — so P must carry K's liveness and its cell/free counts.
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
      if (parent.contributesToDescendants) lineageWalkAncestorsAlive(parent, +1); // P just came alive — ancestors gain 1 for P (unless P is a checkpoint)
    }
    // directChildrenAlive: parent loses K if K was alive (K is about to be deleted);
    // gains the rewired child if that child is alive (K used to be that slot).
    if (n.alive && parent.directChildrenAlive > 0) parent.directChildrenAlive--;
    if (child.alive) parent.directChildrenAlive++;
    // K's own liveness contribution to its ancestors is gone (unless K never contributed).
    if (n.alive && n.contributesToDescendants) lineageWalkAncestorsAlive(n, -1);

    // Increment merge counter on parent so UI can show "[+3 collapsed]".
    parent.mergedCount += 1 + n.mergedCount;

    // Remove the waypoint itself.
    lineageRemoveChild(parentId, id);
    lineage.nodes.delete(id);
    lineage.redirects.set(id, parentId); // any chromosome still pointing at this id resolves to the kept parent
    lineage.collapsedMerges++;
  }
  lineage.structVersion++;
}

function lineageDropNode(id) {
  const n = lineage.nodes.get(id);
  if (!n) return;

  // Reparent living children onto this node's parents (keeps DAG connected).
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
        if (!lineage.nodes.has(gp)) continue; // don't re-attach onto dead/missing ancestors
        if (child.parents.indexOf(gp) < 0) {
          child.parents.push(gp);
          if (child.parentBytes) child.parentBytes.push(0);
          lineageAddChild(gp, childId);
          // The reparented edge moves a (possibly alive) direct child onto gp —
          // bump gp's counter so prune's keep-alive gate stays accurate.
          if (child.alive) {
            const gpn = lineage.nodes.get(gp);
            if (gpn) gpn.directChildrenAlive++;
          }
        }
      }
      if (child.primaryParentId === id) lineageRecomputePrimary(child);
    }
  }

  // Remove ourselves from our parents' children index. If we were alive at drop
  // time, decrement their directChildrenAlive too (normally n is already dead
  // when we land here, but Pass-3 safety drops can race).
  for (const pid of n.parents) {
    lineageRemoveChild(pid, id);
    if (n.alive) {
      const pn = lineage.nodes.get(pid);
      if (pn && pn.directChildrenAlive > 0) pn.directChildrenAlive--;
    }
  }
  // If we were alive, subtract our self-contribution from every ancestor's
  // descendantsAlive. (Our own descendants re-parent onto our parents — their
  // contributions are preserved via DAG walks.) Checkpoints never contributed.
  if (n.alive && n.contributesToDescendants) lineageWalkAncestorsAlive(n, -1);

  lineage.children.delete(id);
  lineage.nodes.delete(id);

  // Record redirect so any chromosome whose chromToId still points here resolves to a living ancestor.
  let survivor = -1;
  for (const pid of n.parents) { if (lineage.nodes.has(pid)) { survivor = pid; break; } }
  lineage.redirects.set(id, survivor);

  lineage.structVersion++;

  // Cascade: if a parent is now a dead orphan (no kids, under keep threshold, past grace), drop it too.
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
    if ((pn.descendantsAlive || 0) > 0) continue; // subtree still has live descendants — keep
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
      const id = getLineageId(chrom); if (id <= 0) continue;
      cellCount.set(id, (cellCount.get(id) || 0) + 1);
    }
  }
  for (const fc of world.freeChromosomes) {
    const id = getLineageId(fc.data); if (id <= 0) continue;
    freeCount.set(id, (freeCount.get(id) || 0) + 1);
  }

  // INV-1 — pool counters match observed live buffers.
  for (const [id, n] of lineage.nodes) {
    const c = cellCount.get(id) || 0, f = freeCount.get(id) || 0;
    if ((n.copiesInCells || 0) !== c) console.error(`[lineage INV-1] copiesInCells drift #${id}: node=${n.copiesInCells} observed=${c}`);
    if ((n.copiesInFree  || 0) !== f) console.error(`[lineage INV-1] copiesInFree drift #${id}: node=${n.copiesInFree} observed=${f}`);
    if ((n.copies || 0) !== c + f)    console.error(`[lineage INV-1] copies drift #${id}: node=${n.copies} observed=${c + f}`);
    if (!!n.alive !== ((n.copies || 0) > 0)) console.error(`[lineage INV-1] alive drift #${id}: alive=${n.alive} copies=${n.copies}`);
  }

  // INV-2 — directChildrenAlive equals observed alive-kid count.
  for (const [id, kids] of lineage.children) {
    const n = lineage.nodes.get(id); if (!n) continue;
    let live = 0;
    for (const kid of kids) { const kn = lineage.nodes.get(kid); if (kn && kn.alive) live++; }
    if (n.directChildrenAlive !== live) console.error(`[lineage INV-2] directChildrenAlive drift #${id}: node=${n.directChildrenAlive} observed=${live}`);
  }

  // INV-3 — descendantsAlive equals transitive count of alive, contributing descendants
  // (checkpoints are the same chromosome, not distinct descendants — they're excluded).
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
    if ((n.descendantsAlive || 0) !== cnt) console.error(`[lineage INV-3] descendantsAlive drift #${id}: node=${n.descendantsAlive} observed=${cnt}`);
  }
}
