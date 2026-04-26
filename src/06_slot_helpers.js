// ============================================================
// SLOT/SUBSLOT HELPERS
// ============================================================

// ---- occupancy-mask maintenance ----
// Cytoplasm (64 types per cell, 2 words). Mutations must flow through these
// helpers so the bitmask in world.cytoOccMask stays in sync with
// world.internalProteins. decayProteins / migrateProteins iterate the mask
// via bit-scan for O(occupied) cost.
function cytoInc(cellIdx, t) {
  const idx = cellIdx * 64 + t;
  if (world.internalProteins[idx] >= CONFIG.maxCytoplasmPerType) return;
  if (world.internalProteins[idx]++ === 0) {
    world.cytoOccMask[cellIdx * 2 + (t >> 5)] |= 1 << (t & 31);
  }
}
function cytoAdd(cellIdx, t, n) {
  if (n <= 0) return;
  const idx = cellIdx * 64 + t;
  const headroom = CONFIG.maxCytoplasmPerType - world.internalProteins[idx];
  if (headroom <= 0) return;
  if (n > headroom) n = headroom;
  if (world.internalProteins[idx] === 0) {
    world.cytoOccMask[cellIdx * 2 + (t >> 5)] |= 1 << (t & 31);
  }
  world.internalProteins[idx] += n;
}
function cytoDec(cellIdx, t) {
  const idx = cellIdx * 64 + t;
  if (--world.internalProteins[idx] === 0) {
    world.cytoOccMask[cellIdx * 2 + (t >> 5)] &= ~(1 << (t & 31));
  }
}
function cytoSub(cellIdx, t, n) {
  if (n <= 0) return;
  const idx = cellIdx * 64 + t;
  world.internalProteins[idx] -= n;
  if (world.internalProteins[idx] === 0) {
    world.cytoOccMask[cellIdx * 2 + (t >> 5)] &= ~(1 << (t & 31));
  }
}
// Assign an absolute value. Used by split paths where the new count is a
// derived share; must be > 0 validation-wise, reconciles bitmask both ways.
function cytoSet(cellIdx, t, v) {
  const idx = cellIdx * 64 + t;
  const was = world.internalProteins[idx];
  world.internalProteins[idx] = v;
  if (was === 0 && v > 0) {
    world.cytoOccMask[cellIdx * 2 + (t >> 5)] |= 1 << (t & 31);
  } else if (was > 0 && v === 0) {
    world.cytoOccMask[cellIdx * 2 + (t >> 5)] &= ~(1 << (t & 31));
  }
}
function cytoClearAll(cellIdx) {
  const base = cellIdx * 64;
  for (let t = 0; t < 64; t++) world.internalProteins[base + t] = 0;
  world.cytoOccMask[cellIdx * 2] = 0;
  world.cytoOccMask[cellIdx * 2 + 1] = 0;
}

// Subslots (NUM_SLOTS*NUM_SUBSLOTS = 70 entries per cell, 3 words). Mutations
// to subslotCount (and the implicit type=255 reset on zero) must flow
// through these helpers. decayProteins iterates occupied subslots via
// bit-scan.
function _subslotOccSet(cellIdx, k) {
  world.subslotOccMask[cellIdx * 3 + (k >> 5)] |= 1 << (k & 31);
}
function _subslotOccClear(cellIdx, k) {
  world.subslotOccMask[cellIdx * 3 + (k >> 5)] &= ~(1 << (k & 31));
}
// slotTypeCount[ci * NUM_SLOTS * 64 + slot * 64 + type] tracks how many
// proteins of `type` live in slot `slot` of cell `ci`, summed across subslots.
// The helpers below keep it in sync with every subslot mutation.
function _stcAdd(cellIdx, k, type, n) {
  if (n === 0 || type >= 64) return;
  world.slotTypeCount[cellIdx * NUM_SLOTS * 64 + ((k / NUM_SUBSLOTS) | 0) * 64 + type] += n;
}
function _stcSub(cellIdx, k, type, n) {
  if (n === 0 || type >= 64) return;
  world.slotTypeCount[cellIdx * NUM_SLOTS * 64 + ((k / NUM_SUBSLOTS) | 0) * 64 + type] -= n;
}

// Decrement one protein from subslot at flat index k (0..69). On zero, clear
// type and mask bit — but leave decayNextSub stale (the original code only
// cleared decayNext in the decay path itself and in the membrane-repair
// fallback; migrate-unbind / divide / killCell relied on geometric
// memorylessness and left the countdown stale). Callers that want the
// countdown cleared must do it themselves.
function subslotDec(cellIdx, k) {
  const si = cellIdx * TOTAL_SUBSLOTS_PER_CELL + k;
  const type = world.subslotType[si];
  if (--world.subslotCount[si] === 0) {
    world.subslotType[si] = 255;
    _subslotOccClear(cellIdx, k);
  }
  _stcSub(cellIdx, k, type, 1);
}
// Bind a new protein into an empty subslot (count 0→1, type set).
function subslotBind(cellIdx, k, type) {
  const si = cellIdx * TOTAL_SUBSLOTS_PER_CELL + k;
  world.subslotType[si] = type;
  world.subslotCount[si] = 1;
  _subslotOccSet(cellIdx, k);
  _stcAdd(cellIdx, k, type, 1);
}
// Increment count on an already-occupied subslot (count > 0, same type).
function subslotInc(cellIdx, k) {
  const si = cellIdx * TOTAL_SUBSLOTS_PER_CELL + k;
  const type = world.subslotType[si];
  world.subslotCount[si]++;
  _stcAdd(cellIdx, k, type, 1);
}
// Change the type of an occupied subslot without touching count or mask.
// Caller guarantees count >= 1; move the current count from oldType to newType
// in the per-slot counter.
function subslotSetType(cellIdx, k, type) {
  const si = cellIdx * TOTAL_SUBSLOTS_PER_CELL + k;
  const oldType = world.subslotType[si];
  const count = world.subslotCount[si];
  world.subslotType[si] = type;
  _stcSub(cellIdx, k, oldType, count);
  _stcAdd(cellIdx, k, type, count);
}
// Full absolute set, used by divideCell when transferring a share to a child.
// On count → 0, clears type and mask bit but leaves decayNextSub stale (to
// match the original divideCell behavior, which only cleared type).
function subslotAssign(cellIdx, k, type, count) {
  const si = cellIdx * TOTAL_SUBSLOTS_PER_CELL + k;
  const was = world.subslotCount[si];
  const wasType = world.subslotType[si];
  world.subslotCount[si] = count;
  world.subslotType[si] = count > 0 ? type : 255;
  if (was === 0 && count > 0) _subslotOccSet(cellIdx, k);
  else if (was > 0 && count === 0) _subslotOccClear(cellIdx, k);
  _stcSub(cellIdx, k, wasType, was);
  _stcAdd(cellIdx, k, type, count);
}
// Bulk clear used by killCell — resets every subslot in a cell.
function subslotClearAll(cellIdx) {
  const base = cellIdx * TOTAL_SUBSLOTS_PER_CELL;
  for (let k = 0; k < TOTAL_SUBSLOTS_PER_CELL; k++) {
    world.subslotType[base + k] = 255;
    world.subslotCount[base + k] = 0;
  }
  world.subslotOccMask[cellIdx * 3] = 0;
  world.subslotOccMask[cellIdx * 3 + 1] = 0;
  world.subslotOccMask[cellIdx * 3 + 2] = 0;
  const stcBase = cellIdx * NUM_SLOTS * 64;
  for (let i = 0; i < NUM_SLOTS * 64; i++) world.slotTypeCount[stcBase + i] = 0;
}

// Count how many proteins of a given type are in a slot (across all subslots).
// O(1) via the slotTypeCount cache.
function countProteinInSlot(cellIdx, slotIdx, proteinType) {
  return world.slotTypeCount[cellIdx * NUM_SLOTS * 64 + slotIdx * 64 + proteinType];
}

// Total protein count in a slot
function slotTotalCount(cellIdx, slotIdx) {
  let n = 0;
  for (let ss = 0; ss < NUM_SUBSLOTS; ss++) n += world.subslotCount[subIdx(cellIdx, slotIdx, ss)];
  return n;
}

// Total count of a protein type across cytoplasm + every subslot in the cell.
function cellTotalProteinCount(cellIdx, type) {
  let n = world.internalProteins[cellIdx * 64 + type];
  const base = cellIdx * TOTAL_SUBSLOTS_PER_CELL;
  for (let k = 0; k < TOTAL_SUBSLOTS_PER_CELL; k++) {
    if (world.subslotType[base + k] === type) n += world.subslotCount[base + k];
  }
  return n;
}

// Pick one random instance of `type` from the cell weighted by count, and
// convert it in place to `otherType`. Returns true if a conversion happened.
//
// Subslot bookkeeping:
//   subslotCount > 1 → decrement source subslot, push +1 to cytoplasm of
//     otherType (subslots can only hold one type, so the converted protein
//     migrates out).
//   subslotCount == 1 → flip subslotType in place, count unchanged. Reset
//     decayNextSub so the new type's decay rate kicks in next pass.
//   cytoplasm → straight count swap.
function convertOneStorageProtein(cellIdx, type, otherType) {
  const total = cellTotalProteinCount(cellIdx, type);
  if (total === 0) return false;
  let pick = world.rng.nextInt(total);

  const cytoCount = world.internalProteins[cellIdx * 64 + type];
  if (pick < cytoCount) {
    cytoDec(cellIdx, type);
    cytoInc(cellIdx, otherType);
    return true;
  }
  pick -= cytoCount;

  const base = cellIdx * TOTAL_SUBSLOTS_PER_CELL;
  for (let k = 0; k < TOTAL_SUBSLOTS_PER_CELL; k++) {
    if (world.subslotType[base + k] !== type) continue;
    const c = world.subslotCount[base + k];
    if (pick < c) {
      if (c > 1) {
        // Decrement the subslot by 1; it stays occupied with the same type.
        // subslotDec safely handles the mask, but here count stays >= 1.
        subslotDec(cellIdx, k);
        cytoInc(cellIdx, otherType);
      } else {
        // Count was 1 → flip the subslot's type in place (count unchanged).
        subslotSetType(cellIdx, k, otherType);
        world.decayNextSub[base + k] = 0;
      }
      return true;
    }
    pick -= c;
  }
  return false;
}

// Type 35 = Energy Storage [Empty]. Type 36 = Energy Storage [Storing].
// Discharge: when energy <= cap - 30 and a Storing exists, drain one Storing
//   to give the cell +energyStorageBonus. Loop until either condition fails.
// Recharge: when energy >= cap - 10 and an Empty exists, charge one Empty by
//   spending energyStorageBonus from the cell. Loop until either fails.
// The 10-vs-30 hysteresis gap keeps a cell sitting between cap-10 and cap-30
// from oscillating.
function cellEnergyStorageTick(cellIdx) {
  const cap = CONFIG.energyCap;
  const v = CONFIG.energyStorageBonus;

  // Discharge first — a hungry cell prioritises survival.
  while (world.energy[cellIdx] <= cap - 3 * v) {
    if (!convertOneStorageProtein(cellIdx, 36, 35)) break;
    world.energy[cellIdx] += v;
  }
  // Then recharge any spare income.
  while (world.energy[cellIdx] >= cap - v) {
    if (!convertOneStorageProtein(cellIdx, 35, 36)) break;
    world.energy[cellIdx] -= v;
  }
}
