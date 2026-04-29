// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// DIRECTIONAL SENSORS (types 39, 40, 41)
// ============================================================
// Each cell may hold:
//   39 — Photon Sensor: fires when a photon is in the slot's angular sector
//        (special slots 1..6) or in range (slot 0 / membrane).
//   40 — Cell Sensor:   fires when another living cell is in the sector / in range.
//   41 — Free-Protein Sensor: fires when a free protein is in the sector / in range.
//
// Detection range: world.radius[i] + CONFIG.sensorRange.
// Detection angle: slot 0 = omnidirectional; slots 1..6 each cover a 60° sector
//   matching the same angle→slot formula used by collision (08_collision.js:44)
//   and photon absorption (10_photons.js:122-123).
// Firing model: per-protein Bernoulli(CONFIG.sensorSignalRate) gated by the
//   per-(cell,slot) stimulus flag. Geometric-gap optimization (one RNG call
//   per actual fire) — same trick as sensorTick (09_movement.js:8-22).
// On fire: emitSensorOutput walks forward through the same slot's subslots
//   starting at (subslotK + 1), wrapping at NUM_SUBSLOTS. First match wins:
//     Push (5) / Pull (6) motor → apply impulse along slot direction.
//     Empty subslot           → subslotBind a Move Signal (type 7) here.
//     Move Signal subslot     → subslotInc (cap at maxSubslotProteins).
//     Other proteins          → keep walking.
//   Full lap with no destination → cytoAdd Move Signal in cytoplasm.
//
// The per-(cell,slot) stimulus flags live in world.photonNearSlot,
// world.cellNearSlot, world.proteinNearSlot. Each is Uint8Array[maxCells *
// NUM_SLOTS]. Reset every tick by resetSensorFlags().

const _PHOTON_SENSOR_TYPE = 39;
const _CELL_SENSOR_TYPE = 40;
const _PROTEIN_SENSOR_TYPE = 41;
const _MOVE_SIGNAL = 7;
const _PUSH_MOTOR = 5;
const _PULL_MOTOR = 6;
const _TWO_PI = Math.PI * 2;

// True if cell holds at least one of `type` in any slot. O(NUM_SLOTS) via
// the slotTypeCount cache (06_slot_helpers.js:154).
function _cellHasProteinType(cellIdx, type) {
  const stcBase = cellIdx * NUM_SLOTS * 64;
  for (let s = 0; s < NUM_SLOTS; s++) {
    if (world.slotTypeCount[stcBase + s * 64 + type] > 0) return true;
  }
  return false;
}

// Pre-pass: for each alive cell with any Cell Sensor (type 40), walk grid
// neighbors and flag the (cell, slot) pairs whose sector contains another
// live cell within (radius_i + radius_j + sensorRange). Resets flags first.
function cellNearScan() {
  world.cellNearSlot.fill(0);
  const range = CONFIG.sensorRange;
  for (let i = 0; i < world.maxCells; i++) {
    if (!world.alive[i]) continue;
    if (!_cellHasProteinType(i, _CELL_SENSOR_TYPE)) continue;
    const xi = world.pos_x[i], yi = world.pos_y[i], ri = world.radius[i];
    const flagsBase = i * NUM_SLOTS;
    const neighbors = getNeighborCells(i);
    for (let k = 0; k < neighbors.length; k++) {
      const j = neighbors[k];
      if (!world.alive[j]) continue;
      const dx = world.pos_x[j] - xi, dy = world.pos_y[j] - yi;
      const minDist = ri + world.radius[j] + range;
      if (dx * dx + dy * dy >= minDist * minDist) continue;
      world.cellNearSlot[flagsBase] = 1; // membrane omnidirectional
      const a = ((Math.atan2(dy, dx) % _TWO_PI) + _TWO_PI) % _TWO_PI;
      const slot = 1 + ((a / _TWO_PI * 6) | 0) % 6;
      world.cellNearSlot[flagsBase + slot] = 1;
    }
  }
}

// Pre-pass: for each alive cell with any Free-Protein Sensor (type 41), scan
// the 3x3 freePGrid neighborhood and flag (cell, slot) pairs whose sector
// contains a free protein within (radius + sensorRange). Resets flags first.
function proteinNearScan() {
  world.proteinNearSlot.fill(0);
  const range = CONFIG.sensorRange;
  const gcs = world.gridCellSize, gw = world.gridW, gh = world.gridH;
  for (let i = 0; i < world.maxCells; i++) {
    if (!world.alive[i]) continue;
    if (!_cellHasProteinType(i, _PROTEIN_SENSOR_TYPE)) continue;
    const xi = world.pos_x[i], yi = world.pos_y[i], ri = world.radius[i];
    const reach = ri + range;
    const reachSq = reach * reach;
    const flagsBase = i * NUM_SLOTS;
    let gx = (xi / gcs) | 0; if (gx < 0) gx = 0; else if (gx >= gw) gx = gw - 1;
    let gy = (yi / gcs) | 0; if (gy < 0) gy = 0; else if (gy >= gh) gy = gh - 1;
    let span = 1;
    if (reach > gcs * 0.5) { span = Math.ceil(reach / gcs); if (span < 1) span = 1; }
    const gxMin = gx - span < 0 ? 0 : gx - span, gxMax = gx + span >= gw ? gw - 1 : gx + span;
    const gyMin = gy - span < 0 ? 0 : gy - span, gyMax = gy + span >= gh ? gh - 1 : gy + span;
    for (let gy2 = gyMin; gy2 <= gyMax; gy2++) {
      for (let gx2 = gxMin; gx2 <= gxMax; gx2++) {
        const bucket = world.freePGrid[gy2 * gw + gx2];
        for (let k = 0, bl = bucket.length; k < bl; k++) {
          const p = bucket[k];
          const dx = world.freeP_x[p] - xi, dy = world.freeP_y[p] - yi;
          if (dx * dx + dy * dy >= reachSq) continue;
          world.proteinNearSlot[flagsBase] = 1;
          const a = ((Math.atan2(dy, dx) % _TWO_PI) + _TWO_PI) % _TWO_PI;
          const slot = 1 + ((a / _TWO_PI * 6) | 0) % 6;
          world.proteinNearSlot[flagsBase + slot] = 1;
        }
      }
    }
  }
}

// Per-cell tick for one directional-sensor type. Iterates subslots holding
// `sensorType` and, if the corresponding slot's near-flag is set, runs
// geometric-gap Bernoulli sampling and emits one output per fire.
function directionalSensorTick(cellIdx, sensorType, nearArr) {
  const stcBase = cellIdx * NUM_SLOTS * 64;
  // Cheap exit: cell has none of this sensor type in any slot.
  let total = 0;
  for (let s = 0; s < NUM_SLOTS; s++) total += world.slotTypeCount[stcBase + s * 64 + sensorType];
  if (total === 0) return;

  const p = CONFIG.sensorSignalRate;
  if (p <= 0) return;
  const logOneMinusP = Math.log(1 - p);
  const subBase = cellIdx * TOTAL_SUBSLOTS_PER_CELL;
  const flagsBase = cellIdx * NUM_SLOTS;

  for (let s = 0; s < NUM_SLOTS; s++) {
    if (world.slotTypeCount[stcBase + s * 64 + sensorType] === 0) continue;
    if (nearArr[flagsBase + s] === 0) continue;
    for (let ss = 0; ss < NUM_SUBSLOTS; ss++) {
      const k = s * NUM_SUBSLOTS + ss;
      const si = subBase + k;
      if (world.subslotType[si] !== sensorType) continue;
      const cnt = world.subslotCount[si];
      if (cnt === 0) continue;
      let i = 0;
      while (true) {
        const u = world.rng.next();
        const gap = u <= 0 ? 1 : Math.max(1, Math.ceil(Math.log(1 - u) / logOneMinusP));
        i += gap;
        if (i > cnt) break;
        emitSensorOutput(cellIdx, s, ss);
      }
    }
  }
}

// One sensor fire originating at (cellIdx, slotIdx, subslotK). Walks forward
// through the same slot's subslots starting at (subslotK + 1) with wrap, full
// lap. First match wins; if no match, fall back to cytoplasm Move Signal.
function emitSensorOutput(cellIdx, slotIdx, subslotK) {
  const isMembrane = slotIdx === 0;
  // Slot direction matches motorTick (09_movement.js:36): special slots 1..6
  // span the unit circle in 60° steps.
  const slotAngle = isMembrane ? 0 : (slotIdx - 1) * (Math.PI / 3);
  const subBase = cellIdx * TOTAL_SUBSLOTS_PER_CELL + slotIdx * NUM_SUBSLOTS;

  for (let i = 1; i <= NUM_SUBSLOTS; i++) {
    const ss = (subslotK + i) % NUM_SUBSLOTS;
    const si = subBase + ss;
    const t = world.subslotType[si];

    // Direct motor activation only meaningful in special slots — slot 0 has
    // no natural impulse direction, so motors there are skipped (treated as
    // "keep walking") and any deposit lands further along the ring.
    if (!isMembrane && (t === _PUSH_MOTOR || t === _PULL_MOTOR)) {
      const dir = t === _PUSH_MOTOR ? 1 : -1;
      world.vel_x[cellIdx] += Math.cos(slotAngle) * CONFIG.motorImpulse * dir;
      world.vel_y[cellIdx] += Math.sin(slotAngle) * CONFIG.motorImpulse * dir;
      world.milestones.cellMoved++;
      return;
    }

    if (t === 255) {
      // Empty subslot — deposit a fresh Move Signal here.
      subslotBind(cellIdx, slotIdx * NUM_SUBSLOTS + ss, _MOVE_SIGNAL);
      return;
    }

    if (t === _MOVE_SIGNAL) {
      // Existing Move Signal — increment if there's headroom; if capped, keep
      // walking so the fire isn't silently dropped.
      if (world.subslotCount[si] < CONFIG.maxSubslotProteins) {
        subslotInc(cellIdx, slotIdx * NUM_SUBSLOTS + ss);
        return;
      }
      // capped → fall through, keep walking
    }

    // Other protein (non-motor, non-empty, non-MS, or capped MS) — keep walking.
  }

  // Full lap, no destination — cytoplasm fallback.
  cytoAdd(cellIdx, _MOVE_SIGNAL, 1);
}
