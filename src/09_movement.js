// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// MOVEMENT
// ============================================================
function sensorTick(cellIdx) {
  // Sensor (type 8) in special slots (1-6) produce move signals (type 7).
  // Replaces the per-protein Bernoulli(p=0.005) roll with geometric-gap
  // sampling — one RNG call per actual fire instead of one per protein.
  const p = CONFIG.sensorSignalRate;
  if (p <= 0) return;
  const logOneMinusP = Math.log(1 - p);
  let fires = 0;
  for (let s = 1; s < NUM_SLOTS; s++) {
    const cnt = countProteinInSlot(cellIdx, s, 8);
    if (cnt === 0) continue;
    let i = 0;
    while (true) {
      const u = world.rng.next();
      const gap = u <= 0 ? 1 : Math.max(1, Math.ceil(Math.log(1 - u) / logOneMinusP));
      i += gap;
      if (i > cnt) break;
      fires++;
    }
  }
  if (fires) cytoAdd(cellIdx, 7, fires);
}

function motorTick(cellIdx) {
  // Fast bail: no motors anywhere in the special slots.
  const stcBase = cellIdx * NUM_SLOTS * 64;
  let hasMotor = false;
  for (let s = 1; s < NUM_SLOTS; s++) {
    if (world.slotTypeCount[stcBase + s * 64 + 5] > 0 || world.slotTypeCount[stcBase + s * 64 + 6] > 0) {
      hasMotor = true; break;
    }
  }
  if (!hasMotor) return;

  const cytoMsIdx = cellIdx * 64 + 7;
  const subBase = cellIdx * TOTAL_SUBSLOTS_PER_CELL;

  for (let s = 1; s < NUM_SLOTS; s++) {
    const pushCnt = world.slotTypeCount[stcBase + s * 64 + 5];
    const pullCnt = world.slotTypeCount[stcBase + s * 64 + 6];
    if (pushCnt === 0 && pullCnt === 0) continue;

    // Move Signal source: prefer this slot's subslots (where directional
    // sensors deposit when no motor sits at +1), fall back to cytoplasm.
    let consumed = false;
    if (world.slotTypeCount[stcBase + s * 64 + 7] > 0) {
      const slotKBase = s * NUM_SUBSLOTS;
      for (let ss = 0; ss < NUM_SUBSLOTS; ss++) {
        const k = slotKBase + ss;
        const si = subBase + k;
        if (world.subslotType[si] === 7 && world.subslotCount[si] > 0) {
          subslotDec(cellIdx, k);
          if (world.subslotCount[si] === 0) world.decayNextSub[si] = 0;
          consumed = true;
          break;
        }
      }
    }
    if (!consumed && world.internalProteins[cytoMsIdx] > 0) {
      cytoDec(cellIdx, 7);
      consumed = true;
    }
    if (!consumed) continue;

    const slotAngle = (s - 1) * (Math.PI * 2 / 6);
    const dir = pushCnt >= pullCnt ? 1 : -1;
    world.vel_x[cellIdx] += Math.cos(slotAngle) * CONFIG.motorImpulse * dir;
    world.vel_y[cellIdx] += Math.sin(slotAngle) * CONFIG.motorImpulse * dir;
    world.milestones.cellMoved++;
  }
}
