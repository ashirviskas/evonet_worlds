// ============================================================
// MAIN LOOP
// ============================================================
initWorld(); resizeCanvas(); resizeLineageCanvas();
window.addEventListener('resize', () => { resizeCanvas(); resizeLineageCanvas(); });

// Resizable splitters for the left lineage panel and the right inspector panel.
(function wirePanelSplitters() {
  for (const r of document.querySelectorAll('.resizer')) {
    const targetId = r.dataset.target;
    const dir = r.dataset.dir; // 'right' = splitter on the right side of target (grow when dragged right)
    const target = document.getElementById(targetId);
    if (!target) continue;
    let startX = 0, startW = 0, dragging = false;
    r.addEventListener('mousedown', (e) => {
      dragging = true;
      r.classList.add('active');
      startX = e.clientX;
      startW = target.getBoundingClientRect().width;
      document.body.style.cursor = 'col-resize';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const signed = dir === 'right' ? dx : -dx;
      const w = Math.max(120, Math.min(window.innerWidth - 240, startW + signed));
      target.style.width = w + 'px';
      target.style.flexShrink = '0';
      resizeCanvas();
      resizeLineageCanvas();
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      r.classList.remove('active');
      document.body.style.cursor = '';
    });
  }
  // Shift legend when panel widths change.
  const legend = document.getElementById('protein-legend');
  const lp = document.getElementById('lineage-panel');
  const rp = document.getElementById('panel');
  function syncLegend() {
    if (!legend) return;
    legend.style.left = (lp ? lp.getBoundingClientRect().width + 4 : 0) + 'px';
    legend.style.right = (rp ? rp.getBoundingClientRect().width + 4 : 0) + 'px';
  }
  syncLegend();
  window.addEventListener('resize', syncLegend);
  const ro = new ResizeObserver(syncLegend);
  if (lp) ro.observe(lp);
  if (rp) ro.observe(rp);
})();
camera.x = CONFIG.worldWidth / 2; camera.y = CONFIG.worldHeight / 2;
buildProteinLegend();

// Sync UI controls to CONFIG values at startup (HTML slider defaults may be
// stale relative to the code's CONFIG object).
function syncUiFromConfig() {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  // Inverse of log map: slider = 1000 * log(value/min) / log(max/min); 0.00001..0.1 range.
  set('mutation-rate', Math.round(1000 * Math.log(Math.max(CONFIG.mutationRate, 1e-5) / 1e-5) / Math.log(1e4)));
  setText('mutation-val', CONFIG.mutationRate.toFixed(5));
  set('energy-cap', CONFIG.energyCap);
  setText('energy-cap-val', CONFIG.energyCap);
  set('deg-start-age', CONFIG.degradationStartAge);
  setText('deg-start-age-val', (CONFIG.degradationStartAge / 1000) + 'k');
  set('deg-start-rate', Math.round(CONFIG.degradationStartRate * 1000000));
  setText('deg-start-rate-val', CONFIG.degradationStartRate.toFixed(6));
  set('deg-increase', Math.round(CONFIG.degradationIncreasePerEra * 100));
  setText('deg-increase-val', (CONFIG.degradationIncreasePerEra * 100).toFixed(0) + '%');
  set('deg-max', Math.round(CONFIG.degradationMaxRate * 1000));
  setText('deg-max-val', CONFIG.degradationMaxRate.toFixed(3));
  set('t2-memb-thresh', CONFIG.membraneDivisionThreshold);
  setText('t2-memb-thresh-val', CONFIG.membraneDivisionThreshold);
  set('t2-rep-timeout', Math.round(1000 * Math.log(Math.max(CONFIG.replicaseTimeout, 2000) / 2000) / Math.log(1000)));
  setText('t2-rep-timeout-val', fmtRepTimeout(CONFIG.replicaseTimeout));
  set('t2-rep-error', Math.round(1000 * Math.log(Math.max(CONFIG.replicaseBaseErrorRate, 1e-5) / 1e-5) / Math.log(1e4)));
  setText('t2-rep-error-val', CONFIG.replicaseBaseErrorRate.toFixed(5));
  const repEnergyOn = document.getElementById('t2-rep-energy-on');
  if (repEnergyOn) repEnergyOn.checked = !!CONFIG.replicaseEnergyAdvanceEnabled;
  set('t2-rep-energy-chance', Math.round(1000 * Math.log(Math.max(CONFIG.replicaseEnergyAdvanceChance, 1e-6) / 1e-6) / Math.log(1e4)));
  setText('t2-rep-energy-chance-val', CONFIG.replicaseEnergyAdvanceChance.toFixed(5));
  set('t2-expel', Math.round(CONFIG.expelRate * 1000));
  setText('t2-expel-val', CONFIG.expelRate.toFixed(3));
  set('t2-intake', Math.round(CONFIG.intakeRate * 1000));
  setText('t2-intake-val', CONFIG.intakeRate.toFixed(3));
  set('t2-chrom-deg', CONFIG.freeChromDegradeTicks);
  setText('t2-chrom-deg-val', CONFIG.freeChromDegradeTicks);
  set('t2-chrom-spawn', CONFIG.chromSpawnInterval);
  setText('t2-chrom-spawn-val', CONFIG.chromSpawnInterval);
  const legacy = document.getElementById('t2-legacy-div'); if (legacy) legacy.checked = !!CONFIG.legacyDivisionEnabled;
  const spawnOn = document.getElementById('t2-chrom-spawn-on'); if (spawnOn) spawnOn.checked = !!CONFIG.chromSpawnEnabled;
  // Protein sliders (log-mapped)
  set('prot-decay-cell', Math.round(1000 * Math.log(Math.max(CONFIG.proteinDecayBase, 1e-5) / 1e-5) / Math.log(1e3)));
  setText('prot-decay-cell-val', CONFIG.proteinDecayBase.toFixed(5));
  set('prot-decay-free', Math.round(1000 * Math.log(Math.max(CONFIG.freeProteinDecayRate, 1e-5) / 1e-5) / Math.log(1e3)));
  setText('prot-decay-free-val', CONFIG.freeProteinDecayRate.toFixed(5));
  set('prot-make-cost', Math.round(1000 * Math.log(Math.max(CONFIG.makeProteinCost, 0.1) / 0.1) / Math.log(100)));
  setText('prot-make-cost-val', CONFIG.makeProteinCost.toFixed(2));
  set('speed', ticksPerFrame);
  setText('speed-val', ticksPerFrame);
  set('seed-input', CONFIG.seed);
  set('initial-cells', CONFIG.initialCells);
  setText('initial-cells-val', CONFIG.initialCells);
}
syncUiFromConfig();
refreshPresetDropdown();

let frameCounter = 0;
let tpsTicks = 0;
let tpsWindowStart = performance.now();
let currentTps = 0;
function mainLoop() {
  try {
    if (running) {
      for (let i = 0; i < ticksPerFrame; i++) tick();
      tpsTicks += ticksPerFrame;
    }
    const nowT = performance.now();
    const dt = nowT - tpsWindowStart;
    if (dt >= 500) {
      currentTps = (tpsTicks * 1000) / dt;
      tpsTicks = 0;
      tpsWindowStart = nowT;
    }
    if (renderEnabled) render();
    updateStats(); updateInspect();
    if (++frameCounter % 10 === 0) updateMilestones();
  } catch (e) {
    console.error('mainLoop error at tick', world && world.tick, e);
    running = false;
  }
  requestAnimationFrame(mainLoop);
}
mainLoop();
