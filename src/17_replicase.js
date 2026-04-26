// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// REPLICASE — concurrent chromosome duplication via a global job pool.
//
// Duplication is *not* triggered by a gene opcode. A Replication Starter
// protein (type 22) in cytoplasm binds a random chromosome, consumes itself,
// and spawns a job in the global pool. Each job copies bytes independently
// (drawing Replicase protein type 18 byte-by-byte) and may run concurrently
// with other jobs in the same cell, up to CONFIG.maxReplicaseJobsPerCell.
// ============================================================

function replicaseAllocJob() {
  const cap = CONFIG.maxReplicaseJobs;
  for (let tries = 0; tries < cap; tries++) {
    const slot = world.replicase_nextSlot;
    world.replicase_nextSlot = (slot + 1) % cap;
    if (!world.replicase_job_alive[slot]) return slot;
  }
  return -1; // pool full
}

function replicaseFreeJob(slot) {
  if (!world.replicase_job_alive[slot]) return;
  const cellIdx = world.replicase_job_cellIdx[slot];
  world.replicase_job_alive[slot] = 0;
  world.replicase_job_output[slot] = null;
  world.replicase_job_sourceBytes[slot] = null;
  world.replicase_job_sourceRef[slot] = null;
  if (cellIdx >= 0 && world.replicase_activeCount[cellIdx] > 0) {
    world.replicase_activeCount[cellIdx]--;
  }
}

// Build (parents[], parentBytes[], event) from a job's sourceBytes map.
// Drops parents with zero contribution so the lineage only reflects DNA that
// actually made it into the child — initial placeholder entries don't leak.
function replicaseSummariseLineage(slot) {
  const sb = world.replicase_job_sourceBytes[slot];
  if (!sb || sb.size === 0) return { parents: [], parentBytes: [], event: 'replicase' };
  const parents = [];
  const parentBytes = [];
  for (const [pid, bytes] of sb) {
    if (bytes <= 0) continue;
    parents.push(pid);
    parentBytes.push(bytes);
  }
  const min = CONFIG.lineageCrossoverMinBytes;
  const significant = parentBytes.filter(b => b >= min).length;
  const event = significant >= 2 ? 'crossover' : 'replicase';
  return { parents, parentBytes, event };
}

// Abort a job, but first emit whatever bytes were copied as a truncated
// chromosome — biologically more faithful than discarding partial work, and
// keeps the cell's chromosome count growing even when replicase stalls.
function replicaseFailJob(slot) {
  const cellIdx = world.replicase_job_cellIdx[slot];
  const output = world.replicase_job_output[slot];
  if (world.alive[cellIdx] && output && output.length > 0) {
    const genome = world.genomes[cellIdx];
    if (genome) {
      const truncated = new Uint8Array(output);
      const mutated = mutateChromosome(truncated, CONFIG.mutationRate, true);
      const { parents, parentBytes, event } = replicaseSummariseLineage(slot);
      const newId = assignLineage(mutated, parents, event, 'cell', parentBytes);
      // If assignLineage rebound to an existing parent (faithful clone), don't
      // overwrite that parent's own parentBytes.
      if (newId > 0 && parents.indexOf(newId) < 0) {
        const node = lineage.nodes.get(newId);
        if (node) { node.parentBytes = parentBytes; lineageRecomputePrimary(node); }
      }
      genome.push(mutated);
    }
  }
  world.milestones.replicaseFailed++;
  replicaseFreeJob(slot);
}

// Capture the source chromosome reference for every active job in cellIdx
// BEFORE a division call rewrites world.genomes. Jobs whose sourceIdx has
// gone stale (e.g. genome shrank) are failed here so they emit a partial.
// Returns an array of {slot, origRef} for the survivors.
function replicaseCaptureSrcRefs(cellIdx, genome) {
  if (world.replicase_activeCount[cellIdx] === 0) return null;
  const out = [];
  const cap = CONFIG.maxReplicaseJobs;
  for (let s = 0; s < cap; s++) {
    if (!world.replicase_job_alive[s]) continue;
    if (world.replicase_job_cellIdx[s] !== cellIdx) continue;
    const srcIdx = world.replicase_job_sourceIdx[s];
    if (!genome || srcIdx >= genome.length) { replicaseFailJob(s); continue; }
    out.push({ slot: s, origRef: genome[srcIdx] });
  }
  return out.length > 0 ? out : null;
}

// After distributeChromosomes returns a refMap (origRef -> {cellIdx, idx}),
// reassign each captured job to whichever cell now owns that chromosome.
// A job whose source was dropped by the division's loss mutation emits a partial.
function replicaseApplyHandoff(captures, refMap) {
  if (!captures) return;
  for (let i = 0; i < captures.length; i++) {
    const slot = captures[i].slot;
    const origRef = captures[i].origRef;
    const dest = refMap.get(origRef);
    if (!dest) { replicaseFailJob(slot); continue; }
    const oldCell = world.replicase_job_cellIdx[slot];
    if (dest.cellIdx !== oldCell) {
      if (world.replicase_activeCount[oldCell] > 0) world.replicase_activeCount[oldCell]--;
      world.replicase_activeCount[dest.cellIdx]++;
    }
    world.replicase_job_cellIdx[slot] = dest.cellIdx;
    world.replicase_job_sourceIdx[slot] = dest.idx;
  }
}

function replicaseFreeAllForCell(cellIdx) {
  if (world.replicase_activeCount[cellIdx] === 0) return;
  const cap = CONFIG.maxReplicaseJobs;
  for (let s = 0; s < cap; s++) {
    if (world.replicase_job_alive[s] && world.replicase_job_cellIdx[s] === cellIdx) {
      replicaseFreeJob(s);
    }
  }
}

// shapeFilter < 0 means "any chromosome" (classic Replication Starter).
// shapeFilter in [0,9] restricts source selection to chromosomes whose
// chromosomeShape() == shapeFilter. If no chromosome matches, the starter
// protein is NOT consumed — it only "binds" when a substrate exists.
// mode: 0 = Basic (skip scan, dumb start-to-end copy, ignores replicase opcodes)
//       1 = Advanced (current behaviour: scan, jumps, end-marker termination)
function replicationStarterTickFiltered(cellIdx, proteinType, shapeFilter, mode) {
  let starters = world.internalProteins[cellIdx * 64 + proteinType];
  if (starters <= 0) return;
  const genome = world.genomes[cellIdx];
  if (!genome || genome.length === 0) return;

  let candidates = null;
  if (shapeFilter >= 0) {
    candidates = [];
    for (let c = 0; c < genome.length; c++) {
      if (chromosomeShape(genome[c]) === shapeFilter) candidates.push(c);
    }
    if (candidates.length === 0) return;
  }

  const rate = CONFIG.replicationStarterRate;
  const perCellCap = CONFIG.maxReplicaseJobsPerCell;
  for (let m = 0; m < starters; m++) {
    if (world.rng.next() >= rate) continue;
    if (world.replicase_activeCount[cellIdx] >= perCellCap) break;
    const slot = replicaseAllocJob();
    if (slot < 0) break;

    const srcIdx = candidates
      ? candidates[world.rng.nextInt(candidates.length)]
      : world.rng.nextInt(genome.length);
    const srcChrom = genome[srcIdx];
    const srcLen = srcChrom.length;
    // Advanced: pick a uniform random landing byte and scan forward from there.
    // Basic: skip scan entirely; copy from byte 0.
    const landing = (mode === 1 && srcLen > 0) ? world.rng.nextInt(srcLen) : 0;
    world.replicase_job_alive[slot] = 1;
    world.replicase_job_cellIdx[slot] = cellIdx;
    world.replicase_job_sourceRef[slot] = srcChrom;
    world.replicase_job_sourceIdx[slot] = srcIdx;
    world.replicase_job_targetShape[slot] = chromosomeShape(srcChrom);
    world.replicase_job_progress[slot] = landing;
    world.replicase_job_scanStart[slot] = landing;
    world.replicase_job_scanRemaining[slot] = (mode === 1) ? srcLen : 0;
    world.replicase_job_phase[slot] = (mode === 1) ? 0 : 1;       // Advanced=SCAN, Basic=COPY directly
    world.replicase_job_mode[slot] = mode;
    world.replicase_job_holding[slot] = 0;
    world.replicase_job_heldOpcode[slot] = 0;
    world.replicase_job_ticksLeft[slot] = CONFIG.replicaseTimeout;
    world.replicase_job_output[slot] = [];
    world.replicase_job_sourceBytes[slot] = new Map();
    world.replicase_activeCount[cellIdx]++;
    cytoDec(cellIdx, proteinType);
    starters--;
  }
}

function replicationStarterTick(cellIdx) {
  // Type 22: Basic Replication Starter (any shape).
  replicationStarterTickFiltered(cellIdx, 22, -1, 0);
  // Type 42: Advanced Replication Starter (any shape).
  replicationStarterTickFiltered(cellIdx, 42, -1, 1);
  // Types 26..35: Advanced Replication Starters S0..S9 (shape-indexed).
  for (let s = 0; s < 10; s++) {
    replicationStarterTickFiltered(cellIdx, 26 + s, s, 1);
  }
}

// Finalize an active job's output as a new chromosome on the cell's genome.
// Shared by the REPLICASE_END terminator in the copy phase and, in principle,
// by any other graceful completion path.
function replicaseCompleteJob(slot, genome) {
  const output = new Uint8Array(world.replicase_job_output[slot]);
  const mutated = mutateChromosome(output, CONFIG.mutationRate, true);
  const { parents, parentBytes, event } = replicaseSummariseLineage(slot);
  const newId = assignLineage(mutated, parents, event, 'cell', parentBytes);
  if (newId > 0 && parents.indexOf(newId) < 0) {
    const node = lineage.nodes.get(newId);
    if (node) { node.parentBytes = parentBytes; lineageRecomputePrimary(node); }
  }
  genome.push(mutated);
  world.milestones.replicaseCompleted++;
  replicaseFreeJob(slot);
}

// Global tick: advance every active job by up to one byte.
// Each job has two phases:
//   0 = SCANNING — looking for a REPLICASE_START (0x10..0x1F) byte in the source.
//       Starts at a random landing position; advances one byte per fired tick,
//       wrapping at the source end. On find, transitions to COPY and emits
//       the start marker as the first output byte. If a full source loop
//       elapses with no find, falls back to copying from the landing position.
//   1 = COPYING  — emits one source byte per fired tick (wrapping). Terminates
//       when the emitted byte is a REPLICASE_END (0x20..0x2F), or on timeout.
//       REPLICASE_JUMP_BYTE (0x90..0x9F) and REPLICASE_JUMP_CHROMOSOME
//       (0xA0..0xAF) are 2-byte instructions in the replicase frame: opcode
//       emitted one tick, arg emitted the next, then the jump executes.
// The replicase frame is independent from the ribosome frame: byte classifier
// in this function only pattern-matches values; what the ribosome thinks of
// those bytes has no bearing on replicase decisions.
function replicaseTick() {
  const cap = CONFIG.maxReplicaseJobs;
  const errorRateBase = CONFIG.replicaseBaseErrorRate;
  const noiseScale = CONFIG.replicaseNoiseScale;
  const proteinChance = CONFIG.replicaseProteinAdvanceChance;
  const energyEnabled = CONFIG.replicaseEnergyAdvanceEnabled;
  const energyChance = CONFIG.replicaseEnergyAdvanceChance;
  const energyCost = CONFIG.replicaseEnergyAdvanceCost;

  for (let slot = 0; slot < cap; slot++) {
    if (!world.replicase_job_alive[slot]) continue;
    const cellIdx = world.replicase_job_cellIdx[slot];
    if (!world.alive[cellIdx]) { replicaseFreeJob(slot); continue; }

    world.replicase_job_ticksLeft[slot]--;
    if (world.replicase_job_ticksLeft[slot] <= 0) {
      replicaseFailJob(slot);
      continue;
    }

    // Gate on protein or energy advance (both scan and copy phases pay the same).
    const hasProtein = world.internalProteins[cellIdx * 64 + 18] > 0;
    const proteinFires = hasProtein && world.rng.next() < proteinChance;
    const energyFires = !proteinFires
      && energyEnabled
      && world.energy[cellIdx] >= energyCost
      && world.rng.next() < energyChance;
    if (!proteinFires && !energyFires) continue;

    const genome = world.genomes[cellIdx];
    if (!genome) { replicaseFreeJob(slot); continue; }
    // Resolve source by REFERENCE every tick. Index alone is unreliable because
    // chromEjectTick, absorption, chromase, and division can rearrange the
    // genome array without notifying jobs.
    const srcRef = world.replicase_job_sourceRef[slot];
    let srcIdx = srcRef ? genome.indexOf(srcRef) : -1;
    if (srcIdx < 0) { replicaseFailJob(slot); continue; }
    world.replicase_job_sourceIdx[slot] = srcIdx;
    const src = genome[srcIdx];
    if (!src || src.length === 0) { replicaseFailJob(slot); continue; }

    if (proteinFires) cytoDec(cellIdx, 18);
    else world.energy[cellIdx] -= energyCost;

    const progress = world.replicase_job_progress[slot];
    const readPos = progress % src.length;

    // ---------- SCAN PHASE ----------
    if (world.replicase_job_phase[slot] === 0) {
      const byte = src[readPos];
      if (byte >= 0x10 && byte <= 0x1F) {
        // REPLICASE_START found. Transition to COPY and emit this byte as the
        // first copied byte. scanStart is repurposed to mark where the copy
        // actually begins (used by the "restart copy" error branch below).
        world.replicase_job_phase[slot] = 1;
        world.replicase_job_scanStart[slot] = readPos;
        world.replicase_job_output[slot].push(byte);
        world.replicase_job_progress[slot] = (readPos + 1) % src.length;
        const cid = getLineageId(src);
        if (cid > 0) {
          const sb = world.replicase_job_sourceBytes[slot];
          if (sb) sb.set(cid, (sb.get(cid) || 0) + 1);
        }
        continue;
      }
      world.replicase_job_scanRemaining[slot]--;
      world.replicase_job_progress[slot] = (readPos + 1) % src.length;
      if (world.replicase_job_scanRemaining[slot] <= 0) {
        // One full loop with no start marker — fall back: begin copying from
        // the original landing position with whatever timeout is left.
        world.replicase_job_phase[slot] = 1;
        world.replicase_job_progress[slot] = world.replicase_job_scanStart[slot];
      }
      continue;
    }

    // ---------- COPY PHASE ----------
    const mode = world.replicase_job_mode[slot]; // 0=Basic, 1=Advanced

    // Basic terminates when source is fully consumed (or when a switch-chromosome
    // error has landed us past the end of a shorter source). Advanced wraps
    // around the source and waits for an END marker.
    if (mode === 0 && progress >= src.length) {
      replicaseCompleteJob(slot, genome);
      continue;
    }

    let contributorId = getLineageId(src);

    // Noise-scaled error rate: junk cytoplasm proteins disrupt copy fidelity.
    let totalNoise = 0;
    for (let t = 0; t < 64; t++) {
      if (t !== 18) totalNoise += world.internalProteins[cellIdx * 64 + t];
    }
    const effectiveErrorRate = errorRateBase * (1 + totalNoise / noiseScale);

    // Capture source byte BEFORE any error roll so we can enforce marker
    // preservation after mutation: REPLICASE_START (0x10-0x1F) and
    // REPLICASE_END (0x20-0x2F) bytes never get added or removed by mutation.
    // Jumps and other opcodes are NOT preserved — those evolve freely.
    const sourceByteAtRead = src[readPos];
    let copiedByte = sourceByteAtRead;
    let skipEmit = false;       // skip-byte error: advance progress, emit nothing
    let advanceProgress = true; // duplicate/insert errors: emit but hold position

    if (world.rng.next() < effectiveErrorRate) {
      const roll = world.rng.next();
      if (roll < 0.2) {
        // Switch chromosome — find another with same target shape tag. Only
        // affects FUTURE reads; the byte emitted this tick is still from `src`.
        const targetShape = world.replicase_job_targetShape[slot];
        const candidates = [];
        for (let c = 0; c < genome.length; c++) {
          if (c !== srcIdx && chromosomeShape(genome[c]) === targetShape) candidates.push(c);
        }
        if (candidates.length > 0) {
          const newIdx = candidates[world.rng.nextInt(candidates.length)];
          world.replicase_job_sourceIdx[slot] = newIdx;
          world.replicase_job_sourceRef[slot] = genome[newIdx];
        }
      } else if (roll < 0.4) {
        // Restart copy: rewind to the copy-start position and clear output.
        // Timer keeps running; holding state resets.
        world.replicase_job_progress[slot] = world.replicase_job_scanStart[slot];
        world.replicase_job_output[slot] = [];
        world.replicase_job_holding[slot] = 0;
        continue;
      } else if (roll < 0.5) {
        // no-op substitution — keep byte as read
      } else if (roll < 0.6) {
        if (genome.length > 1) {
          const otherIdx = (srcIdx + 1 + world.rng.nextInt(genome.length - 1)) % genome.length;
          const otherChrom = genome[otherIdx];
          copiedByte = otherChrom[progress % otherChrom.length];
          contributorId = getLineageId(otherChrom);
        }
      } else if (roll < 0.7) {
        copiedByte = world.rng.nextInt(256);
      } else if (roll < 0.8) {
        // Skip byte (deletion): advance progress, emit nothing this tick.
        skipEmit = true;
      } else if (roll < 0.9) {
        // Duplicate byte (insertion): emit src byte, do not advance — next
        // tick re-reads and re-emits the same byte.
        advanceProgress = false;
      } else {
        // Insert random byte (insertion): emit random, do not advance — next
        // tick re-reads the original src byte at this position.
        copiedByte = world.rng.nextInt(256);
        advanceProgress = false;
      }
    }

    // Marker preservation: if any error branch flipped this byte into or out
    // of REPLICASE_START / REPLICASE_END category compared to the source byte,
    // revert to the source byte. Skip-byte never emits, so it bypasses this.
    if (!skipEmit) {
      const srcStart = sourceByteAtRead >= 0x10 && sourceByteAtRead <= 0x1F;
      const srcEnd   = sourceByteAtRead >= 0x20 && sourceByteAtRead <= 0x2F;
      const emStart  = copiedByte >= 0x10 && copiedByte <= 0x1F;
      const emEnd    = copiedByte >= 0x20 && copiedByte <= 0x2F;
      if (srcStart !== emStart || srcEnd !== emEnd) copiedByte = sourceByteAtRead;
    }

    // Emit (unless skip-byte error suppressed it).
    if (!skipEmit) {
      world.replicase_job_output[slot].push(copiedByte);
      if (contributorId > 0) {
        const sb = world.replicase_job_sourceBytes[slot];
        if (sb) sb.set(contributorId, (sb.get(contributorId) || 0) + 1);
      }
    }

    // Advance progress unless an insertion error held the position.
    // Advanced wraps modulo src.length; Basic uses absolute progress and
    // terminates when it reaches src.length (handled at top of next tick or below).
    if (advanceProgress) {
      world.replicase_job_progress[slot] = (mode === 1)
        ? ((readPos + 1) % src.length)
        : (readPos + 1);
    }

    // Basic: replicase opcodes (END, JUMP_*) are pure data — no held-opcode
    // dispatch, no early termination on END byte. Just check end-of-source.
    if (mode === 0) {
      if (world.replicase_job_progress[slot] >= src.length) {
        replicaseCompleteJob(slot, genome);
      }
      continue;
    }

    // Advanced: held-opcode resolution and END-marker termination only run on
    // ticks that actually emitted a byte (skip-byte errors fall through).
    if (skipEmit) continue;

    // Interpret the emitted byte in the replicase's reading frame.
    if (world.replicase_job_holding[slot]) {
      // Previous tick emitted a 2-byte replicase-jump opcode; this byte is its arg.
      const held = world.replicase_job_heldOpcode[slot];
      world.replicase_job_holding[slot] = 0;
      if (held >= 0x90 && held <= 0x9F) {
        // REPLICASE_JUMP_BYTE — scan current source forward from current
        // position for a byte equal to copiedByte; fall back to random offset.
        const curIdx = world.replicase_job_sourceIdx[slot];
        const curSrc = genome[curIdx];
        const startPos = world.replicase_job_progress[slot] % curSrc.length;
        let foundAt = -1;
        for (let step = 0; step < curSrc.length; step++) {
          const p = (startPos + step) % curSrc.length;
          if (curSrc[p] === copiedByte) { foundAt = p; break; }
        }
        if (foundAt < 0) foundAt = world.rng.nextInt(curSrc.length);
        world.replicase_job_progress[slot] = foundAt;
      } else if (held >= 0xA0 && held <= 0xAF) {
        // REPLICASE_JUMP_CHROMOSOME — switch source to chromosome with
        // shape == arg % 10; pick a random chromosome if none match.
        const targetShape = copiedByte % 10;
        let foundC = -1;
        for (let c = 0; c < genome.length; c++) {
          if (chromosomeShape(genome[c]) === targetShape) { foundC = c; break; }
        }
        if (foundC < 0) foundC = world.rng.nextInt(genome.length);
        world.replicase_job_sourceIdx[slot] = foundC;
        world.replicase_job_sourceRef[slot] = genome[foundC];
        world.replicase_job_progress[slot] = 0;
      }
    } else if (copiedByte >= 0x20 && copiedByte <= 0x2F) {
      // REPLICASE_END — finalize.
      replicaseCompleteJob(slot, genome);
      continue;
    } else if (copiedByte >= 0x90 && copiedByte <= 0xAF) {
      // Replicase-jump opcode — hold for the arg byte emitted next tick.
      world.replicase_job_holding[slot] = 1;
      world.replicase_job_heldOpcode[slot] = copiedByte;
    }
  }
}
