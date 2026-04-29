// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// SPATIAL GRID (incremental)
// ============================================================
// world.cellGridIdx[i] is the linear bucket (gy*gridW + gx) that cell i is
// currently stored in, or -1 if not in the grid. On each tick we only move
// the cells whose computed bucket changed — most cells don't cross bucket
// edges, so this is effectively O(movers + sparse alive scan).

function _cellBucket(i) {
  const gcs = world.gridCellSize;
  let gx = (world.pos_x[i] / gcs) | 0; if (gx < 0) gx = 0; else if (gx >= world.gridW) gx = world.gridW - 1;
  let gy = (world.pos_y[i] / gcs) | 0; if (gy < 0) gy = 0; else if (gy >= world.gridH) gy = world.gridH - 1;
  return gy * world.gridW + gx;
}

function _removeFromBucket(bucket, cellIdx) {
  // Swap-and-pop. Buckets are small (typical < 10), so indexOf is cheap.
  const k = bucket.indexOf(cellIdx);
  if (k < 0) return;
  const last = bucket.length - 1;
  if (k !== last) bucket[k] = bucket[last];
  bucket.pop();
}

function gridAddCell(cellIdx) {
  const b = _cellBucket(cellIdx);
  world.grid[b].push(cellIdx);
  world.cellGridIdx[cellIdx] = b;
}

function gridRemoveCell(cellIdx) {
  const b = world.cellGridIdx[cellIdx];
  if (b < 0) return;
  _removeFromBucket(world.grid[b], cellIdx);
  world.cellGridIdx[cellIdx] = -1;
}

function rebuildGrid() {
  // Incremental reconciliation — only moves cells that crossed a bucket edge.
  for (let i = 0; i < world.maxCells; i++) {
    if (!world.alive[i]) continue;
    const newB = _cellBucket(i);
    const oldB = world.cellGridIdx[i];
    if (oldB === newB) continue;
    if (oldB >= 0) _removeFromBucket(world.grid[oldB], i);
    world.grid[newB].push(i);
    world.cellGridIdx[i] = newB;
  }
}

function getNeighborCells(cellIdx) {
  const gcs = world.gridCellSize;
  const gx = (world.pos_x[cellIdx] / gcs) | 0;
  const gy = (world.pos_y[cellIdx] / gcs) | 0;
  // Span = ceil((self + maxObservedRadius)/gcs). Fast path: when both fit in
  // half a bucket, the legacy 3x3 covers everything.
  const radSelf = world.radius[cellIdx];
  const maxR = world.maxRadius;
  const halfGcs = gcs * 0.5;
  let span = 1;
  if (radSelf > halfGcs || maxR > halfGcs) {
    span = Math.ceil((radSelf + maxR) / gcs);
    if (span < 1) span = 1;
  }
  const neighbors = [];
  for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) {
    const nx = gx + dx, ny = gy + dy;
    if (nx < 0 || nx >= world.gridW || ny < 0 || ny >= world.gridH) continue;
    const bucket = world.grid[ny * world.gridW + nx];
    for (let k = 0; k < bucket.length; k++) if (bucket[k] !== cellIdx) neighbors.push(bucket[k]);
  }
  return neighbors;
}
