// ============================================================
// PHOTONS
// ============================================================
// Dense live-index list. world.photonLive[0..photonLiveCount-1] are slots
// holding alive photons; [photonLiveCount..maxPhotons-1] are free slots.
// Spawn = pop from free stack (append). Kill = swap-and-pop. O(1) each.
// photon_alive[] / photonCount are kept in sync for rendering and UI code.

function _allocPhotonSlot() {
  if (world.photonLiveCount >= CONFIG.maxPhotons) return -1; // buffer full — drop
  const slot = world.photonLive[world.photonLiveCount];
  world.photonLiveIdx[slot] = world.photonLiveCount;
  world.photonLiveCount++;
  world.photon_alive[slot] = 1;
  world.photonCount++;
  return slot;
}

function _freePhotonSlot(slot) {
  // Remove `slot` from the live segment via swap-and-pop.
  const j = world.photonLiveIdx[slot];
  const last = world.photonLiveCount - 1;
  const lastSlot = world.photonLive[last];
  world.photonLive[j] = lastSlot;
  world.photonLiveIdx[lastSlot] = j;
  world.photonLive[last] = slot;
  world.photonLiveIdx[slot] = last;
  world.photonLiveCount--;
  world.photon_alive[slot] = 0;
  world.photonCount--;
}

function photonTick() {
  // Reset the photon-sensor near flags. They are read by directionalSensorTick
  // for type 39 during the per-cell loop of the NEXT tick (photonTick runs
  // after the per-cell loop, so flags populated here are 1-tick delayed).
  world.photonNearSlot.fill(0);

  // Move light source
  if (CONFIG.lightSourceMoving) world.lightSourceAngle += CONFIG.lightSourceSpeed;
  const cx = CONFIG.worldWidth / 2, cy = CONFIG.worldHeight / 2;
  const orbitR = Math.min(cx, cy) * 0.6;
  const lx = cx + Math.cos(world.lightSourceAngle) * orbitR;
  const ly = cy + Math.sin(world.lightSourceAngle) * orbitR;

  // Pre-cache: does each alive cell have a photon catcher (type 0) in each
  // slot? O(7) per alive cell via world.slotTypeCount (type-0 count for each
  // of the 7 slots). Dead cells are never looked up (buckets only contain
  // alive cells) so we skip them.
  // Also caches: hasPhotonSensor[i] = 1 iff cell i holds any Photon Sensor
  // (type 39); radiusPlusRangeSq[i] = (radius + sensorRange)^2 — used by the
  // sensor-near flagging in the photon-cell inner loop.
  if (!photonTick._catcherSlots) photonTick._catcherSlots = new Uint8Array(world.maxCells * 7);
  const catcherSlots = photonTick._catcherSlots;
  if (!photonTick._radiusSq) photonTick._radiusSq = new Float32Array(world.maxCells);
  const radiusSq = photonTick._radiusSq;
  if (!photonTick._hasPhotonSensor) photonTick._hasPhotonSensor = new Uint8Array(world.maxCells);
  const hasPhotonSensor = photonTick._hasPhotonSensor;
  if (!photonTick._radiusPlusRangeSq) photonTick._radiusPlusRangeSq = new Float32Array(world.maxCells);
  const radiusPlusRangeSq = photonTick._radiusPlusRangeSq;
  const stc = world.slotTypeCount;
  const sensorRange = CONFIG.sensorRange;
  for (let i = 0; i < world.maxCells; i++) {
    if (!world.alive[i]) { hasPhotonSensor[i] = 0; continue; }
    const base = i * 7;
    const stcBase = i * 7 * 64; // NUM_SLOTS * 64
    let psCount = 0;
    for (let s = 0; s < 7; s++) {
      catcherSlots[base + s] = stc[stcBase + s * 64] > 0 ? 1 : 0;
      psCount += stc[stcBase + s * 64 + 39];
    }
    hasPhotonSensor[i] = psCount > 0 ? 1 : 0;
    const r = world.radius[i];
    radiusSq[i] = r * r;
    const rr = r + sensorRange;
    radiusPlusRangeSq[i] = rr * rr;
  }

  // Spawn — append to live list. On overflow, drop.
  for (let s = 0; s < CONFIG.photonSpawnRate; s++) {
    const slot = _allocPhotonSlot();
    if (slot === -1) break;
    const angle = world.rng.next() * Math.PI * 2;
    const spd = CONFIG.photonSpeed + world.rng.next() * 0.3;
    const spread = world.rng.next() * CONFIG.lightSourceRadius * 0.3;
    world.photon_x[slot] = lx + Math.cos(angle) * spread;
    world.photon_y[slot] = ly + Math.sin(angle) * spread;
    world.photon_vx[slot] = Math.cos(angle) * spd;
    world.photon_vy[slot] = Math.sin(angle) * spd;
    world.photon_age[slot] = 0;
    world.photon_energy[slot] = CONFIG.photonEnergyValue;
  }

  // Move & interact — iterate only live slots.
  const ww = CONFIG.worldWidth, wh = CONFIG.worldHeight;
  const gcs = world.gridCellSize, gw = world.gridW, gh = world.gridH;
  const maxLife = CONFIG.photonLifetime;

  let j = 0;
  while (j < world.photonLiveCount) {
    const p = world.photonLive[j];

    let px = world.photon_x[p] + world.photon_vx[p];
    let py = world.photon_y[p] + world.photon_vy[p];
    world.photon_age[p]++;

    if (world.photon_age[p] > maxLife) {
      _freePhotonSlot(p);
      continue; // swapped-in slot is now at position j, re-process
    }

    // Wall bounce
    if (px < 0) { px = 0; world.photon_vx[p] = Math.abs(world.photon_vx[p]); }
    else if (px > ww) { px = ww; world.photon_vx[p] = -Math.abs(world.photon_vx[p]); }
    if (py < 0) { py = 0; world.photon_vy[p] = Math.abs(world.photon_vy[p]); }
    else if (py > wh) { py = wh; world.photon_vy[p] = -Math.abs(world.photon_vy[p]); }

    world.photon_x[p] = px;
    world.photon_y[p] = py;

    // Cell collision — only check the one grid cell the photon is in + direct neighbors
    const gx = (px / gcs) | 0;
    const gy = (py / gcs) | 0;
    if (gx < 0 || gx >= gw || gy < 0 || gy >= gh) { j++; continue; }

    let hit = false;
    let absorbed = false;
    const gxMin = gx > 0 ? gx - 1 : 0, gxMax = gx < gw - 1 ? gx + 1 : gx;
    const gyMin = gy > 0 ? gy - 1 : 0, gyMax = gy < gh - 1 ? gy + 1 : gy;

    for (let gy2 = gyMin; gy2 <= gyMax && !hit; gy2++) {
      for (let gx2 = gxMin; gx2 <= gxMax && !hit; gx2++) {
        const bucket = world.grid[gy2 * gw + gx2];
        for (let k = 0, bl = bucket.length; k < bl; k++) {
          const ci = bucket[k];
          const cdx = px - world.pos_x[ci];
          const cdy = py - world.pos_y[ci];
          const distSq = cdx * cdx + cdy * cdy;
          // Photon-sensor near flag — any cell within (radius + sensorRange).
          // Cheap when no cells have type 39 (hasPhotonSensor is all-zero).
          if (hasPhotonSensor[ci] && distSq < radiusPlusRangeSq[ci]) {
            const ang = ((Math.atan2(cdy, cdx) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
            const specSlot = 1 + ((ang / (Math.PI * 2) * 6) | 0) % 6;
            world.photonNearSlot[ci * 7] = 1;
            world.photonNearSlot[ci * 7 + specSlot] = 1;
          }
          if (distSq < radiusSq[ci]) {
            const base = ci * 7;
            const ang = ((Math.atan2(cdy, cdx) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
            const specSlot = 1 + ((ang / (Math.PI * 2) * 6) | 0) % 6;
            const memHit = catcherSlots[base];
            const specHit = catcherSlots[base + specSlot];
            const mult = memHit * 1.0 + specHit * 3.0;
            if (mult > 0) {
              world.energy[ci] = Math.min(CONFIG.energyCap, world.energy[ci] + world.photon_energy[p] * mult);
              world.milestones.photonsAbsorbed++;
              absorbed = true;
            } else {
              const dist = Math.sqrt(distSq);
              if (dist > 0.01) {
                const nnx = cdx / dist, nny = cdy / dist;
                const dot = world.photon_vx[p] * nnx + world.photon_vy[p] * nny;
                world.photon_vx[p] -= 2 * dot * nnx;
                world.photon_vy[p] -= 2 * dot * nny;
                world.photon_x[p] = world.pos_x[ci] + nnx * (world.radius[ci] + 1);
                world.photon_y[p] = world.pos_y[ci] + nny * (world.radius[ci] + 1);
              }
            }
            hit = true; break;
          }
        }
      }
    }

    if (absorbed) {
      _freePhotonSlot(p);
      continue; // swapped-in slot now at j, re-process
    }
    j++;
  }
}

// Spawn a photon at (x,y) carrying a custom energy value. Used by extracellular
// chromase digestion to release energy as light. Returns the allocated slot or -1.
function spawnPhotonAt(x, y, energy) {
  const slot = _allocPhotonSlot();
  if (slot === -1) return -1;
  const angle = world.rng.next() * Math.PI * 2;
  const spd = CONFIG.photonSpeed + world.rng.next() * 0.3;
  world.photon_x[slot] = x; world.photon_y[slot] = y;
  world.photon_vx[slot] = Math.cos(angle) * spd;
  world.photon_vy[slot] = Math.sin(angle) * spd;
  world.photon_age[slot] = 0;
  world.photon_energy[slot] = energy;
  return slot;
}
