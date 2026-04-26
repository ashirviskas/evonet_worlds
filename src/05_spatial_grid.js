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
  const gx = Math.floor(world.pos_x[cellIdx] / world.gridCellSize);
  const gy = Math.floor(world.pos_y[cellIdx] / world.gridCellSize);
  const neighbors = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = gx + dx, ny = gy + dy;
    if (nx < 0 || nx >= world.gridW || ny < 0 || ny >= world.gridH) continue;
    const bucket = world.grid[ny * world.gridW + nx];
    for (let k = 0; k < bucket.length; k++) if (bucket[k] !== cellIdx) neighbors.push(bucket[k]);
  }
  return neighbors;
}
