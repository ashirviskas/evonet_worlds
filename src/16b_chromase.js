// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// CHROMASE — DNA digestion.
//
// Type 23 = Chromase (enzyme). Type 24 = Chromase Inhibitor (1:1 quench,
// intracellular only for now). Intracellular digestion eats random bytes for
// energy. Extracellular digestion eats bytes of adjacent free chromosomes and
// releases the energy as a photon.
// ============================================================

function chromaseBytePayout() {
  return (CONFIG.byteSynthesisCost + CONFIG.enzymeSynthesisCost) * CONFIG.digestEfficiency;
}

// Shrink a Uint8Array by removing one byte at `pos`. Returns the new buffer.
function chromShrinkByte(data, pos) {
  const nd = new Uint8Array(data.length - 1);
  nd.set(data.subarray(0, pos));
  if (pos < data.length - 1) nd.set(data.subarray(pos + 1), pos);
  return nd;
}

function chromaseInternalTick(cellIdx) {
  const E = world.internalProteins[cellIdx * 64 + 23];
  if (E === 0) return;
  const I = world.internalProteins[cellIdx * 64 + 24];

  if (I >= E) {
    // Fully inhibited — enzyme is "super inefficient", nothing digested.
    // Quench consumes one inhibitor per enzyme present.
    cytoSet(cellIdx, 24, I - E);
    return;
  }
  // Partial inhibition: all inhibitor consumed, remaining enzymes act.
  let active = E - I;
  cytoSet(cellIdx, 24, 0);

  const payout = chromaseBytePayout();
  const genome = world.genomes[cellIdx];
  if (!genome || genome.length === 0) return; // enzymes just sit there

  // Track per-chromosome erosion for lineage checkpoints.
  if (!chromaseInternalTick._erosion) chromaseInternalTick._erosion = new WeakMap();
  const erosion = chromaseInternalTick._erosion;

  for (let k = 0; k < active; k++) {
    if (genome.length === 0) break;
    const ci = world.rng.nextInt(genome.length);
    const chrom = genome[ci];
    if (chrom.length === 0) { genome.splice(ci, 1); continue; }

    const pos = world.rng.nextInt(chrom.length);
    const shrunk = chromShrinkByte(chrom, pos);
    const prevId = lineageTransfer(chrom, shrunk, 'sameCell');
    genome[ci] = shrunk;

    cytoDec(cellIdx, 23);
    world.energy[cellIdx] = Math.min(CONFIG.energyCap, world.energy[cellIdx] + payout);

    const eroded = (erosion.get(chrom) || 0) + 1;
    erosion.delete(chrom);
    erosion.set(shrunk, eroded);

    if (prevId > 0 && eroded >= CONFIG.lineageDegradeCheckpointBytes) {
      lineageCheckpoint(shrunk, [prevId], 'digest-checkpoint', 'cell');
      erosion.set(shrunk, 0);
    }

    if (shrunk.length === 0) {
      lineageMarkDead(shrunk, 'cell');
      genome.splice(ci, 1);
    }
  }

  if (genome.length === 0) {
    // Ribosome fixup — mirrors chromEjectTick.
    world.ribo_chromIdx[cellIdx] = 0; world.ribo_offset[cellIdx] = 0;
  } else if (world.ribo_chromIdx[cellIdx] >= genome.length) {
    world.ribo_chromIdx[cellIdx] = 0; world.ribo_offset[cellIdx] = 0;
  }
}

// Free Chromase proteins (type 23) in the medium eat adjacent free chromosomes.
// Energy is released as a photon carrying the payout.
function chromaseExternalTick() {
  const reach = CONFIG.chromaseReachRadius;
  const reachSq = reach * reach;
  const payout = chromaseBytePayout();

  let jj = 0;
  while (jj < world.freePLiveCount) {
    const p = world.freePLive[jj];
    if (world.freeP_type[p] !== 23) { jj++; continue; }

    const px = world.freeP_x[p], py = world.freeP_y[p];
    // Linear scan — free chroms are few (≤200). Good enough.
    let hitIdx = -1, bestSq = reachSq;
    for (let i = 0; i < world.freeChromosomes.length; i++) {
      const fc = world.freeChromosomes[i];
      const dx = fc.x - px, dy = fc.y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestSq) { bestSq = d2; hitIdx = i; }
    }
    if (hitIdx < 0) { jj++; continue; }

    const fc = world.freeChromosomes[hitIdx];
    // Consume this free enzyme.
    _freeFreePSlot(p); // swap-and-pop; leave jj as-is so the swapped-in slot is re-checked

    // Bite one byte.
    if (fc.data.length > 0) {
      const pos = world.rng.nextInt(fc.data.length);
      const shrunk = chromShrinkByte(fc.data, pos);
      lineageTransfer(fc.data, shrunk, 'sameFree');
      fc.data = shrunk;
      fc.bytesErodedSinceCheckpoint = (fc.bytesErodedSinceCheckpoint || 0) + 1;
      if (fc.bytesErodedSinceCheckpoint >= CONFIG.lineageDegradeCheckpointBytes) {
        const prevId = getLineageId(fc.data);
        if (prevId > 0) lineageCheckpoint(fc.data, [prevId], 'digest-checkpoint', 'free');
        fc.bytesErodedSinceCheckpoint = 0;
      }
    }

    // Release energy as a photon at the chromosome's position.
    spawnPhotonAt(fc.x, fc.y, payout);

    if (fc.data.length === 0) {
      lineageMarkDead(fc.data, 'free');
      world.freeChromosomes.splice(hitIdx, 1);
    }
  }
}
