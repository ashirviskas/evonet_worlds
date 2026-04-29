// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// PROTEIN INFO CATALOG
// ============================================================
const PROTEIN_INFO = [];
(function buildProteinInfo() {
  const named = [
    { name: 'Photon Catcher', desc: 'Harvests light energy from photon hits (1x membrane, 3x special)', cat: 'energy' },
    { name: 'Membrane Modifier', desc: 'Strengthens membrane slot it occupies', cat: 'structure' },
    { name: 'Attack Enzyme', desc: 'Deals damage to overlapping cells (1x membrane, 3x special)', cat: 'combat' },
    { name: 'Defense Coat', desc: 'Reduces incoming damage (1x membrane, 3x special)', cat: 'combat' },
    { name: 'Divider Trigger', desc: 'Only required to arm division when the cell also holds Division Starter Required (type 38); otherwise optional. All are consumed at division.', cat: 'reproduction' },
    { name: 'Push Motor', desc: 'Propels cell outward from special slot when activated by move signal', cat: 'movement' },
    { name: 'Pull Motor', desc: 'Pulls cell toward special slot direction when activated', cat: 'movement' },
    { name: 'Move Signal', desc: 'Consumed by motors to produce movement impulse', cat: 'movement' },
    { name: 'Sensor', desc: 'Degrades into move signals over time in special slots', cat: 'sensing' },
    { name: 'Adhesion', desc: 'Reduces repulsion with neighboring cells in membrane', cat: 'structure' },
    { name: 'Connection Maker', desc: 'Enables cell-cell links in special slot', cat: 'social' },
    { name: 'Signal Emitter', desc: 'Emits chemical signal from membrane', cat: 'communication' },
    { name: 'Signal Receptor', desc: 'Detects nearby chemical signals in membrane', cat: 'communication' },
    { name: 'Digestive Enzyme', desc: 'Damages adjacent cell from special slot (3x)', cat: 'combat' },
    { name: 'Protective Coat', desc: 'Resists digestion in membrane', cat: 'combat' },
    { name: 'Channel Protein', desc: 'Enables conjugation/transfer in special slot', cat: 'social' },
    { name: 'Expel Pump', desc: 'In special slot: expels cytoplasm proteins into medium', cat: 'transport' },
    { name: 'Intake Pump', desc: 'In special slot: absorbs nearby free proteins from medium', cat: 'transport' },
    { name: 'Replicase', desc: 'Consumed 1:1 per byte during chromosome duplication', cat: 'reproduction' },
    { name: 'Base Membrane', desc: 'Arms division once count ≥ membraneDivisionThreshold; threshold-worth is consumed at division to form the daughter membrane, the rest splits with cytoplasm.', cat: 'structure' },
    { name: 'Chromosome Ejector', desc: 'Pushes a random chromosome out of cell into medium', cat: 'transport' },
    { name: 'No-Chromies-Allowed', desc: 'Membrane protein: blocks chromosome absorption', cat: 'structure' },
    { name: 'Basic Replication Starter', desc: 'Binds any chromosome and initiates a Basic-mode duplication: copies start-to-end byte-by-byte, ignoring replicase opcodes (start/end markers and jumps are treated as data). Consumed on bind. Errors still apply.', cat: 'reproduction' },
    { name: 'Chromase', desc: 'Digests a byte from a random chromosome for energy; quenched 1:1 by Inhibitor', cat: 'metabolism' },
    { name: 'Chromase Inhibitor', desc: 'Neutralises intracellular Chromase 1:1 (no effect outside cells yet)', cat: 'metabolism' },
    { name: 'Advanced Replication Starter S0', desc: 'Advanced-mode duplication starter; only binds chromosomes of shape 0. Honours REPLICASE_START/END markers and JUMP opcodes.', cat: 'reproduction' },
    { name: 'Advanced Replication Starter S1', desc: 'Advanced-mode duplication starter; only binds chromosomes of shape 1. Honours REPLICASE_START/END markers and JUMP opcodes.', cat: 'reproduction' },
    { name: 'Advanced Replication Starter S2', desc: 'Advanced-mode duplication starter; only binds chromosomes of shape 2. Honours REPLICASE_START/END markers and JUMP opcodes.', cat: 'reproduction' },
    { name: 'Advanced Replication Starter S3', desc: 'Advanced-mode duplication starter; only binds chromosomes of shape 3. Honours REPLICASE_START/END markers and JUMP opcodes.', cat: 'reproduction' },
    { name: 'Advanced Replication Starter S4', desc: 'Advanced-mode duplication starter; only binds chromosomes of shape 4. Honours REPLICASE_START/END markers and JUMP opcodes.', cat: 'reproduction' },
    { name: 'Advanced Replication Starter S5', desc: 'Advanced-mode duplication starter; only binds chromosomes of shape 5. Honours REPLICASE_START/END markers and JUMP opcodes.', cat: 'reproduction' },
    { name: 'Advanced Replication Starter S6', desc: 'Advanced-mode duplication starter; only binds chromosomes of shape 6. Honours REPLICASE_START/END markers and JUMP opcodes.', cat: 'reproduction' },
    { name: 'Advanced Replication Starter S7', desc: 'Advanced-mode duplication starter; only binds chromosomes of shape 7. Honours REPLICASE_START/END markers and JUMP opcodes.', cat: 'reproduction' },
    { name: 'Advanced Replication Starter S8', desc: 'Advanced-mode duplication starter; only binds chromosomes of shape 8. Honours REPLICASE_START/END markers and JUMP opcodes.', cat: 'reproduction' },
    { name: 'Advanced Replication Starter S9', desc: 'Advanced-mode duplication starter; only binds chromosomes of shape 9. Honours REPLICASE_START/END markers and JUMP opcodes.', cat: 'reproduction' },
    { name: 'Energy Storage [Empty]', desc: 'Discharged battery. When cell energy hits cap, one empty charges to Storing (type 36) and the cell pays energyStorageBonus.', cat: 'energy' },
    { name: 'Energy Storage [Storing]', desc: 'Charged battery, holds energyStorageBonus energy. When cell energy drops 30 below cap, one Storing discharges back to Empty (type 35) and the cell gains energyStorageBonus. Costs +energyStorageBonus to synthesise.', cat: 'energy' },
    { name: 'Division Starter Required', desc: 'While in cytoplasm, re-imposes the Divider Trigger (type 4) requirement on division. Not consumed — a persistent trait.', cat: 'reproduction' },
    { name: 'Chromie Invitation', desc: 'Membrane protein (slot 0): required for a cell to absorb overlapping free chromosomes. Without it, the membrane blocks chromosome intake. Not consumed.', cat: 'structure' },
    { name: 'Photon Sensor', desc: 'Fires when a photon is in the slot’s sector (special) or in range (membrane). On fire, walks +1 subslot ring: motor → direct impulse, empty/Move Signal → deposit, else → cytoplasm Move Signal.', cat: 'sensing' },
    { name: 'Cell Sensor', desc: 'Fires when another living cell is in the slot’s sector (special) or in range (membrane). +1 subslot coupling.', cat: 'sensing' },
    { name: 'Free-Protein Sensor', desc: 'Fires when a free protein is in the slot’s sector (special) or in range (membrane). +1 subslot coupling.', cat: 'sensing' },
    { name: 'Advanced Replication Starter', desc: 'Binds any chromosome and initiates an Advanced-mode duplication: scans for REPLICASE_START, copies until REPLICASE_END, honours REPLICASE_JUMP_BYTE/CHROMOSOME. Consumed on bind. Errors apply.', cat: 'reproduction' },
    { name: 'Growth protein', desc: 'In cytoplasm: consumed at membraneRemodelRate per tick to grow the cell radius by radiusGrowthStep, up to maxRadius. Bigger cells pay quadratically more membrane upkeep.', cat: 'structure' },
    { name: 'Shrinkage protein', desc: 'In cytoplasm: consumed at membraneRemodelRate per tick to shrink the cell radius by radiusShrinkStep, down to minRadius. Smaller cells pay less membrane upkeep.', cat: 'structure' },
  ];
  for (let i = 0; i < 64; i++) {
    const hue = (i * 360 / 64 + 15) % 360;
    const sat = i < 16 ? 70 : 40;
    const lit = i < 16 ? 55 : 45;
    const color = `hsl(${hue}, ${sat}%, ${lit}%)`;
    if (i < named.length) {
      PROTEIN_INFO.push({ id: i, name: named[i].name, desc: named[i].desc, cat: named[i].cat, color });
    } else {
      PROTEIN_INFO.push({ id: i, name: `Protein ${i}`, desc: `Generic protein type ${i}`, cat: 'generic', color });
    }
  }
})();

// 16 classes × 16 bytes. 11 real instruction classes + 5 NOP classes.
// Byte ranges: [class_index * 16, class_index * 16 + 15].
// 2-byte opcodes (consume the following byte as an arg) live in 0x40..0xAF;
// everything else is 1-byte (executed or NOP'd in place).
const OPCODE_RANGES = [
  { max: 0x0F, name: 'Control',       color: '#888' }, // 0x02 = legacy DIVIDE; rest NOP
  { max: 0x1F, name: 'Repl. Start',   color: '#fa5' }, // replicase scan terminator
  { max: 0x2F, name: 'Repl. End',     color: '#f55' }, // replicase copy terminator
  { max: 0x3F, name: 'NOP',           color: '#555' },
  { max: 0x4F, name: 'Make Protein',  color: '#5b5' },
  { max: 0x5F, name: 'Slot Open',     color: '#58f' },
  { max: 0x6F, name: 'Slot Close',    color: '#36c' },
  { max: 0x7F, name: 'Search Jump',   color: '#c5c' },
  { max: 0x8F, name: 'Chrom. Jump',   color: '#c85' },
  { max: 0x9F, name: 'Repl. JmpByte', color: '#bc5' }, // replicase-only jump (ribosome NOP)
  { max: 0xAF, name: 'Repl. JmpChrom',color: '#a95' }, // replicase-only jump (ribosome NOP)
  { max: 0xBF, name: 'NOP',           color: '#555' },
  { max: 0xCF, name: 'NOP',           color: '#555' },
  { max: 0xDF, name: 'NOP',           color: '#555' },
  { max: 0xEF, name: 'NOP',           color: '#555' },
  { max: 0xFF, name: 'NOP',           color: '#555' },
];
function getOpcodeInfo(byte) {
  for (const r of OPCODE_RANGES) { if (byte <= r.max) return r; }
  return OPCODE_RANGES[OPCODE_RANGES.length - 1];
}

// 2-byte instructions: 0x40..0xAF. Everything else is 1-byte.
function opcodeIsTwoByte(op) { return op >= 0x40 && op <= 0xAF; }

// Decode a chromosome into human-readable pseudocode lines
function decodeChromosome(chrom) {
  const lines = [];
  let i = 0;
  while (i < chrom.length) {
    const op = chrom[i];
    const offStr = i.toString().padStart(3, ' ');
    const hex = op.toString(16).padStart(2, '0');
    const info = getOpcodeInfo(op);
    if (!opcodeIsTwoByte(op)) {
      let mnem = 'NOP';
      if (op <= 0x0F) {
        if (op === 0x02) mnem = 'DIVIDE (legacy)';
      } else if (op <= 0x1F) mnem = 'REPLICASE_START';
      else if (op <= 0x2F) mnem = 'REPLICASE_END';
      lines.push({ off: i, bytes: [op], text: `${offStr}: ${hex}       ${mnem}`, color: info.color });
      i++;
    } else {
      const arg = i + 1 < chrom.length ? chrom[i + 1] : 0;
      const argHex = arg.toString(16).padStart(2, '0');
      let mnem;
      if (op <= 0x4F) mnem = `MAKE_PROTEIN type=${arg % 64} (${PROTEIN_INFO[arg % 64].name})`;
      else if (op <= 0x5F) mnem = `SLOT_OPEN ${arg % 7}`;
      else if (op <= 0x6F) mnem = `SLOT_CLOSE ${arg % 7}`;
      else if (op <= 0x7F) mnem = `SEARCH_JUMP byte=0x${argHex}`;
      else if (op <= 0x8F) mnem = `CHROM_JUMP shape=${arg % 10}`;
      else if (op <= 0x9F) mnem = `REPLICASE_JUMP_BYTE byte=0x${argHex}`;
      else mnem = `REPLICASE_JUMP_CHROM shape=${arg % 10}`;
      lines.push({ off: i, bytes: [op, arg], text: `${offStr}: ${hex} ${argHex}    ${mnem}`, color: info.color });
      i += 2;
    }
  }
  return lines;
}

// Render full DNA hex (no cutoff) + decoded code
// riboOffset: if >= 0, highlights the byte at that offset (current ribosome position)
function renderDnaFull(chrom, label, riboOffset) {
  const hasRibo = typeof riboOffset === 'number' && riboOffset >= 0 && riboOffset < chrom.length;
  let h = '';
  if (label) h += `<div style="margin-top:6px;"><b>${label}</b> (len=${chrom.length}, shape=${chromosomeShape(chrom)}${hasRibo ? ` <span style="color:#ff0;">ribo@${riboOffset}</span>` : ''})</div>`;
  // Hex bytes
  h += `<div style="word-break:break-all; line-height:1.4; margin:4px 0; font-size:10px;">`;
  for (let b = 0; b < chrom.length; b++) {
    const byte = chrom[b], info = getOpcodeInfo(byte), hex = byte.toString(16).padStart(2, '0');
    const cur = hasRibo && b === riboOffset;
    const style = cur ? `background:#ff0;color:#000;font-weight:bold;padding:0 2px;border-radius:2px;` : `color:${info.color}`;
    h += `<span class="dna-byte" style="${style}" data-tip="<span class='tip-title'>0x${hex}</span>\n<span class='tip-desc'>${esc(info.name)}</span>">${hex}</span> `;
  }
  h += `</div>`;
  // Decoded
  const lines = decodeChromosome(chrom);
  h += `<div style="color:#8cf; font-size:10px; margin-top:4px;">Decoded (${lines.length} ops)</div>`;
  h += `<pre style="font-size:10px; line-height:1.3; margin:2px 0; white-space:pre-wrap; color:#bbb; background:#0a0a0a; padding:4px; border:1px solid #222; border-radius:3px;">`;
  for (const ln of lines) {
    const cur = hasRibo && riboOffset >= ln.off && riboOffset < ln.off + ln.bytes.length;
    if (cur) {
      h += `<span style="background:#ff0;color:#000;font-weight:bold;">► ${esc(ln.text)}</span>\n`;
    } else {
      h += `<span style="color:${ln.color}">  ${esc(ln.text)}</span>\n`;
    }
  }
  h += `</pre>`;
  return h;
}

// LCS-based alignment of two chromosomes at the decoded-instruction level.
// Byte-level alignment would happily match opcode bytes against argument bytes
// and produce nonsense; instructions own their 1-or-2-byte payload, so aligning
// on decoded lines keeps both the hex and decoded views coherent.
//
// Returns an ordered list of { kind, childLine, parentLine } where kind is one
// of 'same' | 'changed' | 'insert' | 'remove'. Adjacent insert+remove runs of
// equal length are re-paired into 'changed' so in-place mutations show as a
// single red line rather than orange-add-then-orange-remove.
//
// Returns null on chromosomes longer than ALIGN_CAP — the popup falls back to
// independent side-by-side rendering. Caps O(N·M) memory at ~16M cells max.
const ALIGN_CAP = 4096;
function alignChromosomes(childData, parentData) {
  const c = decodeChromosome(childData);
  const p = decodeChromosome(parentData);
  if (c.length > ALIGN_CAP || p.length > ALIGN_CAP) return null;
  const eqLine = (a, b) => {
    if (a.bytes.length !== b.bytes.length) return false;
    for (let k = 0; k < a.bytes.length; k++) if (a.bytes[k] !== b.bytes[k]) return false;
    return true;
  };
  const N = c.length, M = p.length;
  // dp[i][j] = LCS length of c[0..i) vs p[0..j).
  const dp = new Array(N + 1);
  for (let i = 0; i <= N; i++) dp[i] = new Uint32Array(M + 1);
  for (let i = 1; i <= N; i++) for (let j = 1; j <= M; j++) {
    dp[i][j] = eqLine(c[i - 1], p[j - 1])
      ? dp[i - 1][j - 1] + 1
      : (dp[i - 1][j] > dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1]);
  }
  // Backtrack into reverse order, then flip.
  const out = [];
  let i = N, j = M;
  while (i > 0 && j > 0) {
    if (eqLine(c[i - 1], p[j - 1])) {
      out.push({ kind: 'same', childLine: c[i - 1], parentLine: p[j - 1] });
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      out.push({ kind: 'insert', childLine: c[i - 1], parentLine: null });
      i--;
    } else {
      out.push({ kind: 'remove', childLine: null, parentLine: p[j - 1] });
      j--;
    }
  }
  while (i > 0) { out.push({ kind: 'insert', childLine: c[--i], parentLine: null }); i; }
  while (j > 0) { out.push({ kind: 'remove', childLine: null, parentLine: p[--j] }); j; }
  out.reverse();

  // Re-pair adjacent insert/remove runs of equal length into 'changed'. The
  // ordering of insert vs remove inside a run is arbitrary from LCS — group
  // them, then zip the two sub-runs into 'changed' entries when their lengths
  // match. Otherwise leave them as separate insert/remove rows.
  const result = [];
  let k = 0;
  while (k < out.length) {
    if (out[k].kind === 'same') { result.push(out[k++]); continue; }
    let runEnd = k;
    while (runEnd < out.length && out[runEnd].kind !== 'same') runEnd++;
    const inserts = [], removes = [];
    for (let q = k; q < runEnd; q++) {
      if (out[q].kind === 'insert') inserts.push(out[q].childLine);
      else removes.push(out[q].parentLine);
    }
    const pairs = Math.min(inserts.length, removes.length);
    for (let q = 0; q < pairs; q++) {
      result.push({ kind: 'changed', childLine: inserts[q], parentLine: removes[q] });
    }
    for (let q = pairs; q < inserts.length; q++) result.push({ kind: 'insert', childLine: inserts[q], parentLine: null });
    for (let q = pairs; q < removes.length; q++) result.push({ kind: 'remove', childLine: null, parentLine: removes[q] });
    k = runEnd;
  }
  return result;
}

// Render a single chromosome panel (hex bytes + decoded pseudocode) with diff
// coloring derived from an LCS alignment. Used in `show diff` mode for the
// child-side and parent-side panels of the inspector. role ∈ {'child','parent'}
// selects which alignment side to project onto this chromosome's instructions.
//
// Hex byte coloring:
//   same op                         → existing opcode color
//   changed op, byte matches paired → existing opcode color (only the
//                                     differing byte stands out)
//   changed op, byte differs        → red    (#f66)
//   insert / remove                 → orange (#fa0)
//
// Decoded text lines keep whole-line coloring (changed → red, ins/rem → orange)
// since a `changed` op semantically replaces the whole instruction.
function renderDnaFullDiff(chrom, label, alignment, role) {
  // offset → { kind, pairedBytes | null }. pairedBytes is the *other* side's
  // bytes for this aligned pair; null for unpaired insert/remove or when the
  // paired line happens to be missing.
  const lineInfo = new Map();
  for (const e of alignment) {
    const ln = role === 'child' ? e.childLine : e.parentLine;
    if (!ln) continue;
    const paired = role === 'child' ? e.parentLine : e.childLine;
    lineInfo.set(ln.off, { kind: e.kind, pairedBytes: paired ? paired.bytes : null });
  }

  const lines = decodeChromosome(chrom);
  // Per-byte color: walk instructions and decide each byte individually so a
  // changed op like `45 c8` ↔ `45 45` only paints the second byte red.
  const byteColor = new Array(chrom.length);
  for (const ln of lines) {
    const li = lineInfo.get(ln.off) || { kind: 'same', pairedBytes: null };
    for (let q = 0; q < ln.bytes.length; q++) {
      const byte = ln.bytes[q];
      const info = getOpcodeInfo(byte);
      if (li.kind === 'insert' || li.kind === 'remove') {
        byteColor[ln.off + q] = '#fa0';
      } else if (li.kind === 'changed' && li.pairedBytes) {
        const pb = q < li.pairedBytes.length ? li.pairedBytes[q] : null;
        byteColor[ln.off + q] = pb === byte ? info.color : '#f66';
      } else {
        byteColor[ln.off + q] = info.color;
      }
    }
  }

  const lineColorForKind = (k, fallback) => {
    if (k === 'changed') return '#f66';
    if (k === 'insert' || k === 'remove') return '#fa0';
    return fallback;
  };

  let h = '';
  if (label) h += `<div style="margin-top:6px;"><b>${label}</b> (len=${chrom.length}, shape=${chromosomeShape(chrom)})</div>`;
  h += `<div style="word-break:break-all; line-height:1.4; margin:4px 0; font-size:10px;">`;
  for (let b = 0; b < chrom.length; b++) {
    const byte = chrom[b], info = getOpcodeInfo(byte), hex = byte.toString(16).padStart(2, '0');
    h += `<span class="dna-byte" style="color:${byteColor[b]}" data-tip="<span class='tip-title'>0x${hex}</span>\n<span class='tip-desc'>${esc(info.name)}</span>">${hex}</span> `;
  }
  h += `</div>`;
  h += `<div style="color:#8cf; font-size:10px; margin-top:4px;">Decoded (${lines.length} ops)</div>`;
  h += `<pre style="font-size:10px; line-height:1.3; margin:2px 0; white-space:pre-wrap; color:#bbb; background:#0a0a0a; padding:4px; border:1px solid #222; border-radius:3px;">`;
  for (const ln of lines) {
    const k = (lineInfo.get(ln.off) || {}).kind || 'same';
    h += `<span style="color:${lineColorForKind(k, ln.color)}">  ${esc(ln.text)}</span>\n`;
  }
  h += `</pre>`;
  return h;
}

// Byte-level LCS alignment of two raw chromosome byte strings. Used only for
// the bottom hex diff block where op boundaries don't matter — we just want
// "which byte was inserted/removed where". The op-level `alignChromosomes`
// stays in charge of the decoded-text view.
//
// Returns an ordered array of { kind, cb, pb } where cb/pb are bytes (or null
// when only the other side has a byte at this column). Adjacent insert+remove
// runs of equal length are re-paired into 'changed' substitutions so a single
// byte flip shows on one column rather than as insert-then-remove.
//
// Returns null over BYTE_ALIGN_CAP. DP matrix is N×M Uint32; cap of 4096 means
// at most 16M cells = 64MB.
const BYTE_ALIGN_CAP = 4096;
function alignChromosomeBytes(childData, parentData) {
  const N = childData.length, M = parentData.length;
  if (N > BYTE_ALIGN_CAP || M > BYTE_ALIGN_CAP) return null;
  const dp = new Array(N + 1);
  for (let i = 0; i <= N; i++) dp[i] = new Uint32Array(M + 1);
  for (let i = 1; i <= N; i++) for (let j = 1; j <= M; j++) {
    dp[i][j] = childData[i - 1] === parentData[j - 1]
      ? dp[i - 1][j - 1] + 1
      : (dp[i - 1][j] > dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1]);
  }
  const out = [];
  let i = N, j = M;
  while (i > 0 && j > 0) {
    if (childData[i - 1] === parentData[j - 1]) {
      out.push({ kind: 'same', cb: childData[i - 1], pb: parentData[j - 1] });
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      out.push({ kind: 'insert', cb: childData[i - 1], pb: null });
      i--;
    } else {
      out.push({ kind: 'remove', cb: null, pb: parentData[j - 1] });
      j--;
    }
  }
  while (i > 0) { out.push({ kind: 'insert', cb: childData[--i], pb: null }); }
  while (j > 0) { out.push({ kind: 'remove', cb: null, pb: parentData[--j] }); }
  out.reverse();

  // Re-pair adjacent insert/remove runs into 'changed' substitutions. Same
  // logic as alignChromosomes — LCS arbitrates ordering within a run, so we
  // zip equal-length sub-runs into single columns.
  const result = [];
  let k = 0;
  while (k < out.length) {
    if (out[k].kind === 'same') { result.push(out[k++]); continue; }
    let runEnd = k;
    while (runEnd < out.length && out[runEnd].kind !== 'same') runEnd++;
    const inserts = [], removes = [];
    for (let q = k; q < runEnd; q++) {
      if (out[q].kind === 'insert') inserts.push(out[q].cb);
      else removes.push(out[q].pb);
    }
    const pairs = Math.min(inserts.length, removes.length);
    for (let q = 0; q < pairs; q++) result.push({ kind: 'changed', cb: inserts[q], pb: removes[q] });
    for (let q = pairs; q < inserts.length; q++) result.push({ kind: 'insert', cb: inserts[q], pb: null });
    for (let q = pairs; q < removes.length; q++) result.push({ kind: 'remove', cb: null, pb: removes[q] });
    k = runEnd;
  }
  return result;
}

// Bottom hex-byte diff: both chromosomes shown as byte-aligned hex rows. Pure
// byte-level LCS — gaps mark exactly where a byte was inserted or removed,
// independent of any opcode/argument structure. This is what the user wants:
// "show where something was inserted/removed accurately."
function renderHexDiffBlock(childData, parentData) {
  const SAME_C = '#8c8', SAME_P = '#88a', DIFF_C = '#f66', DIFF_P = '#fa6', INS = '#fa0', GAP = '#444';
  const span = (color, text) => `<span class="dna-byte" style="color:${color}">${text}</span> `;
  const align = alignChromosomeBytes(childData, parentData);
  if (!align) {
    return `<div style="margin-top:8px;color:#888;font-size:10px;">byte alignment skipped (chromosome &gt;${BYTE_ALIGN_CAP} bytes).</div>`;
  }
  let childRow = '', parentRow = '';
  for (const e of align) {
    let cColor, pColor;
    if (e.kind === 'same')         { cColor = SAME_C; pColor = SAME_P; }
    else if (e.kind === 'changed') { cColor = DIFF_C; pColor = DIFF_P; }
    else                           { cColor = pColor = INS; }
    childRow += e.cb !== null ? span(cColor, e.cb.toString(16).padStart(2, '0')) : span(GAP, '··');
    parentRow += e.pb !== null ? span(pColor, e.pb.toString(16).padStart(2, '0')) : span(GAP, '··');
  }
  return `<div style="margin-top:8px;font-size:10px;line-height:1.4;">` +
    `<div style="color:#888;">child (byte-aligned)</div>` +
    `<div style="word-break:break-all;">${childRow}</div>` +
    `<div style="color:#888;margin-top:4px;">parent</div>` +
    `<div style="word-break:break-all;">${parentRow}</div>` +
    `</div>`;
}

// Top-level diff renderer for the inspector. Layout:
//   [child(hex+decoded, op-level diff coloured) | parent(same)]
//   [byte-aligned hex byte diff for both chromosomes]
// Side panels use op-level LCS so the decoded text view colours whole ops.
// Bottom hex block uses byte-level LCS so insertions/removals show at the
// exact byte position.
function renderDnaWithDiff(childData, parentData) {
  const align = alignChromosomes(childData, parentData);
  if (!align) {
    // Over alignment cap: show both side-by-side without diff coloring.
    let h = `<div style="color:#888;font-size:10px;margin:4px 0;">chromosome too large to align (&gt;${ALIGN_CAP} ops); showing both panels without diff colouring.</div>`;
    h += `<div style="display:flex; gap:8px; align-items:flex-start;">` +
      `<div style="flex:1; min-width:0;">${renderDnaFull(childData, 'chromosome', -1)}</div>` +
      `<div style="flex:1; min-width:0; border-left:1px solid #2a2a2a; padding-left:8px;">${renderDnaFull(parentData, 'parent', -1)}</div>` +
      `</div>`;
    h += renderHexDiffBlock(childData, parentData);
    return h;
  }

  let h = `<div style="display:flex; gap:8px; align-items:flex-start;">` +
    `<div style="flex:1; min-width:0;">${renderDnaFullDiff(childData, 'chromosome', align, 'child')}</div>` +
    `<div style="flex:1; min-width:0; border-left:1px solid #2a2a2a; padding-left:8px;">${renderDnaFullDiff(parentData, 'parent', align, 'parent')}</div>` +
    `</div>`;
  h += renderHexDiffBlock(childData, parentData);
  return h;
}

// Pre-parse HSL colors into [h, s, l] arrays for rendering speed
const PROTEIN_HSL = PROTEIN_INFO.map(info => {
  const m = info.color.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
  return m ? [+m[1], +m[2], +m[3]] : [0, 0, 50];
});
