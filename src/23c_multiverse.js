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

// Free 4-neighbor cells around the union of known worlds. Returns sorted
// list of {mx, my} strings (we use string keys for set semantics).
function _freeAdjacencyCandidates() {
  const occupied = new Set();
  for (const [, w] of world.knownWorlds) occupied.add(`${w.mx},${w.my}`);
  const candidates = new Set();
  for (const [, w] of world.knownWorlds) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = `${w.mx + dx},${w.my + dy}`;
      if (!occupied.has(k)) candidates.add(k);
    }
  }
  return [...candidates].map(k => {
    const [mx, my] = k.split(',').map(Number);
    return { mx, my };
  }).sort((a, b) => a.mx - b.mx || a.my - b.my);
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
