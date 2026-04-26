// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// CONTROLS
// ============================================================
let running = true, ticksPerFrame = 10, renderEnabled = true;

document.getElementById('btn-play').addEventListener('click', () => { running = true; document.getElementById('btn-play').classList.add('active'); document.getElementById('btn-pause').classList.remove('active'); });
document.getElementById('btn-pause').addEventListener('click', () => { running = false; document.getElementById('btn-pause').classList.add('active'); document.getElementById('btn-play').classList.remove('active'); });
document.getElementById('btn-step').addEventListener('click', () => { running = false; document.getElementById('btn-pause').classList.add('active'); document.getElementById('btn-play').classList.remove('active'); tick(); render(); updateStats(); updateInspect(); updateMilestones(); });

// Keyboard shortcuts: space=play/pause, "."=step (ignored when typing in inputs/textareas)
window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (running) document.getElementById('btn-pause').click();
    else document.getElementById('btn-play').click();
  } else if (e.key === '.') {
    e.preventDefault();
    document.getElementById('btn-step').click();
  } else if (e.key === 'b' || e.key === 'B') {
    // Toggle debug bucket visualization: off → cells → free proteins → off.
    e.preventDefault();
    showBuckets = (showBuckets + 1) % 3;
    render();
  }
});

document.getElementById('speed').addEventListener('input', (e) => { ticksPerFrame = parseInt(e.target.value); document.getElementById('speed-val').textContent = ticksPerFrame; });
document.getElementById('initial-cells').addEventListener('input', (e) => { CONFIG.initialCells = parseInt(e.target.value); document.getElementById('initial-cells-val').textContent = CONFIG.initialCells; });
document.getElementById('render-toggle').addEventListener('change', (e) => { renderEnabled = e.target.checked; if (renderEnabled) render(); });
document.getElementById('mutation-rate').addEventListener('input', (e) => {
  // Log-mapped 0..1000 → 0.00001..0.1 (10000x range). Slider 250 ≈ 0.0001 baseline.
  CONFIG.mutationRate = 0.00001 * Math.pow(10000, parseInt(e.target.value) / 1000);
  document.getElementById('mutation-val').textContent = CONFIG.mutationRate.toFixed(5);
});
document.getElementById('energy-cap').addEventListener('input', (e) => { CONFIG.energyCap = parseInt(e.target.value); document.getElementById('energy-cap-val').textContent = CONFIG.energyCap; });
document.getElementById('metab-cost').addEventListener('input', (e) => {
  // Log-mapped 0..1000 → 0.002..0.05 (25x range, each step = same % change).
  CONFIG.metabolismCost = 0.002 * Math.pow(25, parseInt(e.target.value) / 1000);
  document.getElementById('metab-cost-val').textContent = CONFIG.metabolismCost.toFixed(4);
});
document.getElementById('memb-decay').addEventListener('input', (e) => {
  // Log-mapped 0..1000 → 0.001..0.2 (200x range). Default slider 566 ≈ 0.02 (baseline).
  CONFIG.membraneDecayPerTick = 0.001 * Math.pow(200, parseInt(e.target.value) / 1000);
  document.getElementById('memb-decay-val').textContent = CONFIG.membraneDecayPerTick.toFixed(4);
});
document.getElementById('prot-decay-cell').addEventListener('input', (e) => {
  // Log-mapped 0..1000 → 0.00001..0.01 (1000x). world.decayRates is per-type cached at init,
  // so rescale the whole array by the ratio to keep the per-type variation.
  const newBase = 0.00001 * Math.pow(1000, parseInt(e.target.value) / 1000);
  const oldBase = CONFIG.proteinDecayBase;
  const ratio = newBase / oldBase;
  if (world.decayRates) { for (let i = 0; i < world.decayRates.length; i++) world.decayRates[i] *= ratio; }
  CONFIG.proteinDecayBase = newBase;
  document.getElementById('prot-decay-cell-val').textContent = newBase.toFixed(5);
});
document.getElementById('prot-decay-free').addEventListener('input', (e) => {
  // Log-mapped 0..1000 → 0.00001..0.01 (1000x). Default slider 434 ≈ 0.0002.
  CONFIG.freeProteinDecayRate = 0.00001 * Math.pow(1000, parseInt(e.target.value) / 1000);
  document.getElementById('prot-decay-free-val').textContent = CONFIG.freeProteinDecayRate.toFixed(5);
});
document.getElementById('prot-make-cost').addEventListener('input', (e) => {
  // Log-mapped 0..1000 → 0.1..10 (100x). Default slider 500 ≈ 1.0.
  CONFIG.makeProteinCost = 0.1 * Math.pow(100, parseInt(e.target.value) / 1000);
  document.getElementById('prot-make-cost-val').textContent = CONFIG.makeProteinCost.toFixed(2);
});
document.getElementById('light-moving').addEventListener('change', (e) => { CONFIG.lightSourceMoving = e.target.checked; });
document.getElementById('light-speed').addEventListener('input', (e) => {
  // Slider 0–200 maps to 0–0.0002 rad/tick (default 20 → 0.00002, matches config baseline).
  CONFIG.lightSourceSpeed = parseInt(e.target.value) / 1000000;
  document.getElementById('light-speed-val').textContent = CONFIG.lightSourceSpeed.toFixed(6);
});
document.getElementById('deg-start-age').addEventListener('input', (e) => { CONFIG.degradationStartAge = parseInt(e.target.value); document.getElementById('deg-start-age-val').textContent = (CONFIG.degradationStartAge / 1000) + 'k'; });
document.getElementById('deg-start-rate').addEventListener('input', (e) => { CONFIG.degradationStartRate = parseInt(e.target.value) / 1000000; document.getElementById('deg-start-rate-val').textContent = CONFIG.degradationStartRate.toFixed(4); });
document.getElementById('deg-increase').addEventListener('input', (e) => { CONFIG.degradationIncreasePerEra = parseInt(e.target.value) / 100; document.getElementById('deg-increase-val').textContent = (CONFIG.degradationIncreasePerEra * 100).toFixed(0) + '%'; });
document.getElementById('deg-max').addEventListener('input', (e) => { CONFIG.degradationMaxRate = parseInt(e.target.value) / 1000; document.getElementById('deg-max-val').textContent = CONFIG.degradationMaxRate.toFixed(3); });

// Replication & transport sliders
document.getElementById('t2-memb-thresh').addEventListener('input', (e) => { CONFIG.membraneDivisionThreshold = parseInt(e.target.value); document.getElementById('t2-memb-thresh-val').textContent = CONFIG.membraneDivisionThreshold; });
function fmtRepTimeout(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return n.toString();
}
document.getElementById('t2-rep-timeout').addEventListener('input', (e) => {
  // Log-mapped 0..1000 → 2000..2,000,000 (1000x range)
  CONFIG.replicaseTimeout = Math.round(2000 * Math.pow(1000, parseInt(e.target.value) / 1000));
  document.getElementById('t2-rep-timeout-val').textContent = fmtRepTimeout(CONFIG.replicaseTimeout);
});
document.getElementById('t2-rep-error').addEventListener('input', (e) => {
  // Log-mapped 0..1000 → 0.00001..0.1 (10000x range). Slider 500 ≈ 0.001 baseline.
  CONFIG.replicaseBaseErrorRate = 0.00001 * Math.pow(10000, parseInt(e.target.value) / 1000);
  document.getElementById('t2-rep-error-val').textContent = CONFIG.replicaseBaseErrorRate.toFixed(5);
});
document.getElementById('t2-rep-energy-on').addEventListener('change', (e) => { CONFIG.replicaseEnergyAdvanceEnabled = e.target.checked; });
document.getElementById('t2-rep-energy-chance').addEventListener('input', (e) => {
  // Log-mapped 0..1000 → 0.000001..0.01 (10000x range). Slider 500 ≈ 0.0001 (1/10000) baseline.
  CONFIG.replicaseEnergyAdvanceChance = 0.000001 * Math.pow(10000, parseInt(e.target.value) / 1000);
  document.getElementById('t2-rep-energy-chance-val').textContent = CONFIG.replicaseEnergyAdvanceChance.toFixed(5);
});
document.getElementById('t2-expel').addEventListener('input', (e) => { CONFIG.expelRate = parseInt(e.target.value) / 1000; document.getElementById('t2-expel-val').textContent = CONFIG.expelRate.toFixed(3); });
document.getElementById('t2-intake').addEventListener('input', (e) => { CONFIG.intakeRate = parseInt(e.target.value) / 1000; document.getElementById('t2-intake-val').textContent = CONFIG.intakeRate.toFixed(3); });
document.getElementById('t2-chrom-deg').addEventListener('input', (e) => { CONFIG.freeChromDegradeTicks = parseInt(e.target.value); document.getElementById('t2-chrom-deg-val').textContent = CONFIG.freeChromDegradeTicks; });
document.getElementById('t2-chrom-spawn').addEventListener('input', (e) => { CONFIG.chromSpawnInterval = parseInt(e.target.value); document.getElementById('t2-chrom-spawn-val').textContent = CONFIG.chromSpawnInterval; });
document.getElementById('t2-chrom-spawn-on').addEventListener('change', (e) => { CONFIG.chromSpawnEnabled = e.target.checked; });
document.getElementById('t2-legacy-div').addEventListener('change', (e) => { CONFIG.legacyDivisionEnabled = e.target.checked; });

document.getElementById('btn-copy-genome').addEventListener('click', () => {
  if (selectedCell < 0 || !world.alive[selectedCell]) return;
  const genome = world.genomes[selectedCell]; if (!genome) return;
  const hex = genome.map((ch, ci) => `# Chromosome ${ci} (len=${ch.length}, shape=${chromosomeShape(ch)})\n` + Array.from(ch).map(b => b.toString(16).padStart(2, '0')).join(' ')).join('\n\n');
  navigator.clipboard.writeText(hex).then(() => { document.getElementById('btn-copy-genome').textContent = 'Copied!'; setTimeout(() => { document.getElementById('btn-copy-genome').textContent = 'Copy Genome'; }, 1000); });
});
document.getElementById('btn-divide').addEventListener('click', () => { if (selectedCell < 0 || !world.alive[selectedCell]) return; divideCell(selectedCell); render(); updateStats(); updateInspect(); });
document.getElementById('btn-kill').addEventListener('click', () => {
  if (selectedCell < 0 || !world.alive[selectedCell]) return;
  const i = selectedCell;
  killCell(i);
  closeInspectPopup('cell', i);
  render(); updateStats(); updateInspect();
});
document.getElementById('btn-kill-highlighted').addEventListener('click', () => {
  const hl = lineageHighlight && lineageHighlight.ids;
  if (!hl || hl.size === 0) return;
  let killed = 0;
  for (let i = 0; i < world.maxCells; i++) {
    if (!world.alive[i]) continue;
    const g = world.genomes[i];
    if (!g) continue;
    let match = false;
    for (let c = 0; c < g.length; c++) {
      const lid = getLineageId(g[c]);
      if (lid > 0 && hl.has(lid)) { match = true; break; }
    }
    if (match) { killCell(i); killed++; }
  }
  if (killed > 0) {
    if (selectedCell >= 0 && !world.alive[selectedCell]) selectedCell = -1;
    render(); updateStats(); updateInspect();
  }
});

document.getElementById('btn-restart').addEventListener('click', () => {
  CONFIG.seed = parseInt(document.getElementById('seed-input').value) || 42;
  world.rng = makeRNG(CONFIG.seed); world.tick = 0; world.numCells = 0;
  closeAllInspectPopups();
  lineageReset();
  for (let i = 0; i < world.maxCells; i++) { world.alive[i] = 0; world.genomes[i] = null; world.cellGridIdx[i] = -1; }
  for (let i = 0; i < world.grid.length; i++) world.grid[i].length = 0;
  world.subslotType.fill(255); world.subslotCount.fill(0); world.slotOpen.fill(1); world.internalProteins.fill(0);
  world.cytoOccMask.fill(0); world.subslotOccMask.fill(0);
  world.decayNextCyto.fill(0); world.decayNextSub.fill(0);
  world.replicase_job_alive.fill(0);
  world.replicase_job_progress.fill(0);
  world.replicase_job_ticksLeft.fill(0);
  for (let s = 0; s < CONFIG.maxReplicaseJobs; s++) { world.replicase_job_output[s] = null; world.replicase_job_sourceBytes[s] = null; world.replicase_job_sourceRef[s] = null; }
  world.replicase_activeCount.fill(0);
  world.replicase_nextSlot = 0;
  world.membraneDividing.fill(0);
  for (let i = 0; i < 64 * 64; i++) { world.interactionLeft[i] = world.rng.nextRange(-1, 1); world.interactionRight[i] = world.rng.nextRange(-1, 1); }
  for (let i = 0; i < 64; i++) world.decayRates[i] = CONFIG.proteinDecayBase * (0.1 + world.rng.next() * world.rng.next() * 10);
  const fw2 = world.energyFieldW, fh2 = world.energyFieldH;
  for (let y = 0; y < fh2; y++) for (let x = 0; x < fw2; x++) { const b = 1.0 - (y / fh2) * 0.7; world.energyField[y * fw2 + x] = b * (0.5 + world.rng.next() * 0.5); }
  world.photon_alive.fill(0); world.photon_age.fill(0); world.photonCount = 0;
  world.photonLiveCount = 0;
  for (let i = 0; i < CONFIG.maxPhotons; i++) { world.photonLive[i] = i; world.photonLiveIdx[i] = i; }
  world.lightSourceAngle = 0;
  // Reset free proteins & chromosomes
  world.freeP_alive.fill(0); world.freePCount = 0; world.freePLiveCount = 0;
  for (let i = 0; i < CONFIG.maxFreeProteins; i++) { world.freePLive[i] = i; world.freePLiveIdx[i] = i; }
  world.freeChromosomes = [];
  for (let i = 0; i < world.freePGrid.length; i++) world.freePGrid[i].length = 0;
  world.freePGridIdx.fill(-1);
  world.milestones = { cellReached500: 0, cellMakingDivider: 0, divisionsTotal: 0, threeGenLineage: 0, cellSurvived10k: 0, maxPopulation: 0, cellMoved: 0, photonsAbsorbed: 0,
    freePSpawned: 0, freeChromSpawned: 0, replicaseCompleted: 0, replicaseFailed: 0, membraneDivisions: 0, chromAbsorptions: 0, chromEjections: 0 };
  for (let i = 0; i < CONFIG.initialCells; i++) spawnCell(world.rng.nextRange(50, CONFIG.worldWidth - 50), world.rng.nextRange(50, CONFIG.worldHeight - 50), -1, 0);
  render(); updateStats(); updateInspect(); updateMilestones();
});

// --- Save / Load world ---
document.getElementById('btn-save-world').addEventListener('click', () => {
  try { downloadWorld(); }
  catch (err) { console.error(err); alert('Save failed: ' + err.message); }
});
document.getElementById('btn-load-world').addEventListener('click', () => {
  document.getElementById('file-load-world').click();
});
document.getElementById('file-load-world').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try { await loadWorldFromFile(f); }
  catch (err) { console.error(err); alert('Load failed: ' + err.message); }
  e.target.value = '';
});

// --- Settings presets ---
document.getElementById('preset-save').addEventListener('click', () => {
  const name = (prompt('Preset name:') || '').trim();
  if (!name) return;
  savePreset(name);
  refreshPresetDropdown();
  document.getElementById('preset-select').value = name;
});
document.getElementById('preset-load').addEventListener('click', () => {
  const name = document.getElementById('preset-select').value;
  if (!name) return;
  loadPreset(name);
});
document.getElementById('preset-delete').addEventListener('click', () => {
  const name = document.getElementById('preset-select').value;
  if (!name) return;
  if (!confirm(`Delete preset "${name}"?`)) return;
  deletePreset(name);
  refreshPresetDropdown();
});
document.getElementById('preset-copy-json').addEventListener('click', () => {
  const btn = document.getElementById('preset-copy-json');
  const text = JSON.stringify(collectPreset(), null, 2);
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1000);
  });
});
document.getElementById('preset-paste-json').addEventListener('click', () => {
  const text = prompt('Paste preset JSON:');
  if (!text) return;
  try {
    const obj = JSON.parse(text);
    applyPreset(obj);
  } catch (e) {
    alert('Invalid preset JSON: ' + e.message);
  }
});
