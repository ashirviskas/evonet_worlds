// ============================================================
// RIBOSOME
// ============================================================
function ribosomeStep(cellIdx) {
  if (world.rng.next() < CONFIG.ribosomeRandomJumpRate) {
    const genome = world.genomes[cellIdx];
    if (genome && genome.length > 0) {
      const ci = world.rng.nextInt(genome.length);
      world.ribo_chromIdx[cellIdx] = ci;
      world.ribo_offset[cellIdx] = world.rng.nextInt(genome[ci].length);
    }
  }

  if (world.ribo_searchMode[cellIdx]) {
    const genome = world.genomes[cellIdx];
    if (!genome || genome.length === 0) { world.ribo_searchMode[cellIdx] = 0; return; }
    let ci = world.ribo_chromIdx[cellIdx], off = world.ribo_offset[cellIdx];
    const chrom = genome[ci];
    if (off < chrom.length && chrom[off] === world.ribo_searchByte[cellIdx]) {
      world.ribo_searchMode[cellIdx] = 0; world.ribo_offset[cellIdx] = off; return;
    }
    off++;
    if (off >= chrom.length) { ci = world.rng.nextInt(genome.length); off = 0; }
    world.ribo_chromIdx[cellIdx] = ci; world.ribo_offset[cellIdx] = off;
    world.ribo_searchTicks[cellIdx]--;
    if (world.ribo_searchTicks[cellIdx] <= 0) {
      world.ribo_searchMode[cellIdx] = 0;
      world.ribo_chromIdx[cellIdx] = world.rng.nextInt(genome.length);
      world.ribo_offset[cellIdx] = 0;
    }
    return;
  }

  world.ribo_tickCounter[cellIdx]++;
  if (world.ribo_tickCounter[cellIdx] < CONFIG.ticksPerInstruction) return;
  world.ribo_tickCounter[cellIdx] = 0;

  const genome = world.genomes[cellIdx];
  if (!genome || genome.length === 0) return;
  let ci = world.ribo_chromIdx[cellIdx];
  if (ci >= genome.length) ci = 0;
  const chrom = genome[ci];
  if (!chrom || chrom.length === 0) return;
  let off = world.ribo_offset[cellIdx];
  if (off >= chrom.length) off = 0;

  const byte = chrom[off];
  off++;
  if (off >= chrom.length) { ci = world.rng.nextInt(genome.length); off = 0; }
  world.ribo_chromIdx[cellIdx] = ci; world.ribo_offset[cellIdx] = off;

  if (world.ribo_holding[cellIdx]) {
    executeWithArg(cellIdx, world.ribo_heldOpcode[cellIdx], byte);
    world.ribo_holding[cellIdx] = 0; return;
  }

  // 16-class layout: opcodes 0x40..0xAF are 2-byte (hold arg); everything else is
  // either an executed 1-byte control (0x00..0x3F) or a 1-byte NOP (0xB0..0xFF).
  if (byte <= 0x3F) { executeControl(cellIdx, byte); }
  else if (byte <= 0xAF) { world.ribo_holding[cellIdx] = 1; world.ribo_heldOpcode[cellIdx] = byte; }
  // 0xB0-0xFF: NOP
}

function executeControl(cellIdx, opcode) {
  // 0x00-0x0F: Control. Only 0x02 fires legacy DIVIDE; rest are no-ops.
  // 0x10-0x1F: REPLICASE_START — replicase-only marker, NOP in ribosome.
  // 0x20-0x2F: REPLICASE_END   — replicase-only marker, NOP in ribosome.
  // 0x30-0x3F: NOP.
  if (opcode === 0x02) {
    if (!CONFIG.legacyDivisionEnabled) return;
    const dc = world.internalProteins[cellIdx * 64 + 4];
    if (dc >= CONFIG.divisionProteinThreshold && world.energy[cellIdx] >= CONFIG.divisionEnergyThreshold) {
      if (!world.dividing[cellIdx]) world.dividing[cellIdx] = 1;
    }
  }
}

function executeWithArg(cellIdx, opcode, arg) {
  if (opcode <= 0x4F) {
    // MAKE_PROTEIN. Type 36 (Storing battery) is synthesised pre-charged:
    // cost the normal makeProteinCost plus the energy that ends up inside it.
    const pt = arg % 64;
    const cost = pt === 36 ? CONFIG.makeProteinCost + CONFIG.energyStorageBonus : CONFIG.makeProteinCost;
    if (world.energy[cellIdx] < cost) return;
    world.energy[cellIdx] -= cost;
    cytoInc(cellIdx, pt);
  } else if (opcode <= 0x5F) {
    // SLOT_OPEN
    const sl = arg % NUM_SLOTS;
    world.slotOpen[cellIdx * NUM_SLOTS + sl] = 1;
  } else if (opcode <= 0x6F) {
    // SLOT_CLOSE
    const sl = arg % NUM_SLOTS;
    world.slotOpen[cellIdx * NUM_SLOTS + sl] = 0;
  } else if (opcode <= 0x7F) {
    // SEARCH_JUMP — scan forward for byte=arg. Fallback already handled in search loop.
    world.ribo_searchMode[cellIdx] = 1;
    world.ribo_searchByte[cellIdx] = arg;
    world.ribo_searchTicks[cellIdx] = 1000;
  } else if (opcode <= 0x8F) {
    // CHROMOSOME_JUMP — find chromosome with shape=arg%10; fall back to a random
    // chromosome if none match, so ribosome always jumps somewhere.
    const genome = world.genomes[cellIdx];
    if (!genome || genome.length === 0) return;
    const targetShape = arg % 10;
    let found = -1;
    for (let c = 0; c < genome.length; c++) {
      if (chromosomeShape(genome[c]) === targetShape) { found = c; break; }
    }
    if (found < 0) found = world.rng.nextInt(genome.length);
    world.ribo_chromIdx[cellIdx] = found;
    world.ribo_offset[cellIdx] = 0;
  }
  // 0x90-0xAF: REPLICASE_JUMP_BYTE / REPLICASE_JUMP_CHROMOSOME — replicase-only,
  // ribosome consumes the arg byte harmlessly and moves on.
}

function chromosomeShape(chrom) {
  if (!chrom || chrom.length === 0) return 0;
  let hash = 0;
  for (let i = 0; i < Math.min(4, chrom.length); i++) hash = ((hash << 5) - hash + chrom[i]) | 0;
  return ((hash >>> 0) % 10);
}
