// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// MULTIVERSE — world identity + adjacency placement.
// ============================================================
// Each tab session is one "world" in a multiverse of worlds running in sibling
// tabs. Identity: a fresh uuid + random color generated at boot (NOT seeded —
// reload of the same seed gets a new color). Position: integer (mx, my) on a
// 2D grid, picked by scanning what's already out there and slotting in next
// to one existing world. Comms: 23d_portal_bus.js owns the channel; we just
// emit/consume the boot-time messages and the steady-state heartbeats.
// ============================================================

// Init identity. Called once before bootMultiverse(). Idempotent — guarded by
// presence of world.uuid so re-init (e.g. via load) doesn't change identity.
function initMultiverseIdentity() {
  if (world.uuid) return;
  world.uuid = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : _fallbackUuid();
  // Per-tab identity color. NOT seed-derived — the multiverse position/color
  // is about the tab's role, not the simulation's deterministic state.
  const hue = Math.floor(Math.random() * 360);
  world.color = `hsl(${hue}, 70%, 60%)`;
  world.knownWorlds = new Map();
  world.neighbors = { left: null, right: null, top: null, bottom: null };
}

function _fallbackUuid() {
  // Sufficient for same-PC tab discrimination; not a security UUID.
  const r = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${r()}-${r()}-${r()}-${r()}`;
}

// Free 4-neighbor cells around the union of known worlds. Returns a list of
// {mx, my, neighbours, bbMax, bbArea} entries, ordered so cands[0] is the
// preferred slot:
//   1. most occupied 4-neighbours (fills concave corners first)
//   2. smallest max(bbWidth, bbHeight) of the cluster after placement (keeps
//      the cluster as close to square as possible)
//   3. smallest bbWidth*bbHeight (secondary compactness signal)
//   4. lex-smallest (mx, my) — deterministic final tie-break
// This makes a fresh multiverse grow as 1 → 2 → L → 2×2 → 3×2 → 3×3 → …
// instead of stretching into a line.
function _freeAdjacencyCandidates() {
  if (world.knownWorlds.size === 0) return [];

  const occupied = new Set();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [, w] of world.knownWorlds) {
    occupied.add(`${w.mx},${w.my}`);
    if (w.mx < minX) minX = w.mx;
    if (w.mx > maxX) maxX = w.mx;
    if (w.my < minY) minY = w.my;
    if (w.my > maxY) maxY = w.my;
  }

  const cands = new Map();   // key -> {mx, my, neighbours}
  for (const [, w] of world.knownWorlds) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const cx = w.mx + dx, cy = w.my + dy;
      const k = `${cx},${cy}`;
      if (occupied.has(k)) continue;
      const cur = cands.get(k);
      if (cur) cur.neighbours++;
      else cands.set(k, { mx: cx, my: cy, neighbours: 1 });
    }
  }

  const out = [];
  for (const c of cands.values()) {
    const bw = Math.max(maxX, c.mx) - Math.min(minX, c.mx) + 1;
    const bh = Math.max(maxY, c.my) - Math.min(minY, c.my) + 1;
    c.bbMax = Math.max(bw, bh);
    c.bbArea = bw * bh;
    out.push(c);
  }
  out.sort((a, b) =>
    (b.neighbours - a.neighbours) ||
    (a.bbMax - b.bbMax) ||
    (a.bbArea - b.bbArea) ||
    (a.mx - b.mx) || (a.my - b.my)
  );
  return out;
}

// Given knownWorlds + our (mx, my), populate world.neighbors[side] with the
// uuid of the adjacent world (if any).
function _recomputeNeighbors() {
  const sides = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
  for (const side in sides) {
    const [dx, dy] = sides[side];
    const tx = world.multiverseX + dx, ty = world.multiverseY + dy;
    let found = null;
    for (const [uuid, w] of world.knownWorlds) {
      if (w.mx === tx && w.my === ty) { found = uuid; break; }
    }
    world.neighbors[side] = found;
  }
}

// Promise-returning placement. Caller (24_main_loop.js) awaits this before
// flipping the multiverseReady flag and starting the tick loop.
//
// Wrapped in navigator.locks to serialize boot-time placement so two
// simultaneously-opened tabs don't pick the same coord. Falls back to
// best-effort lex-smallest pick if the Locks API is unavailable.
async function bootMultiverse() {
  initMultiverseIdentity();
  portalBusOpen();   // 23d_portal_bus.js — sets up onmessage dispatch

  const placeBody = async () => {
    portalBusSend({ type: 'whois', srcWorldUuid: world.uuid });
    await new Promise(resolve => setTimeout(resolve, CONFIG.portalBootScanMs));
    if (world.knownWorlds.size === 0) {
      world.multiverseX = 0;
      world.multiverseY = 0;
    } else {
      const cands = _freeAdjacencyCandidates();
      const pick = cands[0];   // lex-smallest
      world.multiverseX = pick.mx;
      world.multiverseY = pick.my;
    }
    _recomputeNeighbors();
    portalBusSend({
      type: 'iam',
      srcWorldUuid: world.uuid,
      mx: world.multiverseX,
      my: world.multiverseY,
      color: world.color,
    });
  };

  if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
    await navigator.locks.request('evonet-multiverse-place', placeBody);
  } else {
    await placeBody();
  }

  // bye on unload — neighbors null out our side and desaturate the strip.
  window.addEventListener('beforeunload', () => {
    portalBusSend({ type: 'bye', srcWorldUuid: world.uuid });
  });

  world.multiverseReady = true;
}

// Heartbeat tick — called from the main tick loop every CONFIG.portalHeartbeatTicks.
// Re-broadcasts our iam so late-joining tabs (and tabs that missed the boot
// chatter) see us, and prunes neighbors we haven't heard from in 3 heartbeats.
function multiverseHeartbeatTick() {
  if (!world.multiverseReady) return;
  if ((world.tick % CONFIG.portalHeartbeatTicks) !== 0) return;
  portalBusSend({
    type: 'iam',
    srcWorldUuid: world.uuid,
    mx: world.multiverseX,
    my: world.multiverseY,
    color: world.color,
  });
  // Stale prune. lastSeenTick is set by 23d_portal_bus.js on every iam.
  const stale = world.tick - 3 * CONFIG.portalHeartbeatTicks;
  for (const [uuid, w] of world.knownWorlds) {
    if (w.lastSeenTick < stale) {
      world.knownWorlds.delete(uuid);
    }
  }
  _recomputeNeighbors();
}

// Called from 23d_portal_bus.js on every iam. Updates knownWorlds + neighbors.
// Returns true if this is a fresh world we hadn't seen.
function multiverseObserveIam(srcUuid, mx, my, color) {
  if (srcUuid === world.uuid) return false;
  const existing = world.knownWorlds.get(srcUuid);
  const fresh = !existing;
  world.knownWorlds.set(srcUuid, { mx, my, color, lastSeenTick: world.tick });
  _recomputeNeighbors();
  return fresh;
}

// Called from 23d_portal_bus.js on bye.
function multiverseObserveBye(srcUuid) {
  if (world.knownWorlds.delete(srcUuid)) _recomputeNeighbors();
}

// Build a stats sample for self. Shared shape with the world-stats payload so
// remote observers can stash these directly into knownWorlds[uuid].statsHistory.
function _buildSelfStatsSample() {
  let n = 0, totalE = 0;
  for (let i = 0; i < world.maxCells; i++) {
    if (world.alive[i]) { n++; totalE += world.energy[i]; }
  }
  return {
    tick: world.tick,
    ts: Date.now(),
    numCells: n,
    totalEnergy: totalE,
    freeP: world.freePCount | 0,
    freeChrom: world.freeChromosomes ? world.freeChromosomes.length : 0,
    tps: (typeof currentTps !== 'undefined') ? currentTps : 0,
  };
}

function _trimHistory(arr, cap) {
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

// Heartbeat — sends our own stats sample to the bus and appends it to our
// local statsHistory. Runs at CONFIG.multiverseStatsTicks cadence.
function multiverseStatsHeartbeatTick() {
  if (!world.multiverseReady) return;
  if ((world.tick % CONFIG.multiverseStatsTicks) !== 0) return;
  const sample = _buildSelfStatsSample();
  world.statsHistory.push(sample);
  _trimHistory(world.statsHistory, CONFIG.multiverseStatsHistory);
  portalBusSend({
    type: 'world-stats',
    srcWorldUuid: world.uuid,
    mx: world.multiverseX,
    my: world.multiverseY,
    color: world.color,
    ...sample,
  });
}

// Called from 23d_portal_bus.js on every world-stats from a remote tab.
// Stashes the sample into knownWorlds[uuid].statsHistory. If the stats arrived
// before the iam (rare ordering quirk), creates a stub entry from the message
// fields so the viewer can still render something while iam catches up.
function multiverseObserveStats(srcUuid, m) {
  if (srcUuid === world.uuid) return;
  let entry = world.knownWorlds.get(srcUuid);
  if (!entry) {
    entry = {
      mx: m.mx | 0, my: m.my | 0,
      color: m.color || '#888',
      lastSeenTick: world.tick,
      statsHistory: [],
    };
    world.knownWorlds.set(srcUuid, entry);
    _recomputeNeighbors();
  }
  if (!entry.statsHistory) entry.statsHistory = [];
  entry.statsHistory.push({
    tick: m.tick | 0,
    ts: Date.now(),
    numCells: m.numCells | 0,
    totalEnergy: +m.totalEnergy || 0,
    freeP: m.freeP | 0,
    freeChrom: m.freeChrom | 0,
    tps: +m.tps || 0,
  });
  _trimHistory(entry.statsHistory, CONFIG.multiverseStatsHistory);
  entry.lastSeenTick = world.tick;
}
