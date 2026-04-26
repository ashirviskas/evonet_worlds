// ============================================================
// INTERACTION
// ============================================================
let suppressNextClick = false;
canvas.addEventListener('click', (e) => {
  if (suppressNextClick) { suppressNextClick = false; return; }
  const rect = canvas.getBoundingClientRect();
  const wp = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  // Shift / ctrl / cmd → additive: keep existing popups open and add a new one.
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;

  // Pick nearest entity, preferring cells over free chroms over free proteins
  // (matches the original z-order of the loop).
  let hitKind = null, hitIdx = -1, bestD = Infinity;
  for (let i = 0; i < world.maxCells; i++) {
    if (!world.alive[i]) continue;
    const dx = world.pos_x[i] - wp.x, dy = world.pos_y[i] - wp.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < world.radius[i] && d < bestD) { hitKind = 'cell'; hitIdx = i; bestD = d; }
  }
  if (hitKind === null) {
    for (let i = 0; i < world.freeChromosomes.length; i++) {
      const fc = world.freeChromosomes[i];
      const dx = fc.x - wp.x, dy = fc.y - wp.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 15 && d < bestD) { hitKind = 'freeChrom'; hitIdx = i; bestD = d; }
    }
  }
  if (hitKind === null) {
    for (let i = 0; i < CONFIG.maxFreeProteins; i++) {
      if (!world.freeP_alive[i]) continue;
      const dx = world.freeP_x[i] - wp.x, dy = world.freeP_y[i] - wp.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 10 && d < bestD) { hitKind = 'freeProtein'; hitIdx = i; bestD = d; }
    }
  }

  if (!additive) {
    closeAllInspectPopups();
  }
  if (hitKind === null) return; // empty click + no modifier already cleared above

  if (hitKind === 'cell') {
    selectedCells.add(hitIdx); selectedCell = hitIdx;
  } else if (hitKind === 'freeChrom') {
    selectedFreeChroms.add(hitIdx); selectedFreeChrom = hitIdx;
  } else {
    selectedFreeProteins.add(hitIdx); selectedFreeProtein = hitIdx;
  }
  openInspectPopup(hitKind, hitIdx);
});

let dragging = false, dragStart = { x: 0, y: 0 }, cameraStart = { x: 0, y: 0 };
// Item drag (when paused): { kind: 'cell'|'free'|'chrom', idx }
let draggingItem = null, dragMoved = false;

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 1 || e.button === 2) {
    dragging = true; dragStart = { x: e.clientX, y: e.clientY }; cameraStart = { x: camera.x, y: camera.y }; e.preventDefault();
    return;
  }
  if (e.button === 0 && !running) {
    // Try to pick an item to drag
    const rect = canvas.getBoundingClientRect();
    const wp = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    // Cells first
    for (let i = 0; i < world.maxCells; i++) {
      if (!world.alive[i]) continue;
      const dx = world.pos_x[i] - wp.x, dy = world.pos_y[i] - wp.y;
      if (Math.sqrt(dx * dx + dy * dy) < world.radius[i]) { draggingItem = { kind: 'cell', idx: i }; dragMoved = false; return; }
    }
    // Free chromosomes
    for (let i = 0; i < world.freeChromosomes.length; i++) {
      const fc = world.freeChromosomes[i];
      const dx = fc.x - wp.x, dy = fc.y - wp.y;
      if (Math.sqrt(dx * dx + dy * dy) < 15) { draggingItem = { kind: 'chrom', idx: i }; dragMoved = false; return; }
    }
    // Free proteins
    for (let i = 0; i < CONFIG.maxFreeProteins; i++) {
      if (!world.freeP_alive[i]) continue;
      const dx = world.freeP_x[i] - wp.x, dy = world.freeP_y[i] - wp.y;
      if (Math.sqrt(dx * dx + dy * dy) < 8) { draggingItem = { kind: 'free', idx: i }; dragMoved = false; return; }
    }
  }
});
canvas.addEventListener('mousemove', (e) => {
  if (dragging) { camera.x = cameraStart.x - (e.clientX - dragStart.x) / camera.zoom; camera.y = cameraStart.y - (e.clientY - dragStart.y) / camera.zoom; return; }
  if (draggingItem) {
    const rect = canvas.getBoundingClientRect();
    const wp = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    dragMoved = true;
    if (draggingItem.kind === 'cell') {
      world.pos_x[draggingItem.idx] = wp.x; world.pos_y[draggingItem.idx] = wp.y;
      world.vel_x[draggingItem.idx] = 0; world.vel_y[draggingItem.idx] = 0;
    } else if (draggingItem.kind === 'chrom') {
      world.freeChromosomes[draggingItem.idx].x = wp.x;
      world.freeChromosomes[draggingItem.idx].y = wp.y;
      world.freeChromosomes[draggingItem.idx].vx = 0; world.freeChromosomes[draggingItem.idx].vy = 0;
    } else if (draggingItem.kind === 'free') {
      world.freeP_x[draggingItem.idx] = wp.x; world.freeP_y[draggingItem.idx] = wp.y;
      world.freeP_vx[draggingItem.idx] = 0; world.freeP_vy[draggingItem.idx] = 0;
    }
    render();
  }
});
canvas.addEventListener('mouseup', (e) => {
  dragging = false;
  if (draggingItem) {
    if (dragMoved) suppressNextClick = true;
    draggingItem = null;
  }
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => { e.preventDefault(); camera.zoom *= e.deltaY > 0 ? 0.9 : 1.1; camera.zoom = Math.max(0.2, Math.min(5, camera.zoom)); });
