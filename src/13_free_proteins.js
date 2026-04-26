// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// FREE PROTEINS IN MEDIUM (dense live-index list)
// ============================================================
// See 10_photons.js header for the live-list convention.

function _allocFreePSlot() {
  if (world.freePLiveCount >= CONFIG.maxFreeProteins) return -1;
  const slot = world.freePLive[world.freePLiveCount];
  world.freePLiveIdx[slot] = world.freePLiveCount;
  world.freePLiveCount++;
  world.freeP_alive[slot] = 1;
  world.freePCount++;
  return slot;
}

function _freeFreePBucket(i) {
  const gcs = world.gridCellSize, gw = world.gridW, gh = world.gridH;
  let gx = (world.freeP_x[i] / gcs) | 0; if (gx < 0) gx = 0; else if (gx >= gw) gx = gw - 1;
  let gy = (world.freeP_y[i] / gcs) | 0; if (gy < 0) gy = 0; else if (gy >= gh) gy = gh - 1;
  return gy * gw + gx;
}

function _removeFreePFromBucket(bucket, slot) {
  const k = bucket.indexOf(slot);
  if (k < 0) return;
  const last = bucket.length - 1;
  if (k !== last) bucket[k] = bucket[last];
  bucket.pop();
}

function _freeFreePSlot(slot) {
  // Remove from its current bucket (if any).
  const oldB = world.freePGridIdx[slot];
  if (oldB >= 0) _removeFreePFromBucket(world.freePGrid[oldB], slot);
  world.freePGridIdx[slot] = -1;

  const j = world.freePLiveIdx[slot];
  const last = world.freePLiveCount - 1;
  const lastSlot = world.freePLive[last];
  world.freePLive[j] = lastSlot;
  world.freePLiveIdx[lastSlot] = j;
  world.freePLive[last] = slot;
  world.freePLiveIdx[slot] = last;
  world.freePLiveCount--;
  world.freeP_alive[slot] = 0;
  world.freePCount--;
}

function spawnFreeProtein(x, y, type) {
  const slot = _allocFreePSlot();
  if (slot === -1) return; // buffer full — drop (acceptable overflow behavior)
  world.freeP_x[slot] = x; world.freeP_y[slot] = y;
  world.freeP_vx[slot] = (world.rng.next() - 0.5) * 0.5;
  world.freeP_vy[slot] = (world.rng.next() - 0.5) * 0.5;
  world.freeP_type[slot] = type;
  const b = _freeFreePBucket(slot);
  world.freePGrid[b].push(slot);
  world.freePGridIdx[slot] = b;
  world.milestones.freePSpawned++;
}

function rebuildFreeProteinGrid() {
  // Incremental — only free proteins that crossed a bucket edge move.
  for (let j = 0; j < world.freePLiveCount; j++) {
    const i = world.freePLive[j];
    const newB = _freeFreePBucket(i);
    const oldB = world.freePGridIdx[i];
    if (oldB === newB) continue;
    if (oldB >= 0) _removeFreePFromBucket(world.freePGrid[oldB], i);
    world.freePGrid[newB].push(i);
    world.freePGridIdx[i] = newB;
  }
}

function freeProteinTick() {
  const ww = CONFIG.worldWidth, wh = CONFIG.worldHeight;
  const drift = CONFIG.freeProteinDrift;
  const decay = CONFIG.freeProteinDecayRate;
  let j = 0;
  while (j < world.freePLiveCount) {
    const i = world.freePLive[j];
    // Brownian drift
    world.freeP_vx[i] += (world.rng.next() - 0.5) * drift;
    world.freeP_vy[i] += (world.rng.next() - 0.5) * drift;
    world.freeP_vx[i] *= 0.98; world.freeP_vy[i] *= 0.98;
    world.freeP_x[i] += world.freeP_vx[i]; world.freeP_y[i] += world.freeP_vy[i];
    // Wall bounce
    if (world.freeP_x[i] < 0) { world.freeP_x[i] = 0; world.freeP_vx[i] *= -1; }
    else if (world.freeP_x[i] > ww) { world.freeP_x[i] = ww; world.freeP_vx[i] *= -1; }
    if (world.freeP_y[i] < 0) { world.freeP_y[i] = 0; world.freeP_vy[i] *= -1; }
    else if (world.freeP_y[i] > wh) { world.freeP_y[i] = wh; world.freeP_vy[i] *= -1; }
    // Decay
    if (world.rng.next() < decay) {
      _freeFreePSlot(i);
      continue; // swapped-in slot now at j
    }
    j++;
  }
}
