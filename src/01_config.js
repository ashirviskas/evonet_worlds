// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  // --- World dimensions (pixels) ---
  worldWidth: 2400,                  // world bounding width — cells bounce off this edge
  worldHeight: 1800,                 // world bounding height
  initialCells: 40,                  // how many random cells to seed the world with; also the floor maintained by the respawner
  seed: 42,                          // RNG seed — deterministically drives interaction table, decay rates, and initial genomes

  // --- Ribosome / execution ---
  ticksPerInstruction: 10,           // world ticks per one opcode executed by a ribosome (higher = slower "thinking")
  ribosomeRandomJumpRate: 0.0001,    // per-tick chance that a ribosome jumps to a random byte on a random chromosome
  numProteinTypes: 64,               // size of the protein-type alphabet; also the width of the interaction table (64x64)

  // --- Protein dynamics ---
  proteinDecayBase: 0.0001,          // baseline per-tick decay probability per protein — actual per-type rate varies 0.1x-10x around this
  mutationRate: 0.0001,               // per-byte mutation probability on chromosome copy (runtime-adjustable via slider)
  slotBindRate: 0.01,                // max per-tick chance a cytoplasm protein binds into a subslot (scaled by affinity)
  slotUnbindRate: 0.002,             // per-tick chance a bound protein unbinds back into the cytoplasm
  maxCytoplasmPerType: 10,           // hard cap per protein type in a cell's cytoplasm; clamped in cytoInc/cytoAdd

  // --- Energy economy ---
  energyPerPhoton: 2.5,              // (unused — photonEnergyValue is authoritative)
  metabolismCost: 0.02,              // flat per-tick energy drain per cell
  makeProteinCost: 1.0,              // energy cost to synthesize one protein via make_protein opcode
  initialEnergy: 50,                 // energy given to newly-spawned cells
  energyCap: 500,                    // max energy any one cell can hold (slider)
  energyStorageBonus: 10,            // energy held by one Storing battery (type 36); also the discharge/recharge step. See cellEnergyStorageTick.

  // --- Division (legacy DIVIDE_MARKER path) ---
  divisionEnergyThreshold: 80,       // minimum energy required to start dividing
  divisionProteinThreshold: 5,       // minimum Divider-Trigger proteins (type 4) to arm legacy division
  divisionTicks: 20,                 // elongation duration in ticks before the split completes

  // --- DNA degradation (aging) ---
  degradationStartAge: 100000,        // age (ticks) at which DNA damage starts
  degradationStartRate: 0.000001,    // initial per-tick per-byte random-flip probability once degradation begins
  degradationIncreasePerEra: 0.3,    // multiplicative growth per era (1 + rate) — 0.3 = +30% per era
  degradationEraLength: 10000,       // era length in ticks — degradation rate is compounded once per era
  degradationMaxRate: 0.01,          // hard cap on per-byte degradation probability

  // --- Slot structure (v0.4) ---
  numSlots: 7,                       // 1 membrane (slot 0) + 6 special (slots 1..6)
  numSubslots: 10,                   // each slot has 10 subslots arranged linearly (left/right affinities apply)
  maxSubslotProteins: 10,            // max proteins per subslot (must all be the same type within one subslot)

  // --- Physics ---
  collisionRepulsion: 0.5,           // stiffness of cell-cell repulsion on overlap
  collisionDamageScale: 0.1,         // scales net (attack - defense) into per-tick energy damage
  baseCollisionDamage: 0.005,        // minimum damage applied on any collision, even with zero attack proteins
  gridCellSize: 24,                  // spatial-hash bucket size (world units). Must be >= 2 * max cell radius (~16) so the 9-bucket neighbor scan is correct. Smaller = finer grid = fewer cells per photon collision check but more buckets. Applied on initWorld only.

  // --- Self-propulsion ---
  motorImpulse: 0.3,                 // velocity impulse added per motor activation (per move-signal consumed)
  sensorSignalRate: 0.005,           // per-tick chance a Sensor protein in a special slot produces a move signal
  sensorRange: 4.0,                  // world-units of detection margin past cell radius for directional sensors (types 39/40/41)

  // --- Photons (light particles → energy for photon catchers) ---
  maxPhotons: 3000,                  // ring-buffer cap for photon particles
  photonSpeed: 0.8,                  // world-units per tick
  photonSpawnRate: 2,                // photons spawned per tick from the orbiting light source
  photonEnergyValue: 5.3,            // energy granted to a cell when its photon catcher absorbs one
  photonLifetime: 3000,              // ticks before a photon dies naturally
  lightSourceRadius: 400,            // spawn radius around the light source
  lightSourceSpeed: 0.0003,         // orbital angular velocity of the light source (radians/tick)
  lightSourceMoving: true,           // if false, the light source holds its current position

  // --- Free proteins in medium ---
  maxFreeProteins: 4000,             // ring-buffer cap for free proteins floating in the world
  freeProteinDecayRate: 0.0002,      // per-tick decay probability for a free protein
  freeProteinDrift: 0.05,            // Brownian motion strength for free proteins

  // --- Pumps ---
  expelRate: 0.02,                   // per-tick-per-protein chance an Expel Pump (type 16) ejects one cytoplasm protein
  intakeRate: 0.02,                  // per-tick-per-protein chance an Intake Pump (type 17) grabs one nearby free protein
  intakeRadius: 30,                  // world-units reach of an Intake Pump in the slot's angular direction

  // --- Free chromosomes in medium ---
  maxFreeChromosomes: 200,           // cap on free chromosomes alive at once
  freeChromDegradeTicks: 2000,       // ticks between each random-byte loss for a free chromosome (lower = faster degrade) TODO: Should be NOT JUST LOSS BUT MUTATIONS FIRST ALSO SHOULD BE AGE SET FROM WHEN THEY START DEGRADING. CHROMOSOMES DISINTEGRATE AND RELEASE REPLICASE CONSUMED PROTEINS
  chromSpawnInterval: 50000,           // ticks between spawns of a random chromosome (primordial soup)
  chromSpawnEnabled: true,             // master switch for the primordial spawner (UI checkbox)
  chromSpawnMinLen: 8,               // min length of soup-spawned chromosomes
  chromSpawnMaxLen: 32,              // max length of soup-spawned chromosomes
  cellSpawnMinLen: 8,                // min length of the initial chromosome inside a freshly spawned cell
  cellSpawnMaxLen: 32,               // max length of the initial chromosome inside a freshly spawned cell

  // --- Chromosome ejection/absorption ---
  chromEjectThreshold: 5,            // Chromosome Ejector (type 20) count in cytoplasm needed to eject one chromosome
  chromAbsorbRate: 0.1,              // per-tick probability a cell absorbs an overlapping free chromosome (blocked by type 21)

  // --- Replicase (chromosome duplication) ---
  replicaseTimeout: 100000,             // ticks before an in-progress replicase job gives up if still short on proteins
  replicaseProteinAdvanceChance: 1.0, // per-tick chance the protein path advances one byte (when a Replicase protein is available)
  replicaseEnergyAdvanceEnabled: true,// master switch for the energy-only advance path (no protein needed)
  replicaseEnergyAdvanceChance: 0.0001, // per-tick chance the energy path advances one byte (default 1/10000)
  replicaseEnergyAdvanceCost: 10,    // energy consumed per byte copied via the energy path
  replicaseBaseErrorRate: 0.02,      // base per-byte error probability (scaled up by cytoplasm noise)
  replicaseNoiseScale: 1000,          // divisor for noise-based error amplification (higher = more tolerant of junk proteins)
  replicaseMaxOverrun: 50,           // max extra bytes a "no-stop" error can copy past the source chromosome end

  // --- Replication Starter (protein type 22) ---
  replicationStarterRate: 0.001,     // per-tick per-starter-protein chance to bind a random chromosome and begin duplication
  maxReplicaseJobs: 400,             // global cap on concurrent replicase jobs across all cells
  maxReplicaseJobsPerCell: 6,        // per-cell cap; additional starter binds fail (starter not consumed) until a job frees

  // --- Membrane HP ---
  membraneMaxHP: 100,                // full-health cap
  membraneDecayPerTick: 0.02,        // 100/0.02 = 5000 ticks to decay fully with no repair
  membraneRepairPerProtein: 10,      // HP restored per consumed Base Membrane (type 19)
  membraneRepairMinDeficit: 10,      // only heal when HP deficit >= this (avoids wasting proteins on tiny damage)

  // --- Cell size / membrane growth ---
  spawnRadius: 10.0,                 // every new cell starts at this radius (no randomness)
  minRadius: 1.0,                    // hard lower bound for radius (Shrinkage protein cannot push below)
  maxRadius: 1000.0,                 // hard upper bound for radius (Growth protein cannot push above)
  radiusGrowthStep: 0.25,            // radius increase per Growth protein consumed
  radiusShrinkStep: 0.25,            // radius decrease per Shrinkage protein consumed
  membraneRemodelRate: 0.01,         // per-protein per-tick consumption probability for Growth/Shrinkage
  upkeepAreaExponent: 2.0,           // metabolismCost scales by (radius / spawnRadius)^this

  // --- Membrane-driven division ---
  membraneDivisionThreshold: 10,     // Base Membrane (type 19) count required in cytoplasm to arm division; exactly this many are consumed at split (the surplus carries over and splits with cytoplasm). Also requires ≥1 Divider Trigger (type 4); all Divider Triggers are consumed at split.
  legacyDivisionEnabled: false,      // if true, DIVIDE_MARKER opcode (0x02) works; if false, only membrane-driven division runs

  // --- Chromase (DNA digestor, type 23) + Inhibitor (type 24) ---
  byteSynthesisCost: 0.5,            // nominal energy/byte used only for digestion payout
  enzymeSynthesisCost: 1.0,          // nominal energy/enzyme used only for digestion payout
  digestEfficiency: 0.8,             // cap on recovered energy vs theoretical synthesis cost
  chromaseReachRadius: 6,            // world units a free Chromase must be within to bite a free chromosome

  // --- Lineage graph (DNA-level family tree) ---
  lineageMaxNodes: 50000,                 // hard safety cap; Pass-3 drops oldest dead leaves if exceeded
  lineageCollapseSoftThreshold: 25000,    // Pass-2 chain-collapse triggers at this threshold, targets this size
  lineagePruneInterval: 200,              // ticks between prune sweeps
  lineageDeadLeafGraceTicks: 1000,        // terminal dead-leaves drop this long after death
  lineagePreserveCopiesEver: 100,         // nodes whose copies or copiesEver reached this are pinned: never dropped, never collapsed
  lineageDegradeCheckpointBytes: 8,       // emit a checkpoint node every N bytes eroded by degrade/digest
  lineageCrossoverMinBytes: 4,            // per-parent contribution to count as crossover vs minor switch
  lineageDebugAssert: false,              // flip on to run lineageAssertInvariants() at the tail of each prune sweep
};
