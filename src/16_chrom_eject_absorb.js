// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// TASK 002 — CHROMOSOME EJECTION & ABSORPTION
// ============================================================
function chromEjectTick(cellIdx) {
  const cnt = world.internalProteins[cellIdx * 64 + 20]; // Chromosome Ejector
  if (cnt < CONFIG.chromEjectThreshold) return;
  const genome = world.genomes[cellIdx];
  if (!genome || genome.length === 0) return;
  // Eject a random chromosome
  const ci = world.rng.nextInt(genome.length);
  spawnFreeChromosome(world.pos_x[cellIdx], world.pos_y[cellIdx], genome[ci], 'cellToFree');
  genome.splice(ci, 1);
  // Consume ejector proteins
  cytoSub(cellIdx, 20, CONFIG.chromEjectThreshold);
  // Fix ribosome if it pointed at removed chromosome
  if (genome.length === 0) {
    world.ribo_chromIdx[cellIdx] = 0; world.ribo_offset[cellIdx] = 0;
  } else if (world.ribo_chromIdx[cellIdx] >= genome.length) {
    world.ribo_chromIdx[cellIdx] = 0; world.ribo_offset[cellIdx] = 0;
  }
  world.milestones.chromEjections++;
}

// Rewritten as global pass: iterate free chroms once, query cell grid for nearby cells.
// O(freeChroms * ~9 bucket cells) instead of O(cells * freeChroms).
function chromAbsorbAll() {
  const gcs = world.gridCellSize, gw = world.gridW, gh = world.gridH;
  for (let i = world.freeChromosomes.length - 1; i >= 0; i--) {
    const fc = world.freeChromosomes[i];
    const gx = Math.floor(fc.x / gcs), gy = Math.floor(fc.y / gcs);
    let absorbed = false;
    let cSpan = 1;
    if (world.maxRadius > gcs * 0.5) { cSpan = Math.ceil(world.maxRadius / gcs); if (cSpan < 1) cSpan = 1; }
    const gxMin = Math.max(0, gx - cSpan), gxMax = Math.min(gw - 1, gx + cSpan);
    const gyMin = Math.max(0, gy - cSpan), gyMax = Math.min(gh - 1, gy + cSpan);
    for (let gy2 = gyMin; gy2 <= gyMax && !absorbed; gy2++) {
      for (let gx2 = gxMin; gx2 <= gxMax && !absorbed; gx2++) {
        const bucket = world.grid[gy2 * gw + gx2];
        for (let k = 0; k < bucket.length; k++) {
          const ci = bucket[k];
          if (!world.alive[ci]) continue;
          const dx = fc.x - world.pos_x[ci], dy = fc.y - world.pos_y[ci];
          const r2 = world.radius[ci] * world.radius[ci];
          if (dx * dx + dy * dy >= r2) continue;
          // Default: membrane blocks chromosome intake. Requires Chromie Invitation
          // (type 39) in membrane slot 0. No-Chromies-Allowed (type 21) still vetoes.
          if (countProteinInSlot(ci, 0, 39) === 0) continue;
          if (countProteinInSlot(ci, 0, 21) > 0) continue;
          if (world.rng.next() < CONFIG.chromAbsorbRate) {
            if (!world.genomes[ci]) world.genomes[ci] = [];
            const absorbedBuf = new Uint8Array(fc.data);
            lineageTransfer(fc.data, absorbedBuf, 'freeToCell'); // no-op copy preserves lineage id
            world.genomes[ci].push(absorbedBuf);
            world.freeChromosomes.splice(i, 1);
            world.milestones.chromAbsorptions++;
            absorbed = true;
            break;
          }
        }
      }
    }
  }
}
