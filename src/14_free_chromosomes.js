// ============================================================
// TASK 002 — FREE CHROMOSOMES IN MEDIUM
// ============================================================
function spawnFreeChromosome(x, y, data, direction) {
  if (world.freeChromosomes.length >= CONFIG.maxFreeChromosomes) return;
  const buf = new Uint8Array(data);
  // Preserve lineage id if the source buffer had one (e.g. ejection from a cell);
  // primordial-soup callers pass a fresh buffer with no lineage — caller assigns.
  lineageTransfer(data, buf, direction);
  world.freeChromosomes.push({
    x, y,
    vx: (world.rng.next() - 0.5) * 0.3,
    vy: (world.rng.next() - 0.5) * 0.3,
    data: buf,
    age: 0,
    bytesErodedSinceCheckpoint: 0,
  });
  world.milestones.freeChromSpawned++;
  return buf;
}

function freeChromosomeTick() {
  const ww = CONFIG.worldWidth, wh = CONFIG.worldHeight;
  for (let i = world.freeChromosomes.length - 1; i >= 0; i--) {
    const fc = world.freeChromosomes[i];
    fc.age++;
    // Drift
    fc.vx += (world.rng.next() - 0.5) * 0.02;
    fc.vy += (world.rng.next() - 0.5) * 0.02;
    fc.vx *= 0.99; fc.vy *= 0.99;
    fc.x += fc.vx; fc.y += fc.vy;
    // Wall bounce
    if (fc.x < 0) { fc.x = 0; fc.vx *= -1; }
    else if (fc.x > ww) { fc.x = ww; fc.vx *= -1; }
    if (fc.y < 0) { fc.y = 0; fc.vy *= -1; }
    else if (fc.y > wh) { fc.y = wh; fc.vy *= -1; }
    // Degrade: lose a random byte periodically
    if (fc.age % CONFIG.freeChromDegradeTicks === 0 && fc.data.length > 0) {
      const pos = world.rng.nextInt(fc.data.length);
      const nd = new Uint8Array(fc.data.length - 1);
      nd.set(fc.data.subarray(0, pos));
      if (pos < fc.data.length - 1) nd.set(fc.data.subarray(pos + 1), pos);
      const prevId = lineageTransfer(fc.data, nd, 'sameFree');
      fc.data = nd;
      fc.bytesErodedSinceCheckpoint = (fc.bytesErodedSinceCheckpoint || 0) + 1;
      if (prevId > 0 && fc.bytesErodedSinceCheckpoint >= CONFIG.lineageDegradeCheckpointBytes) {
        // Emit a checkpoint: new node descending from prev, rebind buffer to it.
        lineageCheckpoint(fc.data, [prevId], 'degrade-checkpoint', 'free');
        fc.bytesErodedSinceCheckpoint = 0;
      }
    }
    // Remove if empty
    if (fc.data.length === 0) {
      lineageMarkDead(fc.data, 'free');
      world.freeChromosomes.splice(i, 1);
    }
  }
  // Spawn random chromosomes (primordial soup)
  if (CONFIG.chromSpawnEnabled && world.tick % CONFIG.chromSpawnInterval === 0 && world.freeChromosomes.length < CONFIG.maxFreeChromosomes) {
    const len = CONFIG.chromSpawnMinLen + world.rng.nextInt(CONFIG.chromSpawnMaxLen - CONFIG.chromSpawnMinLen + 1);
    const data = new Uint8Array(len);
    for (let b = 0; b < len; b++) data[b] = world.rng.nextInt(256);
    assignLineage(data, [], 'primordial', 'free');
    spawnFreeChromosome(
      world.rng.nextRange(50, CONFIG.worldWidth - 50),
      world.rng.nextRange(50, CONFIG.worldHeight - 50),
      data,
      'sameFree'
    );
  }
}
