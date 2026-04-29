// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// PROTEIN DECAY, MIGRATION, DNA DEGRADATION, ENERGY
// ============================================================
// Sample a gap from Geom(p): number of Bernoulli trials until (and including)
// the next success. Always >= 1. Memoryless, so a "stale" countdown from a
// previous rate redraw remains correctly distributed.
function _geomGap(p) {
  if (p >= 1) return 1;
  const u = world.rng.next();
  if (u <= 0) return 1;
  const gap = Math.ceil(Math.log(1 - u) / Math.log(1 - p));
  return gap < 1 ? 1 : gap;
}

function decayProteins(cellIdx) {
  const t0 = world.tick;

  // Cytoplasm — bit-scan the occupancy mask; visits occupied types in
  // ascending index order, matching the previous dense 0..63 loop exactly.
  // No per-entry RNG roll; only fire when countdown expires.
  const cytoBase = cellIdx * 64;
  const cmBase = cellIdx * 2;
  for (let w = 0; w < 2; w++) {
    let m = world.cytoOccMask[cmBase + w];
    const wordOffset = w << 5;
    while (m !== 0) {
      const low = m & -m;          // isolate lowest set bit
      const t = wordOffset + (31 - Math.clz32(low));
      m ^= low;
      const idx = cytoBase + t;
      const next = world.decayNextCyto[idx];
      if (next === 0) {
        world.decayNextCyto[idx] = t0 + _geomGap(world.decayRates[t]);
        continue;
      }
      if (t0 >= next) {
        if (--world.internalProteins[idx] === 0) {
          world.cytoOccMask[cmBase + (t >> 5)] &= ~(1 << (t & 31));
        }
        world.decayNextCyto[idx] = t0 + _geomGap(world.decayRates[t]);
      }
    }
  }

  // Subslots — same bit-scan over world.subslotOccMask (3 words = 96 bits,
  // of which 70 are in use).
  const subBase = cellIdx * TOTAL_SUBSLOTS_PER_CELL;
  const smBase = cellIdx * 3;
  for (let w = 0; w < 3; w++) {
    let m = world.subslotOccMask[smBase + w];
    const wordOffset = w << 5;
    while (m !== 0) {
      const low = m & -m;
      const k = wordOffset + (31 - Math.clz32(low));
      m ^= low;
      const si = subBase + k;
      const type = world.subslotType[si];
      if (type >= 64) continue; // 255 (empty) — shouldn't happen with mask, but guard.
      const next = world.decayNextSub[si];
      if (next === 0) {
        world.decayNextSub[si] = t0 + _geomGap(world.decayRates[type]);
        continue;
      }
      if (t0 >= next) {
        subslotDec(cellIdx, k); // handles count, type, mask, slotTypeCount
        if (world.subslotCount[si] === 0) {
          // Match original decayProteins behaviour: clear decayNextSub on zero.
          world.decayNextSub[si] = 0;
        } else {
          world.decayNextSub[si] = t0 + _geomGap(world.decayRates[type]);
        }
      }
    }
  }
}

function migrateProteins(cellIdx) {
  const subCellBase = cellIdx * TOTAL_SUBSLOTS_PER_CELL;
  for (let s = 0; s < NUM_SLOTS; s++) {
    if (!world.slotOpen[cellIdx * NUM_SLOTS + s]) continue;
    const slotKBase = s * NUM_SUBSLOTS;

    // Unbind: subslot proteins may release to cytoplasm
    for (let ss = 0; ss < NUM_SUBSLOTS; ss++) {
      const k = slotKBase + ss;
      const si = subCellBase + k;
      if (world.subslotCount[si] > 0 && world.rng.next() < CONFIG.slotUnbindRate) {
        cytoInc(cellIdx, world.subslotType[si]);
        subslotDec(cellIdx, k);
      }
    }

    // Bind: cytoplasm proteins try to fill subslots using left/right affinity.
    // Iterate occupied cyto types via bit-scan — same ascending-index visit
    // order as the previous dense 0..63 loop, so RNG consumption is preserved.
    const cmBase = cellIdx * 2;
    bindLoop:
    for (let w = 0; w < 2; w++) {
      let mm = world.cytoOccMask[cmBase + w];
      const wordOffset = w << 5;
      while (mm !== 0) {
        const low = mm & -mm;
        const t = wordOffset + (31 - Math.clz32(low));
        mm ^= low;

        // Find best subslot for this protein type
        let bestSS = -1, bestAff = -999;
        for (let ss = 0; ss < NUM_SUBSLOTS; ss++) {
          const si = subCellBase + slotKBase + ss;
          // Can only bind if subslot is empty OR same type and not full
          if (world.subslotType[si] !== 255 && world.subslotType[si] !== t) continue;
          if (world.subslotCount[si] >= MAX_SUB_PROTEINS) continue;

          // Compute affinity from left and right neighbors
          let aff = 0;
          // Left neighbor (ss-1)
          if (ss > 0) {
            const lsi = subCellBase + slotKBase + ss - 1;
            if (world.subslotType[lsi] < 64 && world.subslotCount[lsi] > 0) {
              // t is to the right of left neighbor
              aff += world.interactionRight[world.subslotType[lsi] * 64 + t];
              // left neighbor is to the left of t
              aff += world.interactionLeft[t * 64 + world.subslotType[lsi]];
            }
          }
          // Right neighbor (ss+1)
          if (ss < NUM_SUBSLOTS - 1) {
            const rsi = subCellBase + slotKBase + ss + 1;
            if (world.subslotType[rsi] < 64 && world.subslotCount[rsi] > 0) {
              // t is to the left of right neighbor
              aff += world.interactionLeft[world.subslotType[rsi] * 64 + t];
              // right neighbor is to the right of t
              aff += world.interactionRight[t * 64 + world.subslotType[rsi]];
            }
          }

          if (aff > bestAff) { bestAff = aff; bestSS = ss; }
        }

        if (bestSS < 0) continue;
        const bindChance = CONFIG.slotBindRate * Math.max(0, 0.3 + bestAff * 0.35);
        if (world.rng.next() < bindChance) {
          const k = slotKBase + bestSS;
          const si = subCellBase + k;
          if (world.subslotType[si] === 255) {
            subslotBind(cellIdx, k, t);
          } else {
            subslotInc(cellIdx, k);
          }
          cytoDec(cellIdx, t);
          break bindLoop; // one bind per slot per tick
        }
      }
    }
  }
}

function getCellDegradationRate(cellIdx) {
  const age = world.age[cellIdx];
  if (age < CONFIG.degradationStartAge) return 0;
  const eras = Math.floor((age - CONFIG.degradationStartAge) / CONFIG.degradationEraLength);
  return Math.min(CONFIG.degradationStartRate * Math.pow(1 + CONFIG.degradationIncreasePerEra, eras), CONFIG.degradationMaxRate);
}

function degradeDNA(cellIdx) {
  const rate = getCellDegradationRate(cellIdx);
  if (rate <= 0) return;
  const genome = world.genomes[cellIdx]; if (!genome) return;
  for (let c = 0; c < genome.length; c++) {
    const chrom = genome[c];
    for (let i = 0; i < chrom.length; i++) if (world.rng.next() < rate) chrom[i] = world.rng.nextInt(256);
  }
}

// harvestEnergy removed — photon particles are the only energy source now

function killCell(cellIdx) {
  const cx = world.pos_x[cellIdx], cy = world.pos_y[cellIdx];

  // Release cytoplasm proteins as free proteins
  for (let t = 0; t < 64; t++) {
    const cnt = world.internalProteins[cellIdx * 64 + t];
    for (let k = 0; k < cnt; k++) spawnFreeProtein(cx + (world.rng.next() - 0.5) * 10, cy + (world.rng.next() - 0.5) * 10, t);
  }
  // Release slot proteins as free proteins (read counts/types before clearing)
  for (let s = 0; s < NUM_SLOTS; s++) for (let ss = 0; ss < NUM_SUBSLOTS; ss++) {
    const si = subIdx(cellIdx, s, ss);
    if (world.subslotType[si] < 64) {
      for (let k = 0; k < world.subslotCount[si]; k++) spawnFreeProtein(cx + (world.rng.next() - 0.5) * 10, cy + (world.rng.next() - 0.5) * 10, world.subslotType[si]);
    }
  }
  subslotClearAll(cellIdx);

  // Release chromosomes as free chromosomes (their lineage id is preserved via
  // lineageTransfer inside spawnFreeChromosome). If the free pool is full, mark dead.
  const genome = world.genomes[cellIdx];
  if (genome) {
    for (let c = 0; c < genome.length; c++) {
      const buf = spawnFreeChromosome(cx + (world.rng.next() - 0.5) * 10, cy + (world.rng.next() - 0.5) * 10, genome[c], 'cellToFree');
      if (!buf) lineageMarkDead(genome[c], 'cell');
    }
  }

  replicaseFreeAllForCell(cellIdx);
  gridRemoveCell(cellIdx);
  world.alive[cellIdx] = 0; world.numCells--;
  cytoClearAll(cellIdx);
  // Reset decay countdowns so the next cell to reuse this slot starts fresh.
  for (let t = 0; t < 64; t++) world.decayNextCyto[cellIdx * 64 + t] = 0;
  for (let k = 0; k < TOTAL_SUBSLOTS_PER_CELL; k++) world.decayNextSub[cellIdx * TOTAL_SUBSLOTS_PER_CELL + k] = 0;
  world.genomes[cellIdx] = null;
  world.membraneDividing[cellIdx] = 0;
}

// preserveMarkers: when true, mutation never adds or removes a REPLICASE_START
// (0x10-0x1F) or REPLICASE_END (0x20-0x2F) byte. Byte-flip mutations stay
// within their original marker category; insertions only insert non-marker
// bytes; deletions skip marker positions. Jumps and other opcodes mutate
// freely. Used by the replicase to keep child chromosomes faithful to the
// parent's start/end markers.
function mutateChromosome(chrom, rate, preserveMarkers) {
  const isStart = b => b >= 0x10 && b <= 0x1F;
  const isEnd   = b => b >= 0x20 && b <= 0x2F;
  const sameMarkerClass = (a, b) => isStart(a) === isStart(b) && isEnd(a) === isEnd(b);
  const out = new Uint8Array(chrom.length); out.set(chrom);
  for (let i = 0; i < out.length; i++) {
    if (world.rng.next() >= rate) continue;
    let nb = world.rng.nextInt(256);
    if (preserveMarkers && !sameMarkerClass(nb, chrom[i])) {
      // Resample a few times into a matching class; if no luck, skip the flip.
      let ok = false;
      for (let tries = 0; tries < 8; tries++) {
        nb = world.rng.nextInt(256);
        if (sameMarkerClass(nb, chrom[i])) { ok = true; break; }
      }
      if (!ok) continue;
    }
    out[i] = nb;
  }
  if (world.rng.next() < rate) {
    const pos = world.rng.nextInt(out.length + 1);
    let nb = world.rng.nextInt(256);
    if (preserveMarkers) {
      // Inserted byte must not be a marker — keep resampling outside marker ranges.
      while (isStart(nb) || isEnd(nb)) nb = world.rng.nextInt(256);
    }
    const nc = new Uint8Array(out.length + 1);
    nc.set(out.subarray(0, pos)); nc[pos] = nb; nc.set(out.subarray(pos), pos + 1);
    return nc;
  }
  if (out.length > 4 && world.rng.next() < rate) {
    const pos = world.rng.nextInt(out.length);
    if (preserveMarkers && (isStart(out[pos]) || isEnd(out[pos]))) {
      // Skip the deletion entirely rather than reroll — keeps marker count stable.
      return out;
    }
    const nc = new Uint8Array(out.length - 1);
    nc.set(out.subarray(0, pos)); nc.set(out.subarray(pos + 1), pos);
    return nc;
  }
  return out;
}

function divideCell(parentIdx) {
  if (!world.alive[parentIdx]) return -1;
  const genome = world.genomes[parentIdx]; if (!genome || genome.length === 0) return -1;
  const angle = world.rng.next() * Math.PI * 2;
  const dist = world.radius[parentIdx] * 2.5;
  const childIdx = spawnCell(
    world.pos_x[parentIdx] + Math.cos(angle) * dist,
    world.pos_y[parentIdx] + Math.sin(angle) * dist,
    parentIdx, world.generation[parentIdx] + 1,
    world.radius[parentIdx]);
  if (childIdx === -1) return -1;

  // Follow any in-flight replicase jobs to whichever cell now owns their
  // source chromosome — they continue copying there instead of being aborted.
  const captures = replicaseCaptureSrcRefs(parentIdx, genome);
  const refMap = distributeChromosomes(parentIdx, childIdx, genome);
  replicaseApplyHandoff(captures, refMap);

  const halfE = world.energy[parentIdx] * 0.45;
  world.energy[parentIdx] -= halfE; world.energy[childIdx] = halfE;

  // Fresh membrane post-division: both cells start at full HP
  world.membraneHP[parentIdx] = CONFIG.membraneMaxHP;
  world.membraneHP[childIdx] = CONFIG.membraneMaxHP;

  // Split cytoplasm
  for (let t = 0; t < 64; t++) {
    const pi = parentIdx * 64 + t, share = Math.floor(world.internalProteins[pi] / 2);
    if (share > 0) {
      cytoSub(parentIdx, t, share);
      cytoSet(childIdx, t, share);
    }
  }

  // Split subslots
  for (let s = 0; s < NUM_SLOTS; s++) for (let ss = 0; ss < NUM_SUBSLOTS; ss++) {
    const k = s * NUM_SUBSLOTS + ss;
    const psi = parentIdx * TOTAL_SUBSLOTS_PER_CELL + k;
    const give = Math.floor(world.subslotCount[psi] / 2);
    if (give > 0) {
      const type = world.subslotType[psi];
      const remaining = world.subslotCount[psi] - give;
      subslotAssign(childIdx, k, type, give);
      subslotAssign(parentIdx, k, type, remaining);
    }
  }

  world.dividing[parentIdx] = 0;
  world.milestones.divisionsTotal++;
  return childIdx;
}
