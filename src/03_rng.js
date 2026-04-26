// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// RNG
// ============================================================
function makeRNG(seed) {
  let s = [seed, seed ^ 0xDEADBEEF, seed ^ 0xCAFEBABE, seed ^ 0x12345678];
  function next() {
    let t = s[3]; t ^= t << 11; t ^= t >>> 8;
    s[3] = s[2]; s[2] = s[1]; s[1] = s[0];
    t ^= s[0]; t ^= s[0] >>> 19; s[0] = t;
    return (t >>> 0) / 4294967296;
  }
  for (let i = 0; i < 20; i++) next();
  return {
    next,
    nextInt(max) { return (next() * max) | 0; },
    nextRange(min, max) { return min + next() * (max - min); },
    getState() { return [s[0], s[1], s[2], s[3]]; },
    setState(st) { s[0] = st[0] | 0; s[1] = st[1] | 0; s[2] = st[2] | 0; s[3] = st[3] | 0; },
  };
}
