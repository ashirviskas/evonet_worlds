// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// SIMULATION TICK
// ============================================================
function tick() {
  world.tick++;
  rebuildGrid();
  // Directional-sensor pre-pass. cellNearScan and proteinNearScan use the
  // freshly-rebuilt grid (and the free-protein grid from last tick's
  // rebuildFreeProteinGrid). photonNearSlot is not reset here — photonTick
  // owns its own lifecycle and provides 1-tick-delayed flags.
  cellNearScan();
  proteinNearScan();
  let makingDivider = 0, survived10k = 0;

  for (let i = 0; i < world.maxCells; i++) {
    if (!world.alive[i]) continue;
    world.age[i]++;
    decayProteins(i);
    sensorTick(i);
    directionalSensorTick(i, 39, world.photonNearSlot);
    directionalSensorTick(i, 40, world.cellNearSlot);
    directionalSensorTick(i, 41, world.proteinNearSlot);
    motorTick(i);

    if (world.energy[i] > 0) {
      ribosomeStep(i);
      migrateProteins(i);
      pumpTick(i);
      chromEjectTick(i);
      chromaseInternalTick(i);
      replicationStarterTick(i);
      membraneDivisionCheck(i);
      degradeDNA(i);
      world.energy[i] -= CONFIG.metabolismCost;
      cellEnergyStorageTick(i);

      if (world.dividing[i]) {
        world.dividing[i]++;
        if (world.dividing[i] >= CONFIG.divisionTicks) divideCell(i);
      }
    }

    // Membrane decay + repair (Base Membrane type 19 heals 10 HP, only when deficit >= 10).
    // Cytoplasm 19s spend first; otherwise consume one from the membrane slot itself.
    world.membraneHP[i] -= CONFIG.membraneDecayPerTick;
    const hpDeficit = CONFIG.membraneMaxHP - world.membraneHP[i];
    if (hpDeficit >= CONFIG.membraneRepairMinDeficit) {
      let healed = false;
      if (world.internalProteins[i * 64 + 19] > 0) {
        cytoDec(i, 19);
        healed = true;
      } else {
        for (let ss = 0; ss < NUM_SUBSLOTS; ss++) {
          const k = ss; // slot 0 membrane
          const si = subIdx(i, 0, ss);
          if (world.subslotType[si] === 19 && world.subslotCount[si] > 0) {
            subslotDec(i, k);
            // Match original: membrane repair clears decayNextSub on zero.
            if (world.subslotCount[si] === 0) world.decayNextSub[si] = 0;
            healed = true;
            break;
          }
        }
      }
      if (healed) {
        world.membraneHP[i] = Math.min(CONFIG.membraneMaxHP, world.membraneHP[i] + CONFIG.membraneRepairPerProtein);
      }
    }

    if (world.membraneHP[i] <= 0) { killCell(i); continue; }

    if (world.energy[i] >= 500) world.milestones.cellReached500++;
    if (world.internalProteins[i * 64 + 4] > 0) makingDivider++;
    if (world.age[i] >= 10000) survived10k++;
  }

  collisionPhysics();
  replicaseTick();
  photonTick();
  freeProteinTick();
  rebuildFreeProteinGrid();
  freeChromosomeTick();
  chromaseExternalTick();
  chromAbsorbAll();

  if (world.tick % CONFIG.lineagePruneInterval === 0) lineagePrune();

  for (let i = 0; i < world.maxCells; i++) {
    if (!world.alive[i]) continue;
    world.pos_x[i] += world.vel_x[i]; world.pos_y[i] += world.vel_y[i];
    world.vel_x[i] *= 0.95; world.vel_y[i] *= 0.95;
    const r = world.radius[i];
    if (world.pos_x[i] < r) { world.pos_x[i] = r; world.vel_x[i] *= -0.5; }
    if (world.pos_x[i] > CONFIG.worldWidth - r) { world.pos_x[i] = CONFIG.worldWidth - r; world.vel_x[i] *= -0.5; }
    if (world.pos_y[i] < r) { world.pos_y[i] = r; world.vel_y[i] *= -0.5; }
    if (world.pos_y[i] > CONFIG.worldHeight - r) { world.pos_y[i] = CONFIG.worldHeight - r; world.vel_y[i] *= -0.5; }
  }

  world.milestones.cellMakingDivider = makingDivider;
  world.milestones.cellSurvived10k = survived10k;
  if (world.numCells > world.milestones.maxPopulation) world.milestones.maxPopulation = world.numCells;
  let maxGen = 0;
  for (let i = 0; i < world.maxCells; i++) if (world.alive[i] && world.generation[i] > maxGen) maxGen = world.generation[i];
  if (maxGen >= 3) world.milestones.threeGenLineage = maxGen;

  while (world.numCells < CONFIG.initialCells) {
    spawnCell(world.rng.nextRange(50, CONFIG.worldWidth - 50), world.rng.nextRange(50, CONFIG.worldHeight - 50), -1, 0);
  }
}
