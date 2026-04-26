// ============================================================
// WORLD STATE (SoA)
// ============================================================
const NUM_SLOTS = CONFIG.numSlots;         // 7
const NUM_SUBSLOTS = CONFIG.numSubslots;   // 10
const MAX_SUB_PROTEINS = CONFIG.maxSubslotProteins; // 10

const world = {
  tick: 0, rng: makeRNG(CONFIG.seed), numCells: 0, maxCells: 4096,
  alive: null, pos_x: null, pos_y: null, vel_x: null, vel_y: null,
  radius: null, energy: null, membraneHP: null, age: null, parentId: null, generation: null,

  // Subslot data: [cellIdx * NUM_SLOTS * NUM_SUBSLOTS + slotIdx * NUM_SUBSLOTS + subIdx]
  // Each subslot: proteinType (255=empty), count (0-10)
  subslotType: null,   // Uint8Array — protein type in this subslot (255=empty)
  subslotCount: null,  // Uint8Array — how many of that type (0-10)
  slotOpen: null,      // Uint8Array — [cellIdx * NUM_SLOTS + slotIdx] = 1 if open

  // Cytoplasm proteins: [cellIdx * 64 + typeId] = count
  internalProteins: null,

  // Per-cell-per-slot directional-sensor flags. Reset each tick. See initWorld.
  photonNearSlot: null, cellNearSlot: null, proteinNearSlot: null,

  genomes: null,
  ribo_chromIdx: null, ribo_offset: null, ribo_holding: null, ribo_heldOpcode: null,
  ribo_searchMode: null, ribo_searchByte: null, ribo_searchTicks: null, ribo_tickCounter: null,
  dividing: null,

  // Interaction table: 64×64×2 (left + right affinity)
  interactionLeft: null,   // Float32Array[64*64] — affinity when neighbor is to the left
  interactionRight: null,  // Float32Array[64*64] — affinity when neighbor is to the right

  decayRates: null,
  energyField: null, energyFieldW: 16, energyFieldH: 12,

  photon_x: null, photon_y: null, photon_vx: null, photon_vy: null, photon_alive: null, photon_age: null, photon_energy: null, photonCount: 0,
  // Dense live-index list: photonLive[0..photonLiveCount-1] are live slots;
  // photonLive[photonLiveCount..maxPhotons-1] are free slots. O(1) spawn/kill
  // via append / swap-and-pop. photon_alive[] is kept as a redundant flag for
  // rendering/UI readers.
  photonLive: null, photonLiveIdx: null, photonLiveCount: 0,
  // Per-cell current grid bucket (linear index, -1 if not in grid). Enables
  // incremental grid updates: only cells that crossed a bucket edge move.
  cellGridIdx: null,
  // Same idea for free proteins.
  freePGridIdx: null,
  // Decay countdown tables (see below).
  decayNextCyto: null, decayNextSub: null,
  lightSourceAngle: 0, // current angle of moving light source
  grid: null, gridW: 0, gridH: 0, gridCellSize: 24,

  // Free proteins in medium (SoA, ring buffer like photons)
  freeP_x: null, freeP_y: null, freeP_vx: null, freeP_vy: null, freeP_type: null, freeP_alive: null, freePCount: 0,
  freePLive: null, freePLiveIdx: null, freePLiveCount: 0,
  freePGrid: null, // spatial grid for intake queries

  // Free chromosomes in medium
  freeChromosomes: [], // array of {x, y, vx, vy, data: Uint8Array, age}

  // Replicase job pool — many jobs per cell, global ring-buffer pool (see 17_replicase.js).
  // Jobs are indexed by slot 0..maxReplicaseJobs. Per-cell active count is denormalized.
  replicase_job_alive: null,       // Uint8Array[maxReplicaseJobs]
  replicase_job_cellIdx: null,     // Int32Array[maxReplicaseJobs]
  replicase_job_sourceIdx: null,   // Uint8Array
  replicase_job_targetShape: null, // Uint8Array
  replicase_job_progress: null,    // Uint16Array
  replicase_job_ticksLeft: null,   // Uint32Array (Uint16 truncated timeouts > 65535)
  replicase_job_output: null,      // Array of number[] (growing), or null
  replicase_job_sourceBytes: null, // Array of Map<lineageId, byteCount>, or null
  replicase_job_sourceRef: null,   // Array of Uint8Array — authoritative source pointer (survives genome reordering)
  // New scan/copy-phase fields (see 17_replicase.js).
  replicase_job_phase: null,       // Uint8Array — 0=SCANNING for replicase_start, 1=COPYING
  replicase_job_holding: null,     // Uint8Array — 1 if the next emitted byte is an arg for a held replicase-jump opcode
  replicase_job_heldOpcode: null,  // Uint8Array — the held opcode byte when holding=1
  replicase_job_scanStart: null,   // Uint16Array — initial landing position (fallback if scan finds no replicase_start)
  replicase_job_scanRemaining: null, // Int32Array — bytes left in one full scan loop before falling back
  replicase_activeCount: null,     // Uint8Array[maxCells]
  replicase_nextSlot: 0,           // ring-buffer allocation cursor

  // Membrane division state
  membraneDividing: null,       // Uint8Array — multi-tick counter for membrane-driven division

  milestones: { cellReached500: 0, cellMakingDivider: 0, divisionsTotal: 0,
    threeGenLineage: 0, cellSurvived10k: 0, maxPopulation: 0, cellMoved: 0, photonsAbsorbed: 0,
    freePSpawned: 0, freeChromSpawned: 0, replicaseCompleted: 0, replicaseFailed: 0,
    membraneDivisions: 0, chromAbsorptions: 0, chromEjections: 0 },
};

const TOTAL_SUBSLOTS_PER_CELL = NUM_SLOTS * NUM_SUBSLOTS; // 70

// Lineage highlight set — lineageIds whose live chromosomes (in cells and free)
// should be ringed on the main canvas. Declared here (not in 19b_lineage_render)
// so 19_rendering can read it without file-order coupling.
const lineageHighlight = { ids: new Set() };

function subIdx(cellIdx, slotIdx, subslotIdx) {
  return cellIdx * TOTAL_SUBSLOTS_PER_CELL + slotIdx * NUM_SUBSLOTS + subslotIdx;
}

function initWorld() {
  const max = world.maxCells;
  world.alive = new Uint8Array(max);
  world.pos_x = new Float32Array(max); world.pos_y = new Float32Array(max);
  world.vel_x = new Float32Array(max); world.vel_y = new Float32Array(max);
  world.radius = new Float32Array(max); world.energy = new Float32Array(max);
  world.membraneHP = new Float32Array(max);
  world.age = new Uint32Array(max); world.parentId = new Int32Array(max).fill(-1);
  world.generation = new Uint32Array(max);

  world.subslotType = new Uint8Array(max * TOTAL_SUBSLOTS_PER_CELL).fill(255);
  world.subslotCount = new Uint8Array(max * TOTAL_SUBSLOTS_PER_CELL);
  world.slotOpen = new Uint8Array(max * NUM_SLOTS).fill(0);
  world.internalProteins = new Uint16Array(max * 64);
  // Occupancy bitmasks maintained in lockstep with the counts above.
  // cytoOccMask[ci*2 + w]: bit t in word w means internalProteins[ci*64 + (w*32 + t)] > 0.
  // subslotOccMask[ci*3 + w]: bit k in word w means subslotCount[ci*70 + (w*32 + k)] > 0.
  // Enables O(occupied) iteration of decay/migrate via bit-scan, strictly
  // equivalent visit order to the previous dense 0..63 / 0..69 loops.
  world.cytoOccMask = new Uint32Array(max * 2);
  world.subslotOccMask = new Uint32Array(max * 3);
  // Per-cell, per-slot, per-type count: number of proteins of type t held in
  // slot s of cell ci, summed across subslots. Lets countProteinInSlot be
  // O(1). Max value is numSubslots * maxSubslotProteins = 100, fits in Uint8.
  world.slotTypeCount = new Uint8Array(max * NUM_SLOTS * 64);
  // Per-cell, per-slot directional-sensor stimulus flags. Reset every tick by
  // resetSensorFlags() (09b_directional_sensors.js); populated by photonTick
  // (photons), cellNearScan (cells), proteinNearScan (free proteins). 1 byte
  // per (cell, slot) is enough — only the boolean "stimulus in this sector
  // this tick" is read; counts beyond 1 are not used.
  world.photonNearSlot = new Uint8Array(max * NUM_SLOTS);
  world.cellNearSlot = new Uint8Array(max * NUM_SLOTS);
  world.proteinNearSlot = new Uint8Array(max * NUM_SLOTS);
  // Decay countdown tables. Entry stores the absolute world.tick on which the
  // next decay fires; sentinel 0 = unscheduled (lazily initialized on first
  // visit with count > 0). Relies on geometric memorylessness — a stale
  // countdown is still correctly distributed.
  world.decayNextCyto = new Uint32Array(max * 64);
  world.decayNextSub = new Uint32Array(max * TOTAL_SUBSLOTS_PER_CELL);

  world.genomes = new Array(max).fill(null);
  world.ribo_chromIdx = new Uint8Array(max); world.ribo_offset = new Uint16Array(max);
  world.ribo_holding = new Uint8Array(max); world.ribo_heldOpcode = new Uint8Array(max);
  world.ribo_searchMode = new Uint8Array(max); world.ribo_searchByte = new Uint8Array(max);
  world.ribo_searchTicks = new Uint16Array(max); world.ribo_tickCounter = new Uint8Array(max);
  world.dividing = new Uint8Array(max);

  // Asymmetric interaction tables
  world.interactionLeft = new Float32Array(64 * 64);
  world.interactionRight = new Float32Array(64 * 64);
  for (let i = 0; i < 64 * 64; i++) {
    world.interactionLeft[i] = world.rng.nextRange(-1, 1);
    world.interactionRight[i] = world.rng.nextRange(-1, 1);
  }

  world.decayRates = new Float32Array(64);
  for (let i = 0; i < 64; i++) {
    world.decayRates[i] = CONFIG.proteinDecayBase * (0.1 + world.rng.next() * world.rng.next() * 10);
  }

  const fw = world.energyFieldW, fh = world.energyFieldH;
  world.energyField = new Float32Array(fw * fh);
  for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
    const base = 1.0 - (y / fh) * 0.7;
    world.energyField[y * fw + x] = base * (0.5 + world.rng.next() * 0.5);
  }

  world.photon_x = new Float32Array(CONFIG.maxPhotons); world.photon_y = new Float32Array(CONFIG.maxPhotons);
  world.photon_vx = new Float32Array(CONFIG.maxPhotons); world.photon_vy = new Float32Array(CONFIG.maxPhotons);
  world.photon_alive = new Uint8Array(CONFIG.maxPhotons); world.photon_age = new Uint16Array(CONFIG.maxPhotons);
  world.photon_energy = new Float32Array(CONFIG.maxPhotons);
  world.lightSourceAngle = 0;
  world.photonCount = 0;
  // Init live list as identity permutation — all slots start on the free stack.
  world.photonLive = new Int32Array(CONFIG.maxPhotons);
  world.photonLiveIdx = new Int32Array(CONFIG.maxPhotons);
  for (let i = 0; i < CONFIG.maxPhotons; i++) { world.photonLive[i] = i; world.photonLiveIdx[i] = i; }
  world.photonLiveCount = 0;

  // Free proteins
  world.freeP_x = new Float32Array(CONFIG.maxFreeProteins); world.freeP_y = new Float32Array(CONFIG.maxFreeProteins);
  world.freeP_vx = new Float32Array(CONFIG.maxFreeProteins); world.freeP_vy = new Float32Array(CONFIG.maxFreeProteins);
  world.freeP_type = new Uint8Array(CONFIG.maxFreeProteins); world.freeP_alive = new Uint8Array(CONFIG.maxFreeProteins);
  world.freePCount = 0;
  world.freePLive = new Int32Array(CONFIG.maxFreeProteins);
  world.freePLiveIdx = new Int32Array(CONFIG.maxFreeProteins);
  for (let i = 0; i < CONFIG.maxFreeProteins; i++) { world.freePLive[i] = i; world.freePLiveIdx[i] = i; }
  world.freePLiveCount = 0;

  // Free chromosomes
  world.freeChromosomes = [];

  // Replicase job pool
  const jp = CONFIG.maxReplicaseJobs;
  world.replicase_job_alive = new Uint8Array(jp);
  world.replicase_job_cellIdx = new Int32Array(jp);
  world.replicase_job_sourceIdx = new Uint8Array(jp);
  world.replicase_job_targetShape = new Uint8Array(jp);
  world.replicase_job_progress = new Uint16Array(jp);
  world.replicase_job_ticksLeft = new Uint32Array(jp);
  world.replicase_job_output = new Array(jp).fill(null);
  world.replicase_job_sourceBytes = new Array(jp).fill(null);
  world.replicase_job_sourceRef = new Array(jp).fill(null);
  world.replicase_job_phase = new Uint8Array(jp);
  world.replicase_job_holding = new Uint8Array(jp);
  world.replicase_job_heldOpcode = new Uint8Array(jp);
  world.replicase_job_scanStart = new Uint16Array(jp);
  world.replicase_job_scanRemaining = new Int32Array(jp);
  world.replicase_activeCount = new Uint8Array(max);
  world.replicase_nextSlot = 0;

  // Membrane division
  world.membraneDividing = new Uint8Array(max);

  world.gridCellSize = CONFIG.gridCellSize;
  world.gridW = Math.ceil(CONFIG.worldWidth / world.gridCellSize);
  world.gridH = Math.ceil(CONFIG.worldHeight / world.gridCellSize);
  world.grid = new Array(world.gridW * world.gridH);
  for (let i = 0; i < world.grid.length; i++) world.grid[i] = [];
  world.cellGridIdx = new Int32Array(max).fill(-1);

  // Free protein spatial grid (same dimensions as cell grid)
  world.freePGrid = new Array(world.gridW * world.gridH);
  for (let i = 0; i < world.freePGrid.length; i++) world.freePGrid[i] = [];
  world.freePGridIdx = new Int32Array(CONFIG.maxFreeProteins).fill(-1);

  world.milestones = { cellReached500: 0, cellMakingDivider: 0, divisionsTotal: 0,
    threeGenLineage: 0, cellSurvived10k: 0, maxPopulation: 0, cellMoved: 0, photonsAbsorbed: 0,
    freePSpawned: 0, freeChromSpawned: 0, replicaseCompleted: 0, replicaseFailed: 0,
    membraneDivisions: 0, chromAbsorptions: 0, chromEjections: 0 };

  for (let i = 0; i < CONFIG.initialCells; i++) {
    spawnCell(world.rng.nextRange(50, CONFIG.worldWidth - 50), world.rng.nextRange(50, CONFIG.worldHeight - 50), -1, 0);
  }
}

function spawnCell(x, y, parentId, generation) {
  let idx = -1;
  for (let i = 0; i < world.maxCells; i++) { if (!world.alive[i]) { idx = i; break; } }
  if (idx === -1) return -1;

  world.alive[idx] = 1;
  world.pos_x[idx] = x; world.pos_y[idx] = y;
  world.vel_x[idx] = 0; world.vel_y[idx] = 0;
  world.radius[idx] = 8 + world.rng.next() * 4;
  world.energy[idx] = CONFIG.initialEnergy;
  world.membraneHP[idx] = CONFIG.membraneMaxHP;
  world.age[idx] = 0; world.parentId[idx] = parentId; world.generation[idx] = generation;

  const len = 32 + world.rng.nextInt(96);
  const chrom = new Uint8Array(len);
  for (let i = 0; i < len; i++) chrom[i] = world.rng.nextInt(256);
  world.genomes[idx] = [chrom];
  assignLineage(chrom, [], 'initial', 'cell');

  world.ribo_chromIdx[idx] = 0; world.ribo_offset[idx] = 0;
  world.ribo_holding[idx] = 0; world.ribo_heldOpcode[idx] = 0;
  world.ribo_searchMode[idx] = 0; world.ribo_tickCounter[idx] = 0;
  world.dividing[idx] = 0;
  // Defensive: new cell has no outstanding replicase jobs (the slot is reused from a dead cell).
  // killCell() is responsible for freeing jobs; activeCount should already be 0 here.
  world.replicase_activeCount[idx] = 0;
  world.membraneDividing[idx] = 0;

  // Reset all subslots
  for (let s = 0; s < NUM_SLOTS; s++) {
    world.slotOpen[idx * NUM_SLOTS + s] = 0;
    for (let ss = 0; ss < NUM_SUBSLOTS; ss++) {
      const si = subIdx(idx, s, ss);
      world.subslotType[si] = 255;
      world.subslotCount[si] = 0;
    }
  }
  for (let t = 0; t < 64; t++) world.internalProteins[idx * 64 + t] = 0;

  world.numCells++;
  gridAddCell(idx);
  return idx;
}
