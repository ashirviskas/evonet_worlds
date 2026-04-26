// ============================================================
// TASK 002 — PUMP TICK (EXPEL/INTAKE)
// ============================================================
function pumpTick(cellIdx) {
  for (let s = 1; s < NUM_SLOTS; s++) {
    if (!world.slotOpen[cellIdx * NUM_SLOTS + s]) continue;
    // Expel Pump (type 16)
    const expelCnt = countProteinInSlot(cellIdx, s, 16);
    if (expelCnt > 0) {
      const chance = CONFIG.expelRate * expelCnt;
      if (world.rng.next() < chance) {
        // Pick random cytoplasm protein to expel
        let total = 0;
        for (let t = 0; t < 64; t++) total += world.internalProteins[cellIdx * 64 + t];
        if (total > 0) {
          let pick = world.rng.nextInt(total), t = 0;
          for (; t < 64; t++) {
            pick -= world.internalProteins[cellIdx * 64 + t];
            if (pick < 0) break;
          }
          if (t < 64 && world.internalProteins[cellIdx * 64 + t] > 0) {
            cytoDec(cellIdx, t);
            const slotAngle = (s - 1) * (Math.PI * 2 / 6);
            spawnFreeProtein(
              world.pos_x[cellIdx] + Math.cos(slotAngle) * (world.radius[cellIdx] + 2),
              world.pos_y[cellIdx] + Math.sin(slotAngle) * (world.radius[cellIdx] + 2),
              t
            );
          }
        }
      }
    }
    // Intake Pump (type 17)
    const intakeCnt = countProteinInSlot(cellIdx, s, 17);
    if (intakeCnt > 0) {
      const chance = CONFIG.intakeRate * intakeCnt;
      if (world.rng.next() < chance) {
        const slotAngle = (s - 1) * (Math.PI * 2 / 6);
        const scanX = world.pos_x[cellIdx] + Math.cos(slotAngle) * world.radius[cellIdx];
        const scanY = world.pos_y[cellIdx] + Math.sin(slotAngle) * world.radius[cellIdx];
        // Search free protein grid near scan point
        const gx = Math.floor(scanX / world.gridCellSize);
        const gy = Math.floor(scanY / world.gridCellSize);
        let found = -1, bestDist = CONFIG.intakeRadius * CONFIG.intakeRadius;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = gx + dx, ny = gy + dy;
          if (nx < 0 || nx >= world.gridW || ny < 0 || ny >= world.gridH) continue;
          const bucket = world.freePGrid[ny * world.gridW + nx];
          for (let k = 0; k < bucket.length; k++) {
            const fp = bucket[k];
            if (!world.freeP_alive[fp]) continue;
            const ddx = world.freeP_x[fp] - scanX, ddy = world.freeP_y[fp] - scanY;
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 < bestDist) { bestDist = d2; found = fp; }
          }
        }
        if (found >= 0) {
          cytoInc(cellIdx, world.freeP_type[found]);
          _freeFreePSlot(found);
        }
      }
    }
  }
}
