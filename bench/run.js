#!/usr/bin/env node
// Headless benchmark harness for evo_net.
//
// Loads src/*.js (simulation files only — rendering/UI/DOM wiring is skipped
// and stubbed). Runs tick() in a loop, times each phase, prints a report.
//
// The sim bundle runs inside a single `new Function(...)` closure (not a
// `vm.createContext` sandbox). That matters for perf: V8 optimizes
// vm-context code much worse than plain module code (proxied global lookups,
// poor cross-context inlining), so a vm-hosted bench used to run ~15x slower
// than the same code in Chrome. Keeping everything in one native closure
// means the bench throughput now tracks browser throughput.
//
// Usage:
//   node bench/run.js                         # default: 500 cells, 10k ticks
//   node bench/run.js --cells=2000 --ticks=20000
//   node bench/run.js --seed-genome=<hex>     # inject a seed genome into all starter cells
//   node bench/run.js --ticks=100000 --seed-genome="fa 58 68 c0 7f 3d 00 3d 13 3d 00 3d 12 3d 3d 00 3d 13 3d 00 3d 12 c3 3d 00 3d 13 3d 00 3d 16"
//
// Flags:
//   --cells=N         initialCells (default 500)
//   --ticks=N         timed ticks after warmup (default 10000)
//   --warmup=N        warmup ticks (default 1000)
//   --seed=N          RNG seed (default 42)
//   --seed-genome=hex inject this genome (hex, space-separated) into all initial cells
//   --quiet           less output

const fs = require('fs');
const path = require('path');

// ---------- args ----------
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  if (!a.startsWith('--')) return [a, true];
  const eq = a.indexOf('=');
  return eq === -1 ? [a.slice(2), true] : [a.slice(2, eq), a.slice(eq + 1)];
}));
const CELLS    = parseInt(args.cells  || '500', 10);
const TICKS    = parseInt(args.ticks  || '10000', 10);
const WARMUP   = parseInt(args.warmup || '1000', 10);
const SEED     = parseInt(args.seed   || '42', 10);
const QUIET    = !!args.quiet;
const SEED_GENOME_HEX = args['seed-genome'] || null;

const seedGenome = SEED_GENOME_HEX ? Uint8Array.from(
  SEED_GENOME_HEX.trim().split(/\s+/).map(h => parseInt(h, 16))
) : null;
if (SEED_GENOME_HEX && seedGenome.some(b => Number.isNaN(b))) {
  console.error('bad hex in --seed-genome');
  process.exit(1);
}

// ---------- DOM stubs (installed on globalThis; sim code reads `document`/`window` etc.) ----------
const stubEl = new Proxy(function(){}, {
  get(t, k) {
    if (k === 'style' || k === 'dataset' || k === 'classList') return stubEl;
    if (k === 'getContext') return () => stubEl;
    if (k === 'getBoundingClientRect') return () => ({ width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 });
    if (k === 'addEventListener' || k === 'removeEventListener' || k === 'observe' || k === 'preventDefault') return () => {};
    if (k === 'add' || k === 'remove' || k === 'toggle' || k === 'contains') return () => {};
    if (k === 'appendChild' || k === 'removeChild' || k === 'insertBefore') return x => x;
    if (k === 'querySelectorAll') return () => [];
    if (k === 'querySelector' || k === 'closest') return () => stubEl;
    if (k === 'innerHTML' || k === 'textContent' || k === 'value') return '';
    if (k === 'width' || k === 'height' || k === 'clientWidth' || k === 'clientHeight') return 800;
    if (k === 'checked') return false;
    return stubEl;
  },
  set() { return true; },
  apply() { return stubEl; },
});
globalThis.document = {
  getElementById: () => stubEl,
  querySelector: () => stubEl,
  querySelectorAll: () => [],
  addEventListener: () => {},
  createElement: () => stubEl,
  body: stubEl,
  activeElement: stubEl,
};
globalThis.window = { addEventListener: () => {}, innerWidth: 1600, innerHeight: 900, CONFIG: null };
globalThis.ResizeObserver = function() { return { observe: () => {}, disconnect: () => {} }; };
globalThis.requestAnimationFrame = () => 0; // main loop is driven manually here
globalThis.navigator = { clipboard: { writeText: () => Promise.resolve() } };
// `performance.now()` is already provided by Node, keep Node's.

// ---------- load sources ----------
// Include simulation files only. Skip rendering (19), lineage render (19b),
// UI (20, 21, 22, 23) and main loop (24). Include tooltip (00)? It sets up
// DOM events; harmless but unnecessary — skip.
const SRC = path.join(__dirname, '..', 'src');
const SIM_FILES = [
  '01_config.js',
  '02_protein_info.js',
  '03_rng.js',
  '04_world.js',
  '05_spatial_grid.js',
  '06_slot_helpers.js',
  '07_tick.js',
  '08_collision.js',
  '09_movement.js',
  '09b_directional_sensors.js',
  '10_photons.js',
  '11_ribosome.js',
  '12_decay_migration_energy.js',
  '13_free_proteins.js',
  '14_free_chromosomes.js',
  '14b_lineage.js',
  '15_pump.js',
  '16_chrom_eject_absorb.js',
  '16b_chromase.js',
  '17_replicase.js',
  '18_membrane_division.js',
];
let bundle = '';
for (const f of SIM_FILES) {
  bundle += `// ===== ${f} =====\n` + fs.readFileSync(path.join(SRC, f), 'utf8') + '\n';
}

// ---------- phase instrumentation ----------
// Phase functions are declared at the top of the closure via `function name()`,
// so their bindings are mutable inside that same closure. We wrap them in place
// so every call site (they're looked up by name from tick()) hits the wrapper.
const PHASES = [
  'rebuildGrid',
  'decayProteins', 'sensorTick', 'motorTick', 'ribosomeStep',
  'migrateProteins', 'pumpTick', 'chromEjectTick', 'chromaseInternalTick',
  'replicationStarterTick', 'membraneDivisionCheck', 'degradeDNA', 'divideCell',
  'collisionPhysics', 'replicaseTick', 'photonTick', 'freeProteinTick',
  'rebuildFreeProteinGrid', 'freeChromosomeTick', 'chromaseExternalTick',
  'chromAbsorbAll', 'lineagePrune', 'killCell',
];

const instrumentSrc = PHASES.map(p => `
  if (typeof ${p} === 'function') {
    const __orig_${p} = ${p};
    ${p} = function() {
      const __t0 = process.hrtime.bigint();
      try { return __orig_${p}.apply(this, arguments); }
      finally {
        __phaseTimes['${p}'] += Number(process.hrtime.bigint() - __t0);
        __phaseCalls['${p}']++;
      }
    };
  }
`).join('\n');

// ---------- build the sim closure ----------
// Everything that needs to be hot — tick loop, phase wrappers, world access —
// lives inside this single Function so V8 can inline and optimize freely.
const simSrc = `
  "use strict";
  ${bundle}

  // Config overrides before initWorld().
  CONFIG.seed = __seedVal;
  CONFIG.initialCells = __cellsVal;
  initWorld();

  // Optional seed-genome injection — overwrite every alive cell's chromosome.
  if (__seedGenome) {
    const g = __seedGenome;
    for (let i = 0; i < world.maxCells; i++) {
      if (!world.alive[i]) continue;
      const prior = world.genomes[i];
      if (prior && typeof lineageMarkDead === 'function') {
        for (const c of prior) { try { lineageMarkDead(c, 'cell'); } catch(e) {} }
      }
      const chrom = new Uint8Array(g.length);
      chrom.set(g);
      world.genomes[i] = [chrom];
      if (typeof assignLineage === 'function') {
        try { assignLineage(chrom, [], 'seed', 'cell'); } catch(e) {}
      }
      world.ribo_chromIdx[i] = 0;
      world.ribo_offset[i] = 0;
    }
  }

  // Phase timing accumulators — mutable objects returned to the outer harness.
  const __phaseTimes = {};
  const __phaseCalls = {};
  for (const p of ${JSON.stringify(PHASES)}) { __phaseTimes[p] = 0; __phaseCalls[p] = 0; }

  ${instrumentSrc}

  return {
    runTicks(n) { for (let i = 0; i < n; i++) tick(); },
    resetPhaseTimes() {
      for (const k in __phaseTimes) { __phaseTimes[k] = 0; __phaseCalls[k] = 0; }
    },
    phaseTimes: __phaseTimes,
    phaseCalls: __phaseCalls,
    numCells: () => world.numCells,
    tickNum:  () => world.tick,
    lineageStats: () => lineageStats(),
  };
`;

const sim = new Function('process', '__seedVal', '__cellsVal', '__seedGenome', simSrc)(
  process, SEED, CELLS, seedGenome
);

if (SEED_GENOME_HEX && !QUIET) {
  console.log(`injected seed genome (${seedGenome.length} bytes) into ${CELLS} cells`);
}

// ---------- run ----------
if (!QUIET) {
  console.log(`evo_net headless benchmark`);
  console.log(`  cells=${CELLS}  warmup=${WARMUP}  ticks=${TICKS}  seed=${SEED}  seed-genome=${SEED_GENOME_HEX ? 'yes' : 'no'}`);
}

// warmup (timed but reset after)
const wStart = process.hrtime.bigint();
sim.runTicks(WARMUP);
const wElapsed = Number(process.hrtime.bigint() - wStart) / 1e6;
if (!QUIET) console.log(`  warmup: ${WARMUP} ticks in ${wElapsed.toFixed(1)} ms (${(WARMUP/wElapsed*1000).toFixed(0)} t/s), pop=${sim.numCells()}`);

sim.resetPhaseTimes();

// Population samples during timed run
const popSamples = [];
const tStart = process.hrtime.bigint();
const chunk = Math.max(1, Math.min(5000, Math.floor(TICKS / 20)));
let done = 0;
while (done < TICKS) {
  const step = Math.min(chunk, TICKS - done);
  sim.runTicks(step);
  done += step;
  popSamples.push({ tick: sim.tickNum(), pop: sim.numCells() });
  if (!QUIET) process.stderr.write(`\r  timed: ${done}/${TICKS} ticks  pop=${sim.numCells()}   `);
}
const tElapsed = Number(process.hrtime.bigint() - tStart) / 1e6;
if (!QUIET) process.stderr.write('\n');

// ---------- report ----------
console.log(`\n=== RESULT ===`);
console.log(`ticks:       ${TICKS}`);
console.log(`wall:        ${tElapsed.toFixed(1)} ms`);
console.log(`throughput:  ${(TICKS/tElapsed*1000).toFixed(1)} ticks/sec`);
console.log(`ms/tick:     ${(tElapsed/TICKS).toFixed(4)} ms`);
console.log(`final pop:   ${sim.numCells()}`);
console.log(`final tick:  ${sim.tickNum()}`);
console.log(`peak pop:    ${Math.max(...popSamples.map(s => s.pop))}`);
const lstats = sim.lineageStats();
console.log(`lineage:     total=${lstats.total} alive=${lstats.alive} ghost=${lstats.ghost || 0} dead=${lstats.dead || 0} copies=${lstats.copies} merges=${lstats.merges}`);
console.log();
console.log(`=== PHASE BREAKDOWN (% of total timed ticks, sorted by time) ===`);

// Include both pre-registered PHASES and any additional keys written by
// sub-instrumentation hooks inside tick() (prefixed with "_").
const allPhaseKeys = Array.from(new Set([...PHASES, ...Object.keys(sim.phaseTimes)]));
// Sub-instrumented keys are bracketed, not real phases — exclude from % total
// to keep the "sum to 100%" behaviour for the wrapped phase list.
const realPhaseTotal = PHASES.reduce((a, k) => a + (sim.phaseTimes[k] || 0), 0);
const rows = allPhaseKeys
  .map(p => ({
    phase: p,
    ms: (sim.phaseTimes[p] || 0) / 1e6,
    calls: sim.phaseCalls[p] || 0,
    pct: (sim.phaseTimes[p] || 0) / realPhaseTotal * 100,
    isSub: p.startsWith('_'),
  }))
  .filter(r => r.calls > 0)
  .sort((a,b) => b.ms - a.ms);

const pad = (s, n) => String(s).padStart(n);
console.log(`  ${'phase'.padEnd(26)} ${'ms'.padStart(10)} ${'%'.padStart(7)} ${'calls'.padStart(12)} ${'us/call'.padStart(10)}`);
for (const r of rows) {
  const label = r.isSub ? `[${r.phase}]` : r.phase;
  console.log(`  ${label.padEnd(26)} ${pad(r.ms.toFixed(1), 10)} ${pad(r.pct.toFixed(1), 7)} ${pad(r.calls, 12)} ${pad((r.ms*1000/r.calls).toFixed(2), 10)}`);
}
console.log(`  (wrapped-phase total = ${(realPhaseTotal/1e6).toFixed(1)} ms / wall ${tElapsed.toFixed(1)} ms — gap is uninstrumented work in tick(); [bracketed] rows are sub-instrumented blocks inside tick(), overlapping wrapped phases)`);

console.log();
console.log(`=== POPULATION CURVE ===`);
for (const s of popSamples) console.log(`  tick=${pad(s.tick, 8)}  pop=${s.pop}`);
