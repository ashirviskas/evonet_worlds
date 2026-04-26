// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// COLLISION PHYSICS & DAMAGE
// ============================================================
function collisionPhysics() {
  const processed = new Set();
  for (let i = 0; i < world.maxCells; i++) {
    if (!world.alive[i]) continue;
    const neighbors = getNeighborCells(i);
    for (let k = 0; k < neighbors.length; k++) {
      const j = neighbors[k];
      if (!world.alive[j]) continue;
      const key = i < j ? i * world.maxCells + j : j * world.maxCells + i;
      if (processed.has(key)) continue;
      processed.add(key);

      const dx = world.pos_x[j] - world.pos_x[i], dy = world.pos_y[j] - world.pos_y[i];
      const dist = Math.sqrt(dx * dx + dy * dy);
      const minDist = world.radius[i] + world.radius[j];
      if (dist < minDist && dist > 0.01) {
        const overlap = minDist - dist;
        const nx = dx / dist, ny = dy / dist;

        // Adhesion reduces repulsion (type 9 in membrane = slot 0)
        const adhI = countProteinInSlot(i, 0, 9), adhJ = countProteinInSlot(j, 0, 9);
        const adhFactor = Math.max(0.05, 1.0 - (adhI + adhJ) * 0.1);
        const force = overlap * CONFIG.collisionRepulsion * adhFactor;
        world.vel_x[i] -= nx * force * 0.5; world.vel_y[i] -= ny * force * 0.5;
        world.vel_x[j] += nx * force * 0.5; world.vel_y[j] += ny * force * 0.5;

        const angleIJ = Math.atan2(dy, dx);
        applyCollisionDamage(i, j, angleIJ);
        applyCollisionDamage(j, i, angleIJ + Math.PI);
      }
    }
  }
}

function applyCollisionDamage(attackerIdx, defenderIdx, angle) {
  const a = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

  // Attack: membrane (slot 0) = 1x, relevant special slot = 3x
  let attackStr = countProteinInSlot(attackerIdx, 0, 2) * 1.0;
  attackStr += countProteinInSlot(attackerIdx, 0, 13) * 1.0; // digestive enzyme in membrane
  const aSpecSlot = 1 + ((a / (Math.PI * 2) * 6) | 0) % 6;
  attackStr += countProteinInSlot(attackerIdx, aSpecSlot, 2) * 3.0;
  attackStr += countProteinInSlot(attackerIdx, aSpecSlot, 13) * 3.0;

  if (attackStr <= 0 && CONFIG.baseCollisionDamage <= 0) return;

  const da = ((angle + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  let defStr = countProteinInSlot(defenderIdx, 0, 3) * 1.0;
  defStr += countProteinInSlot(defenderIdx, 0, 14) * 1.0;
  const dSpecSlot = 1 + ((da / (Math.PI * 2) * 6) | 0) % 6;
  defStr += countProteinInSlot(defenderIdx, dSpecSlot, 3) * 3.0;
  defStr += countProteinInSlot(defenderIdx, dSpecSlot, 14) * 3.0;

  const netDmg = Math.max(0, attackStr + CONFIG.baseCollisionDamage - defStr) * CONFIG.collisionDamageScale;
  if (netDmg > 0) world.membraneHP[defenderIdx] -= netDmg;
}
