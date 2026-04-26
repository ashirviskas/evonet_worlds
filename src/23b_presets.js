// ============================================================
// SETTINGS PRESETS — save/load CONFIG tunables
// ============================================================
// Preset-able fields: all CONFIG keys currently bound to a slider or checkbox
// in the Settings panel. Keys missing at apply time are silently skipped, so
// old presets remain forward-compatible.
const PRESETABLE_KEYS = [
  'seed', 'initialCells', 'mutationRate', 'energyCap', 'metabolismCost',
  'membraneDecayPerTick', 'proteinDecayBase', 'freeProteinDecayRate', 'makeProteinCost',
  'lightSourceMoving', 'lightSourceSpeed',
  'degradationStartAge', 'degradationStartRate', 'degradationIncreasePerEra', 'degradationMaxRate',
  'membraneDivisionThreshold', 'replicaseTimeout', 'replicaseBaseErrorRate',
  'replicaseProteinAdvanceChance', 'replicaseEnergyAdvanceEnabled',
  'replicaseEnergyAdvanceChance', 'replicaseEnergyAdvanceCost',
  'expelRate', 'intakeRate', 'freeChromDegradeTicks', 'chromSpawnInterval',
  'chromSpawnEnabled', 'legacyDivisionEnabled',
];

const PRESETS_STORAGE_KEY = 'evoNetPresets';

function collectPreset() {
  const out = {};
  for (const k of PRESETABLE_KEYS) out[k] = CONFIG[k];
  return out;
}

function applyPreset(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of PRESETABLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) CONFIG[k] = obj[k];
  }
  // syncUiFromConfig re-runs inverse log-maps on every slider, so the UI and
  // the per-type decay-rate cache stay consistent with the freshly applied CONFIG.
  if (typeof syncUiFromConfig === 'function') syncUiFromConfig();
}

function _readPresetStore() {
  try {
    const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}

function _writePresetStore(obj) {
  localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(obj));
}

function listPresets() {
  const store = _readPresetStore();
  return Object.keys(store).sort();
}

function savePreset(name) {
  if (!name) return;
  const store = _readPresetStore();
  store[name] = { ...collectPreset(), savedAt: Date.now() };
  _writePresetStore(store);
}

function loadPreset(name) {
  const store = _readPresetStore();
  const entry = store[name];
  if (!entry) return;
  applyPreset(entry);
}

function deletePreset(name) {
  const store = _readPresetStore();
  delete store[name];
  _writePresetStore(store);
}

function refreshPresetDropdown() {
  const sel = document.getElementById('preset-select');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  const names = listPresets();
  if (names.length === 0) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '(no presets saved)';
    sel.appendChild(opt);
    return;
  }
  for (const n of names) {
    const opt = document.createElement('option');
    opt.value = n; opt.textContent = n;
    sel.appendChild(opt);
  }
  if (names.indexOf(prev) >= 0) sel.value = prev;
}
