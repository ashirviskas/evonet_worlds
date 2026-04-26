// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
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

// Built-in presets shipped with the app. Add new entries here as plain JSON —
// they appear in the dropdown automatically alongside user-saved presets.
// Built-ins are read-only: load works, delete and save-over are blocked so
// the canonical values can't be lost. Unknown keys are ignored on apply, so
// these objects can stay forward-compatible as CONFIG grows.
//
// DEFAULT_PRESET_NAME is auto-loaded onto CONFIG at module load (before
// initWorld), and is the dropdown's default selection. Set to null to skip.
const DEFAULT_PRESET_NAME = 'DEFAULT_PRESET';

const BUILTIN_PRESETS = {
  DEFAULT_PRESET: {
    seed: 42,
    initialCells: 145,
    mutationRate: 0.0001,
    energyCap: 500,
    metabolismCost: 0.013274516778277816,
    membraneDecayPerTick: 0.014368720197006307,
    proteinDecayBase: 0.00004120975190973302,
    freeProteinDecayRate: 0.0002,
    makeProteinCost: 0.946237161365793,
    lightSourceMoving: true,
    lightSourceSpeed: 0.000079,
    degradationStartAge: 700000,
    degradationStartRate: 0.000001,
    degradationIncreasePerEra: 0.3,
    degradationMaxRate: 0.01,
    membraneDivisionThreshold: 7,
    replicaseTimeout: 228576,
    replicaseBaseErrorRate: 0.023768402866248765,
    replicaseProteinAdvanceChance: 1,
    replicaseEnergyAdvanceEnabled: true,
    replicaseEnergyAdvanceChance: 0.0001,
    replicaseEnergyAdvanceCost: 10,
    expelRate: 0.02,
    intakeRate: 0.02,
    freeChromDegradeTicks: 2000,
    chromSpawnInterval: 50000,
    chromSpawnEnabled: false,
    legacyDivisionEnabled: false,
  },
};

const PRESETS_STORAGE_KEY = 'evoNetPresets';

function isBuiltinPreset(name) {
  return Object.prototype.hasOwnProperty.call(BUILTIN_PRESETS, name);
}

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

function listBuiltinPresets() {
  return Object.keys(BUILTIN_PRESETS).sort();
}

function listUserPresets() {
  return Object.keys(_readPresetStore()).sort();
}

function listPresets() {
  // Builtins first, user-saved second; user names that shadow builtins are kept
  // in both lists so the dropdown can render them under their respective groups.
  return [...listBuiltinPresets(), ...listUserPresets()];
}

function savePreset(name) {
  if (!name) return;
  if (isBuiltinPreset(name)) {
    alert(`"${name}" is a built-in preset and can't be overwritten. Pick a different name.`);
    return;
  }
  const store = _readPresetStore();
  store[name] = { ...collectPreset(), savedAt: Date.now() };
  _writePresetStore(store);
}

function loadPreset(name) {
  // Built-ins win over user-saved with the same name, so the canonical defaults
  // remain reachable even if a user accidentally created a same-named entry
  // before the builtin existed.
  if (isBuiltinPreset(name)) {
    applyPreset(BUILTIN_PRESETS[name]);
    return;
  }
  const store = _readPresetStore();
  const entry = store[name];
  if (!entry) return;
  applyPreset(entry);
}

function deletePreset(name) {
  if (isBuiltinPreset(name)) {
    alert(`"${name}" is a built-in preset and can't be deleted.`);
    return;
  }
  const store = _readPresetStore();
  delete store[name];
  _writePresetStore(store);
}

function refreshPresetDropdown() {
  const sel = document.getElementById('preset-select');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';

  const builtins = listBuiltinPresets();
  const user = listUserPresets();

  if (builtins.length === 0 && user.length === 0) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '(no presets saved)';
    sel.appendChild(opt);
    return;
  }

  if (builtins.length > 0) {
    const grp = document.createElement('optgroup');
    grp.label = 'Built-in';
    for (const n of builtins) {
      const opt = document.createElement('option');
      opt.value = n; opt.textContent = n;
      grp.appendChild(opt);
    }
    sel.appendChild(grp);
  }

  if (user.length > 0) {
    const grp = document.createElement('optgroup');
    grp.label = 'Saved';
    for (const n of user) {
      const opt = document.createElement('option');
      opt.value = n; opt.textContent = n;
      grp.appendChild(opt);
    }
    sel.appendChild(grp);
  }

  // Restore previous selection if it still exists; otherwise prefer the
  // configured default builtin, then fall back to the first available.
  const all = [...builtins, ...user];
  if (all.indexOf(prev) >= 0) sel.value = prev;
  else if (DEFAULT_PRESET_NAME && all.indexOf(DEFAULT_PRESET_NAME) >= 0) sel.value = DEFAULT_PRESET_NAME;
  else sel.value = all[0];
}

// Auto-load the configured default preset onto CONFIG at module load. Runs
// before initWorld() (24_main_loop.js) so the world is built with the preset's
// values. applyPreset's syncUiFromConfig hop is guarded by a typeof check, so
// it's safely a no-op while the UI helper hasn't been defined yet.
function autoLoadDefaultPreset() {
  if (!DEFAULT_PRESET_NAME) return;
  const def = BUILTIN_PRESETS[DEFAULT_PRESET_NAME];
  if (def) applyPreset(def);
}
autoLoadDefaultPreset();
