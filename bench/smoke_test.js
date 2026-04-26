// Smoke test: load the whole simulation in node with stubbed DOM globals,
// run a few ticks, and verify replicase produces children without throwing.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_DIR = path.join(__dirname, '..', 'src');
// Skip the main-loop bootstrap (DOM-bound).
const files = fs.readdirSync(SRC_DIR).filter(f => f.endsWith('.js') && f !== '24_main_loop.js').sort();

const noop = () => {};
const makeStubCanvas = () => ({
  getContext: () => new Proxy({}, { get: () => noop }),
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }),
  addEventListener: noop,
  width: 800, height: 600, style: {},
});
const makeStubEl = () => new Proxy({
  style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  addEventListener: noop, removeEventListener: noop, appendChild: noop, removeChild: noop,
  querySelectorAll: () => [], querySelector: () => null,
  getContext: () => new Proxy({}, { get: () => noop }),
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }),
  setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
  textContent: '', innerHTML: '', innerText: '',
  children: [], childNodes: [], parentNode: null,
  width: 800, height: 600, value: '', checked: false,
  focus: noop, blur: noop, click: noop, select: noop,
  getRootNode: () => ({ host: null }),
}, {
  get(t, k) {
    if (k in t) return t[k];
    return makeStubEl();
  },
  set(t, k, v) { t[k] = v; return true; },
});

const documentStub = new Proxy({
  getElementById: () => makeStubEl(),
  querySelector: () => makeStubEl(),
  querySelectorAll: () => [],
  createElement: () => makeStubEl(),
  createElementNS: () => makeStubEl(),
  addEventListener: noop, removeEventListener: noop,
  body: makeStubEl(),
  documentElement: makeStubEl(),
  head: makeStubEl(),
  hidden: false,
}, { get(t, k) { if (k in t) return t[k]; return makeStubEl(); } });

const windowStub = new Proxy({
  document: documentStub,
  addEventListener: noop, removeEventListener: noop,
  innerWidth: 1280, innerHeight: 720,
  devicePixelRatio: 1,
  requestAnimationFrame: noop, cancelAnimationFrame: noop,
  setInterval: () => 0, clearInterval: noop,
  setTimeout: () => 0, clearTimeout: noop,
  location: { hash: '', search: '', pathname: '/' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  URL: { createObjectURL: () => '', revokeObjectURL: noop },
  navigator: { userAgent: '' },
  performance: { now: () => Date.now() },
  atob: s => Buffer.from(s, 'base64').toString('binary'),
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
}, { get(t, k) { if (k in t) return t[k]; return undefined; } });

const ctx = vm.createContext({
  document: documentStub,
  window: windowStub,
  navigator: windowStub.navigator,
  location: windowStub.location,
  localStorage: windowStub.localStorage,
  requestAnimationFrame: noop, cancelAnimationFrame: noop,
  setInterval: () => 0, clearInterval: noop,
  setTimeout: () => 0, clearTimeout: noop,
  performance: windowStub.performance,
  console,
  atob: windowStub.atob,
  btoa: windowStub.btoa,
  URL: windowStub.URL,
  Image: function Image() { return makeStubEl(); },
  HTMLCanvasElement: function () {},
  CanvasRenderingContext2D: function () {},
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float32Array, Float64Array,
  Math, Date, JSON, Object, Array, Map, Set, WeakMap, WeakSet, Promise, Error, Symbol,
  Number, String, Boolean, RegExp, Proxy, Reflect, Buffer, String,
});

for (const f of files) {
  const src = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
  try {
    vm.runInContext(src, ctx, { filename: f });
  } catch (e) {
    console.error(`FAIL loading ${f}:`, e.message);
    process.exit(1);
  }
}

console.log('all src files loaded OK');

// Manually bootstrap the world (main_loop.js does this but is DOM-bound).
try { vm.runInContext('initWorld();', ctx, { filename: 'bootstrap' }); }
catch (e) { console.error('initWorld FAIL:', e.stack); process.exit(3); }

// Force-inject a chromosome with REPLICASE_START ... REPLICASE_END into cell 0
// so the scan/copy path is exercised deterministically.
const script = `
(function () {
  const cell = 0;
  if (!world.alive[cell]) return 'no cell 0 alive';
  const chrom = new Uint8Array(40);
  // Random-ish prefix
  for (let i = 0; i < 10; i++) chrom[i] = (i * 17 + 3) & 0xFF;
  chrom[10] = 0x15;       // REPLICASE_START
  chrom[11] = 0x45;       // MAKE_PROTEIN opcode
  chrom[12] = 0x05;       // arg = protein type 5
  chrom[13] = 0x93;       // REPLICASE_JUMP_BYTE
  chrom[14] = 0x25;       // arg: jump to byte 0x25 (REPLICASE_END)
  for (let i = 15; i < 25; i++) chrom[i] = (i * 7) & 0xFF;
  chrom[25] = 0x25;       // REPLICASE_END (target of jump)
  for (let i = 26; i < 40; i++) chrom[i] = (i * 11) & 0xFF;
  world.genomes[cell] = [chrom];
  assignLineage(chrom, [], 'test', 'cell');
  // Grant a pile of replicase proteins and a starter to push the job through.
  world.internalProteins[cell * 64 + 18] = 5000; // replicase
  world.internalProteins[cell * 64 + 22] = 1;   // starter
  world.energy[cell] = 1e6;

  const before = world.milestones.replicaseCompleted;
  for (let i = 0; i < 20000; i++) { tick(); if (world.milestones.replicaseCompleted > before) break; }
  const after = world.milestones.replicaseCompleted;
  const genome = world.genomes[cell];
  const childLen = genome ? (genome.length > 1 ? genome[genome.length - 1].length : -1) : -1;
  const firstByte = genome && genome.length > 1 ? genome[genome.length - 1][0] : -1;
  const lastByte = genome && genome.length > 1 ? genome[genome.length - 1][childLen - 1] : -1;
  return JSON.stringify({
    completedBefore: before,
    completedAfter: after,
    chromsInCell: genome ? genome.length : -1,
    childLen,
    firstByteHex: firstByte >= 0 ? firstByte.toString(16) : 'n/a',
    lastByteHex: lastByte >= 0 ? lastByte.toString(16) : 'n/a',
  });
})();
`;

try {
  const result = vm.runInContext(script, ctx, { filename: 'smoke_probe' });
  console.log('probe:', result);
} catch (e) {
  console.error('probe FAIL:', e.stack);
  process.exit(2);
}

// Now run the sim "naturally" for many ticks on the default seed and check
// that replication still happens and the sim doesn't throw.
const naturalRun = `
(function () {
  // Re-init with more cells to speed up.
  initWorld();
  const startTick = world.tick;
  const startCompleted = world.milestones.replicaseCompleted;
  const startFailed = world.milestones.replicaseFailed;
  let popMax = 0;
  for (let i = 0; i < 50000; i++) {
    tick();
    if (world.numCells > popMax) popMax = world.numCells;
  }
  return JSON.stringify({
    ticksRun: world.tick - startTick,
    replicaseCompleted: world.milestones.replicaseCompleted - startCompleted,
    replicaseFailed: world.milestones.replicaseFailed - startFailed,
    divisionsTotal: world.milestones.divisionsTotal,
    popMax,
    popNow: world.numCells,
  });
})();
`;
try {
  const result = vm.runInContext(naturalRun, ctx, { filename: 'natural_run' });
  console.log('natural run:', result);
} catch (e) {
  console.error('natural run FAIL:', e.stack);
  process.exit(3);
}

// Fallback test: chromosome with NO REPLICASE_START. Starter spawns a job;
// after ~src.length scan ticks the replicase should fall back to COPY phase
// starting at the landing position. We short-circuit the full timeout by
// directly driving replicaseTick repeatedly after enabling the job.
const fallbackScript = `
(function () {
  initWorld();
  const cell = 0;
  if (!world.alive[cell]) return 'no cell 0 alive';
  const chrom = new Uint8Array(30);
  for (let i = 0; i < 30; i++) {
    // Avoid REPLICASE_START (0x10-0x1F), REPLICASE_END (0x20-0x2F), jumps (0x90-0xAF).
    let b = (i * 13 + 7) & 0xFF;
    if ((b >= 0x10 && b <= 0x2F) || (b >= 0x90 && b <= 0xAF)) b = 0x30; // force to NOP range
    chrom[i] = b;
  }
  world.genomes[cell] = [chrom];
  assignLineage(chrom, [], 'test', 'cell');
  world.internalProteins[cell * 64 + 18] = 500000;   // abundant replicase
  world.internalProteins[cell * 64 + 22] = 1;        // one starter
  world.energy[cell] = 1e6;

  // Force the starter to fire this tick.
  const origRate = CONFIG.replicationStarterRate;
  CONFIG.replicationStarterRate = 1.0;
  replicationStarterTick(cell);
  CONFIG.replicationStarterRate = origRate;

  // Find the job we just created.
  let slot = -1;
  for (let s = 0; s < CONFIG.maxReplicaseJobs; s++) {
    if (world.replicase_job_alive[s] && world.replicase_job_cellIdx[s] === cell) { slot = s; break; }
  }
  if (slot < 0) return 'no job created';
  const landing = world.replicase_job_scanStart[slot];

  // Force every tick to fire by maxing protein advance chance.
  const origP = CONFIG.replicaseProteinAdvanceChance;
  CONFIG.replicaseProteinAdvanceChance = 1.0;
  // Run enough ticks to complete scan (one full loop) + some copy bytes.
  const scanBudget = chrom.length + 5;
  for (let i = 0; i < scanBudget; i++) replicaseTick();
  const phaseAfterScan = world.replicase_job_phase[slot];
  const progressAfterScan = world.replicase_job_progress[slot];
  const outputAfterScan = world.replicase_job_output[slot] ? world.replicase_job_output[slot].length : -1;
  CONFIG.replicaseProteinAdvanceChance = origP;

  return JSON.stringify({
    landingByte: landing,
    scanRemaining: world.replicase_job_scanRemaining[slot],
    phaseAfterScan,        // expect 1 (COPY) since scan exhausted
    progressAfterScan,     // near landing+5 (copy emitted ~5 bytes after fallback)
    outputAfterScan,       // > 0: copy phase emitted bytes from landing
  });
})();
`;
try {
  const result = vm.runInContext(fallbackScript, ctx, { filename: 'fallback' });
  console.log('fallback:', result);
} catch (e) {
  console.error('fallback FAIL:', e.stack);
  process.exit(4);
}

// Marker preservation: a source with NO markers anywhere should never produce
// a child with a REPLICASE_START or REPLICASE_END byte, even under heavy
// mutation pressure. We crank the error rate and run thousands of fail-emits
// (timeout path) and verify zero phantoms.
const markerScript = `
(function () {
  initWorld();
  const cell = 0;
  if (!world.alive[cell]) return 'no cell 0 alive';

  // Source with all bytes outside marker ranges (0x10-0x2F) AND outside
  // jump ranges (we don't care about jumps for this test, but excluding them
  // simplifies the assertion).
  const len = 80;
  const chrom = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    let b;
    do { b = world.rng.nextInt(256); }
    while ((b >= 0x10 && b <= 0x2F));
    chrom[i] = b;
  }
  world.genomes[cell] = [chrom];
  assignLineage(chrom, [], 'test', 'cell');
  world.internalProteins[cell * 64 + 18] = 50000000;
  world.energy[cell] = 1e9;

  // Crank error & mutation rates well above defaults to force phantom paths.
  const origErr = CONFIG.replicaseBaseErrorRate;
  const origMut = CONFIG.mutationRate;
  const origRate = CONFIG.replicationStarterRate;
  const origP = CONFIG.replicaseProteinAdvanceChance;
  const origTimeout = CONFIG.replicaseTimeout;
  CONFIG.replicaseBaseErrorRate = 0.5;        // half the bytes get rerolled
  CONFIG.mutationRate = 0.05;                 // 5% per-byte at finalize
  CONFIG.replicationStarterRate = 1.0;
  CONFIG.replicaseProteinAdvanceChance = 1.0;
  CONFIG.replicaseTimeout = 200;              // force fail-emit (timeout) path

  // Run many fail-emit cycles by injecting a starter each round.
  let phantomsObserved = 0;
  let childrenInspected = 0;
  for (let round = 0; round < 200; round++) {
    world.internalProteins[cell * 64 + 22] = 1;
    replicationStarterTick(cell);
    // Drive the job to completion or timeout — replicaseTimeout was lowered
    // so this finishes fast.
    for (let t = 0; t < CONFIG.replicaseTimeout + 50; t++) {
      replicaseTick();
      let anyAlive = false;
      for (let s = 0; s < CONFIG.maxReplicaseJobs; s++) {
        if (world.replicase_job_alive[s] && world.replicase_job_cellIdx[s] === cell) { anyAlive = true; break; }
      }
      if (!anyAlive) break;
    }

    const g = world.genomes[cell];
    if (g && g.length > 1) {
      // The newly-pushed child is the last entry.
      const child = g[g.length - 1];
      childrenInspected++;
      for (let i = 0; i < child.length; i++) {
        if (child[i] >= 0x10 && child[i] <= 0x2F) { phantomsObserved++; break; }
      }
      // Discard the child to keep the test deterministic-ish next round.
      g.length = 1;
    }
  }

  CONFIG.replicaseBaseErrorRate = origErr;
  CONFIG.mutationRate = origMut;
  CONFIG.replicationStarterRate = origRate;
  CONFIG.replicaseProteinAdvanceChance = origP;
  CONFIG.replicaseTimeout = origTimeout;

  return JSON.stringify({ childrenInspected, phantomsObserved });
})();
`;
try {
  const result = vm.runInContext(markerScript, ctx, { filename: 'marker' });
  console.log('marker preservation:', result);
} catch (e) {
  console.error('marker FAIL:', e.stack);
  process.exit(5);
}
