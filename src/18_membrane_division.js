// ============================================================
// TASK 002 — MEMBRANE-DRIVEN DIVISION
// ============================================================
function membraneDivisionCheck(cellIdx) {
  const memCount = world.internalProteins[cellIdx * 64 + 19]; // Base Membrane
  if (memCount < CONFIG.membraneDivisionThreshold) {
    world.membraneDividing[cellIdx] = 0;
    return;
  }
  // Divider Trigger (type 4) is only required when the cell also expresses
  // Division Starter Required (type 38) — otherwise membrane threshold alone arms division.
  if (world.internalProteins[cellIdx * 64 + 38] > 0 &&
      world.internalProteins[cellIdx * 64 + 4] < 1) {
    world.membraneDividing[cellIdx] = 0;
    return;
  }
  if (world.energy[cellIdx] < CONFIG.divisionEnergyThreshold) return;
  if (world.dividing[cellIdx]) return; // already legacy-dividing

  if (!world.membraneDividing[cellIdx]) {
    world.membraneDividing[cellIdx] = 1;
  } else {
    world.membraneDividing[cellIdx]++;
    if (world.membraneDividing[cellIdx] >= CONFIG.divisionTicks) {
      membraneDivide(cellIdx);
    }
  }
}

function membraneDivide(cellIdx) {
  if (!world.alive[cellIdx]) return;
  const genome = world.genomes[cellIdx];
  if (!genome || genome.length === 0) { world.membraneDividing[cellIdx] = 0; return; }

  const angle = world.rng.next() * Math.PI * 2;
  const dist = world.radius[cellIdx] * 2.5;
  const childIdx = spawnCell(
    world.pos_x[cellIdx] + Math.cos(angle) * dist,
    world.pos_y[cellIdx] + Math.sin(angle) * dist,
    cellIdx, world.generation[cellIdx] + 1
  );
  if (childIdx === -1) { world.membraneDividing[cellIdx] = 0; return; }

  // Follow any in-flight replicase jobs to whichever cell now owns their
  // source chromosome — they continue copying there instead of being aborted.
  const captures = replicaseCaptureSrcRefs(cellIdx, genome);
  const refMap = distributeChromosomes(cellIdx, childIdx, genome);
  replicaseApplyHandoff(captures, refMap);

  // Energy split
  const halfE = world.energy[cellIdx] * 0.45;
  world.energy[cellIdx] -= halfE; world.energy[childIdx] = halfE;

  // Fresh membrane post-division: both cells reset to full HP
  world.membraneHP[cellIdx] = CONFIG.membraneMaxHP;
  world.membraneHP[childIdx] = CONFIG.membraneMaxHP;

  // Consume exactly membraneDivisionThreshold Base Membrane proteins (goes into
  // the new daughter membrane); the remainder is split with the rest of cytoplasm.
  // Divider Trigger: always consume all — even when type 38 wasn't present and
  // the triggers weren't gating the split, keeping the rule uniform.
  cytoSub(cellIdx, 19, CONFIG.membraneDivisionThreshold);
  cytoSet(cellIdx, 4, 0);

  // Split remaining cytoplasm
  for (let t = 0; t < 64; t++) {
    if (t === 4) continue; // already consumed
    const pi = cellIdx * 64 + t, share = Math.floor(world.internalProteins[pi] / 2);
    if (share > 0) {
      cytoSub(cellIdx, t, share);
      cytoSet(childIdx, t, share);
    }
  }

  // Split subslots
  for (let s = 0; s < NUM_SLOTS; s++) for (let ss = 0; ss < NUM_SUBSLOTS; ss++) {
    const k = s * NUM_SUBSLOTS + ss;
    const psi = cellIdx * TOTAL_SUBSLOTS_PER_CELL + k;
    const give = Math.floor(world.subslotCount[psi] / 2);
    if (give > 0) {
      const type = world.subslotType[psi];
      const remaining = world.subslotCount[psi] - give;
      subslotAssign(childIdx, k, type, give);
      subslotAssign(cellIdx, k, type, remaining);
    }
  }

  world.membraneDividing[cellIdx] = 0;
  world.milestones.divisionsTotal++;
  world.milestones.membraneDivisions++;
}

// Returns a Map from each pre-division chromosome reference to its new home:
// { cellIdx, idx } inside that cell's new genome. Callers (replicase handoff) use
// this to follow chromosomes across division without aborting in-flight jobs.
// A chromosome dropped by the per-division loss mutation is simply absent from
// the map — the caller treats that as a lost job.
function distributeChromosomes(parentIdx, childIdx, genome) {
  const parentChroms = [], childChroms = [];
  const refMap = new Map();
  let altExtra = false;

  const placeChild = (orig) => {
    refMap.set(orig, { cellIdx: childIdx, idx: childChroms.length });
    // Distinct buffer: degradeDNA mutates bytes in place, so parent and child
    // can't share a Uint8Array. No byte-level mutation here — the logical
    // instance moves from parent to child (transfer), no refcount bump.
    const copy = new Uint8Array(orig);
    lineageTransfer(orig, copy, 'sameCell');
    childChroms.push(copy);
  };
  const placeParent = (orig) => {
    refMap.set(orig, { cellIdx: parentIdx, idx: parentChroms.length });
    parentChroms.push(orig);
  };

  // Group all chromosomes by shape, including genome[0]. genome[0] (the identity
  // chromosome used by the renderer) must stay with parent, but it counts toward
  // parent's share of its shape group — otherwise a 2-chromosome cell treats the
  // non-identity chromosome as a singleton "extra" that defaults to parent,
  // making 2 a division fixed point. Map preserves insertion order so genome[0]'s
  // group is processed first (altExtra still fresh, parentTarget always ≥ 1).
  const g0 = genome[0];
  const byShape = new Map();
  for (let c = 0; c < genome.length; c++) {
    const shape = chromosomeShape(genome[c]);
    if (!byShape.has(shape)) byShape.set(shape, []);
    byShape.get(shape).push(genome[c]);
  }

  for (const chroms of byShape.values()) {
    const half = Math.floor(chroms.length / 2);
    const extra = chroms.length % 2;
    const parentTarget = half + (extra && !altExtra ? 1 : 0);
    const containsG0 = chroms.indexOf(g0) >= 0;
    let parentPlaced = 0;
    if (containsG0) { placeParent(g0); parentPlaced++; }
    for (let i = 0; i < chroms.length; i++) {
      const c = chroms[i];
      if (c === g0) continue;
      if (parentPlaced < parentTarget) { placeParent(c); parentPlaced++; }
      else placeChild(c);
    }
    if (extra) altExtra = !altExtra;
  }

  // Chromosome-level mutations on the child.
  if (childChroms.length > 1 && world.rng.next() < CONFIG.mutationRate) {
    const removedAt = world.rng.nextInt(childChroms.length);
    lineageMarkDead(childChroms[removedAt], 'cell');
    for (const [orig, info] of refMap) {
      if (info.cellIdx === childIdx && info.idx === removedAt) { refMap.delete(orig); break; }
    }
    childChroms.splice(removedAt, 1);
    for (const info of refMap.values()) {
      if (info.cellIdx === childIdx && info.idx > removedAt) info.idx--;
    }
  } else if (childChroms.length > 0 && world.rng.next() < CONFIG.mutationRate * 0.5) {
    // Duplication adds a new chromosome that no pre-division original maps to; no refMap change.
    const src = childChroms[world.rng.nextInt(childChroms.length)];
    const dup = mutateChromosome(src, CONFIG.mutationRate);
    const srcId = getLineageId(src);
    assignLineage(dup, srcId > 0 ? [srcId] : [], 'division-mutate', 'cell');
    childChroms.push(dup);
  }

  // The freshly spawned child cell has one random initial chromosome from spawnCell;
  // it's about to be replaced, so retire its lineage.
  const priorChild = world.genomes[childIdx];
  if (priorChild) for (const c of priorChild) lineageMarkDead(c, 'cell');

  world.genomes[parentIdx] = parentChroms;
  world.genomes[childIdx] = childChroms;

  if (world.ribo_chromIdx[parentIdx] >= parentChroms.length) {
    world.ribo_chromIdx[parentIdx] = 0; world.ribo_offset[parentIdx] = 0;
  }
  if (childChroms.length > 0) {
    world.ribo_chromIdx[childIdx] = world.rng.nextInt(childChroms.length);
    world.ribo_offset[childIdx] = 0;
  }

  return refMap;
}
