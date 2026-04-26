// Diagnostic: source has NO markers — does any successful child appear?
// If markers are being injected, we'd see successful completions with bytes
// in 0x10-0x1F or 0x20-0x2F. If the protocol is honest, the only way to
// "succeed" is to find both markers in the source — so no markers in source
// means no successful completions, only timeouts emitting partials.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_DIR = path.join(__dirname, '..', 'src');
const files = fs.readdirSync(SRC_DIR).filter(f => f.endsWith('.js') && f !== '24_main_loop.js').sort();

const noop = () => {};
const stubEl = new Proxy({ style: {}, getContext: () => new Proxy({}, { get: () => noop }), addEventListener: noop, getBoundingClientRect: () => ({ left:0, top:0, width:800, height:600, right:800, bottom:600 }) }, { get(t, k) { if (k in t) return t[k]; return noop; } });
const docStub = new Proxy({ getElementById: () => stubEl, querySelector: () => stubEl, querySelectorAll: () => [], createElement: () => stubEl, addEventListener: noop, body: stubEl, documentElement: stubEl, head: stubEl }, { get(t, k) { if (k in t) return t[k]; return stubEl; } });
const winStub = new Proxy({ document: docStub, addEventListener: noop, innerWidth: 1280, innerHeight: 720, requestAnimationFrame: noop, setTimeout: () => 0, performance: { now: () => Date.now() }, navigator: {} }, { get(t, k) { if (k in t) return t[k]; return undefined; } });

const ctx = vm.createContext({
  document: docStub, window: winStub, navigator: winStub.navigator,
  setTimeout: () => 0, setInterval: () => 0, requestAnimationFrame: noop,
  console, performance: winStub.performance, alert: noop, localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  Uint8Array, Uint16Array, Uint32Array, Int8Array, Int32Array, Float32Array, Float64Array,
  Math, Date, JSON, Object, Array, Map, Set, WeakMap, WeakSet, Promise, Error, Symbol,
  Number, String, Boolean, RegExp, Proxy, Reflect, Buffer,
});

for (const f of files) {
  vm.runInContext(fs.readFileSync(path.join(SRC_DIR, f), 'utf8'), ctx, { filename: f });
}
vm.runInContext('initWorld();', ctx);

const script = `
(function() {
  initWorld();
  const cell = 0;
  // Source with NO markers (avoid 0x10-0x2F entirely).
  const len = 60;
  const chrom = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    let b; do { b = world.rng.nextInt(256); } while (b >= 0x10 && b <= 0x2F);
    chrom[i] = b;
  }
  world.genomes[cell] = [chrom];
  assignLineage(chrom, [], 'test', 'cell');
  world.internalProteins[cell * 64 + 18] = 100000;
  world.internalProteins[cell * 64 + 22] = 1;
  world.energy[cell] = 1e8;

  CONFIG.replicationStarterRate = 1.0;
  CONFIG.replicaseProteinAdvanceChance = 1.0;
  CONFIG.replicaseTimeout = 500;

  let completedCount = 0;
  let failedCount = 0;
  const completedFirstBytes = [];
  const completedLastBytes = [];
  const failedFirstBytes = [];

  for (let round = 0; round < 50; round++) {
    world.internalProteins[cell * 64 + 22] = 1;
    const cBefore = world.milestones.replicaseCompleted;
    const fBefore = world.milestones.replicaseFailed;
    replicationStarterTick(cell);
    for (let t = 0; t < 1000; t++) {
      replicaseTick();
      let alive = false;
      for (let s = 0; s < CONFIG.maxReplicaseJobs; s++) {
        if (world.replicase_job_alive[s] && world.replicase_job_cellIdx[s] === cell) { alive = true; break; }
      }
      if (!alive) break;
    }
    const newCompleted = world.milestones.replicaseCompleted - cBefore;
    const newFailed = world.milestones.replicaseFailed - fBefore;
    completedCount += newCompleted;
    failedCount += newFailed;
    const g = world.genomes[cell];
    if (g.length > 1) {
      const child = g[g.length - 1];
      if (child && child.length > 0) {
        if (newCompleted > 0) {
          completedFirstBytes.push(child[0].toString(16));
          completedLastBytes.push(child[child.length-1].toString(16));
        } else {
          failedFirstBytes.push(child[0].toString(16));
        }
      }
      g.length = 1;
    }
  }

  return JSON.stringify({
    completedCount, failedCount,
    completedFirstBytes: completedFirstBytes.slice(0, 10),
    completedLastBytes: completedLastBytes.slice(0, 10),
    failedFirstBytes: failedFirstBytes.slice(0, 10),
  }, null, 2);
})();
`;
console.log(vm.runInContext(script, ctx, { filename: 'diag' }));
