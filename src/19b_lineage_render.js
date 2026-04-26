// ============================================================
// LINEAGE PANEL — left-side interactive tree of the DNA lineage DAG.
//
// - Primary-parent tidy tree (depth on X, siblings on Y).
// - Right-click drag to pan. Wheel to zoom. Left click a node for the inspector.
// - Hover an edge → tooltip with contribution details.
// - Hover a node → ring highlight.
// - Inspector: floating draggable+resizable window that re-uses renderDnaFull to
//   show the exact bytes frozen at birth, with diff highlighting vs the primary
//   parent when one is available.
// ============================================================
const lineageCanvas = document.getElementById('lineage-canvas');
const lineageCtx = lineageCanvas ? lineageCanvas.getContext('2d') : null;
const lineagePopup = document.getElementById('lineage-popup');
const lineageEdgeTooltip = document.getElementById('lineage-edge-tooltip');

const lineageView = {
  offsetX: 0, offsetY: 0,
  zoom: 1,
  selectedId: -1,
  hoverId: -1,
  hoverEdge: null,        // {childId, parentIndex, frac, bytes, parentLen}
  pinnedAutoFit: true,
  panning: false,
  lastMouseX: 0, lastMouseY: 0,
  minCopiesEver: 1,       // filter: hide lineage nodes whose lifetime copiesEver is below this
};

// Sticky toggle for the chromosome inspect popup's "show diff" view. Persists
// across openings/parent-jumps so a user studying a lineage doesn't have to
// re-toggle on every node.
let lineageDiffOpen = false;

const lineageLayout = {
  version: -1,
  filterThreshold: 1,     // copiesEver threshold that produced the current layout; forces rebuild when it changes
  positions: new Map(),
  edges: [],              // cached for hover hit-testing: {childId, parentId, parentIndex, x1,y1,x2,y2, frac, isMain}
  bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  visibleCount: 0,        // number of nodes placed after filtering
};

const LEVEL_WIDTH = 60;
const SIBLING_HEIGHT = 22;

function resizeLineageCanvas() {
  if (!lineageCanvas) return;
  const p = document.getElementById('lineage-panel');
  lineageCanvas.width = p.clientWidth;
  lineageCanvas.height = p.clientHeight;
}
if (lineageCanvas) {
  resizeLineageCanvas();
  window.addEventListener('resize', resizeLineageCanvas);
  attachLineageInteractions();
  attachLineageFilter();
}

// ---------- Highlight helpers (consumed by 19_rendering) ----------
function collectLineageDescendants(rootId) {
  const out = new Set();
  if (!lineage.nodes.has(rootId)) return out;
  out.add(rootId);
  const stack = [rootId];
  while (stack.length) {
    const pid = stack.pop();
    const kids = lineage.children.get(pid);
    if (!kids) continue;
    for (const kid of kids) {
      if (out.has(kid)) continue;
      out.add(kid);
      stack.push(kid);
    }
  }
  return out;
}

function setLineageHighlight(idSet) {
  lineageHighlight.ids = idSet instanceof Set ? idSet : new Set(idSet);
}
function clearLineageHighlight() { lineageHighlight.ids = new Set(); }

// Focus the lineage panel on a specific lineage id. Resets the copiesEver
// filter if the target is hidden, centers the view, then opens the popup.
function jumpToLineage(id) {
  if (!(id > 0) || !lineage.nodes.has(id)) return;
  const n = lineage.nodes.get(id);
  if ((n.copiesEver || 1) < lineageView.minCopiesEver) {
    lineageView.minCopiesEver = 1;
    const slider = document.getElementById('lineage-min-copies');
    const label = document.getElementById('lineage-min-copies-val');
    if (slider) slider.value = '1';
    if (label) label.textContent = '1';
  }
  if (lineageLayout.version !== lineage.structVersion || lineageLayout.filterThreshold !== lineageView.minCopiesEver) {
    rebuildLineageLayout();
  }
  lineageView.selectedId = id;
  const pos = lineageLayout.positions.get(id);
  if (pos && lineageCanvas) {
    const cx = lineageCanvas.width / 2;
    const cy = lineageCanvas.height / 2;
    lineageView.offsetX = cx - pos.x * lineageView.zoom;
    lineageView.offsetY = cy - pos.y * lineageView.zoom;
    lineageView.pinnedAutoFit = false;
    showLineagePopup(id, cx, cy);
  } else {
    showLineagePopup(id, 40, 40);
  }
}
window.jumpToLineage = jumpToLineage;

function attachLineageFilter() {
  const slider = document.getElementById('lineage-min-copies');
  const label = document.getElementById('lineage-min-copies-val');
  if (!slider || !label) return;
  const apply = () => {
    const v = Math.max(1, parseInt(slider.value, 10) || 1);
    lineageView.minCopiesEver = v;
    label.textContent = String(v);
    lineageView.pinnedAutoFit = true;
  };
  slider.addEventListener('input', apply);
  apply();
}

function lineageNodeRadius(n) {
  return Math.max(4, Math.min(14, 5 + Math.log(1 + n.descendantsEver) * 1.6));
}

function fractionFromParent(child, parentIndex) {
  const pid = child.parents[parentIndex];
  const p = lineage.nodes.get(pid);
  if (!p || p.length === 0) return 1;
  const bytes = child.parentBytes ? (child.parentBytes[parentIndex] || 0) : p.length;
  return bytes / p.length;
}

// Edge colour keyed by the child's birth event — lets the user tell apart
// replication, crossover, division mutation, and degradation checkpoints.
// `isMain` is true for the top-2 parents by byte contribution (drawn solid); the
// rest are drawn dashed at lower alpha.
function edgeColorForEvent(event, isMain) {
  switch (event) {
    case 'crossover':          return isMain ? 'rgba(255,170,80,0.8)'  : 'rgba(255,140,60,0.35)';
    case 'division-mutate':    return isMain ? 'rgba(110,220,130,0.8)' : 'rgba(90,180,110,0.35)';
    case 'division-split':     return isMain ? 'rgba(140,220,180,0.8)' : 'rgba(110,180,150,0.35)';
    case 'degrade-checkpoint': return isMain ? 'rgba(210,110,80,0.8)'  : 'rgba(180,90,60,0.35)';
    case 'digest-checkpoint':  return isMain ? 'rgba(220,100,150,0.8)' : 'rgba(180,80,120,0.35)';
    case 'clone':              return isMain ? 'rgba(200,200,200,0.8)' : 'rgba(170,170,170,0.35)';
    case 'replicase':
    default:                   return isMain ? 'rgba(120,200,255,0.8)' : 'rgba(120,200,255,0.3)';
  }
}

function rebuildLineageLayout() {
  const positions = new Map();
  const childrenByPrimary = new Map();
  const roots = [];
  const minCE = lineageView.minCopiesEver;
  const visible = (id) => {
    const n = lineage.nodes.get(id);
    return !!n && (n.copiesEver || 1) >= minCE;
  };
  // Walk up primaryParentId until we hit a visible ancestor; returns -1 if none.
  const effectiveParent = (n) => {
    let pid = n.primaryParentId;
    const seen = new Set();
    while (pid > 0 && lineage.nodes.has(pid) && !seen.has(pid)) {
      if (visible(pid)) return pid;
      seen.add(pid);
      pid = lineage.nodes.get(pid).primaryParentId;
    }
    return -1;
  };
  for (const [id, n] of lineage.nodes) {
    if (!visible(id)) continue;
    const pid = effectiveParent(n);
    if (pid < 0) { roots.push(id); continue; }
    let arr = childrenByPrimary.get(pid);
    if (!arr) { arr = []; childrenByPrimary.set(pid, arr); }
    arr.push(id);
  }
  roots.sort((a, b) => lineage.nodes.get(a).birthTick - lineage.nodes.get(b).birthTick);
  for (const kids of childrenByPrimary.values()) kids.sort((a, b) => lineage.nodes.get(a).birthTick - lineage.nodes.get(b).birthTick);

  // Post-order subtree heights.
  const subtreeHeight = new Map();
  const stack = roots.map(r => ({ id: r, childIdx: 0 }));
  const visited = new Set(roots);
  while (stack.length) {
    const top = stack[stack.length - 1];
    const kids = childrenByPrimary.get(top.id) || [];
    if (top.childIdx < kids.length) {
      const ck = kids[top.childIdx++];
      if (!visited.has(ck)) { visited.add(ck); stack.push({ id: ck, childIdx: 0 }); }
    } else {
      let h = 0;
      for (const ck of kids) h += subtreeHeight.get(ck) || 1;
      if (h === 0) h = 1;
      subtreeHeight.set(top.id, h);
      stack.pop();
    }
  }

  // Pre-order iterative placement.
  let cursorY = 0;
  const placeStack = [];
  for (const r of roots) {
    placeStack.push({ id: r, depth: 0, baseY: cursorY });
    while (placeStack.length) {
      const { id, depth, baseY } = placeStack.pop();
      const kids = childrenByPrimary.get(id) || [];
      const h = subtreeHeight.get(id) || 1;
      positions.set(id, { x: depth * LEVEL_WIDTH + 20, y: (baseY + h / 2) * SIBLING_HEIGHT });
      let acc = 0;
      const placements = [];
      for (const ck of kids) {
        const ch = subtreeHeight.get(ck) || 1;
        placements.push({ id: ck, depth: depth + 1, baseY: baseY + acc });
        acc += ch;
      }
      for (let i = placements.length - 1; i >= 0; i--) placeStack.push(placements[i]);
    }
    cursorY += subtreeHeight.get(r) || 1;
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { x, y } of positions.values()) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1; }

  lineageLayout.positions = positions;
  lineageLayout.bounds = { minX, minY, maxX, maxY };
  lineageLayout.version = lineage.structVersion;
  lineageLayout.filterThreshold = minCE;
  lineageLayout.visibleCount = positions.size;
}

function autoFitLineageView() {
  if (!lineageCanvas) return;
  const b = lineageLayout.bounds;
  const w = lineageCanvas.width, h = lineageCanvas.height;
  const pad = 30;
  const dw = Math.max(1, b.maxX - b.minX);
  const dh = Math.max(1, b.maxY - b.minY);
  const zx = (w - pad * 2) / dw;
  const zy = (h - pad * 2) / dh;
  lineageView.zoom = Math.min(Math.max(Math.min(zx, zy), 0.25), 8);
  lineageView.offsetX = pad - b.minX * lineageView.zoom;
  lineageView.offsetY = pad - b.minY * lineageView.zoom;
}

function worldToScreenL(x, y) {
  return { sx: x * lineageView.zoom + lineageView.offsetX, sy: y * lineageView.zoom + lineageView.offsetY };
}
function screenToWorldL(sx, sy) {
  return { x: (sx - lineageView.offsetX) / lineageView.zoom, y: (sy - lineageView.offsetY) / lineageView.zoom };
}

function renderLineage() {
  if (!lineageCtx) return;
  if (lineageLayout.version !== lineage.structVersion || lineageLayout.filterThreshold !== lineageView.minCopiesEver) {
    rebuildLineageLayout();
    if (lineageView.pinnedAutoFit) autoFitLineageView();
  }
  const W = lineageCanvas.width, H = lineageCanvas.height;
  lineageCtx.fillStyle = '#141414';
  lineageCtx.fillRect(0, 0, W, H);

  const positions = lineageLayout.positions;
  const edgeList = []; // rebuild each frame for hit-testing

  for (const [id, n] of lineage.nodes) {
    const cPos = positions.get(id);
    if (!cPos || !n.parents.length) continue;
    const cS = worldToScreenL(cPos.x, cPos.y);
    const ranked = n.parents.map((pid, i) => ({ pid, i, frac: fractionFromParent(n, i) }));
    ranked.sort((a, b) => b.frac - a.frac);
    for (let j = 0; j < ranked.length; j++) {
      const { pid, i: pIdx, frac } = ranked[j];
      const pPos = positions.get(pid);
      if (!pPos) continue;
      const pS = worldToScreenL(pPos.x, pPos.y);
      const isMain = j < 2;
      const lw = Math.max(0.4, Math.min(6, frac * 4));
      lineageCtx.strokeStyle = edgeColorForEvent(n.event, isMain);
      lineageCtx.lineWidth = lw;
      lineageCtx.setLineDash(isMain ? [] : [4, 3]);
      const mx = (pS.sx + cS.sx) / 2;
      lineageCtx.beginPath();
      lineageCtx.moveTo(pS.sx, pS.sy);
      lineageCtx.bezierCurveTo(mx, pS.sy, mx, cS.sy, cS.sx, cS.sy);
      lineageCtx.stroke();
      edgeList.push({ childId: id, parentId: pid, parentIndex: pIdx, x1: pS.sx, y1: pS.sy, x2: cS.sx, y2: cS.sy, frac, isMain });
    }
  }
  lineageCtx.setLineDash([]);
  lineageLayout.edges = edgeList;

  // Nodes. Tri-state rendering — alive (filled, full saturation), ghost (filled
  // dim with hue ring), dead (open stroke only).
  for (const [id, n] of lineage.nodes) {
    const pos = positions.get(id);
    if (!pos) continue;
    const { sx, sy } = worldToScreenL(pos.x, pos.y);
    if (sx < -30 || sx > W + 30 || sy < -30 || sy > H + 30) continue;
    const r = lineageNodeRadius(n);
    const hue = (n.shape * 36) % 360;
    const state = n.copies === 0 ? 'dead'
                : ((n.copiesInCells || 0) > 0 ? 'alive' : 'ghost');

    if (state === 'alive') {
      lineageCtx.fillStyle = `hsla(${hue},70%,55%,0.95)`;
      lineageCtx.beginPath();
      lineageCtx.arc(sx, sy, r, 0, Math.PI * 2);
      lineageCtx.fill();
    } else if (state === 'ghost') {
      lineageCtx.fillStyle = `hsla(${hue},35%,40%,0.7)`;
      lineageCtx.beginPath();
      lineageCtx.arc(sx, sy, r, 0, Math.PI * 2);
      lineageCtx.fill();
      lineageCtx.strokeStyle = `hsla(${hue},70%,55%,0.9)`;
      lineageCtx.lineWidth = 1.5;
      lineageCtx.stroke();
    } else {
      lineageCtx.strokeStyle = `hsla(${hue},20%,45%,0.35)`;
      lineageCtx.lineWidth = 1;
      lineageCtx.beginPath();
      lineageCtx.arc(sx, sy, r, 0, Math.PI * 2);
      lineageCtx.stroke();
    }
    if (n.mergedCount > 0 && state !== 'dead') {
      lineageCtx.strokeStyle = 'rgba(255,255,255,0.35)';
      lineageCtx.lineWidth = 1;
      lineageCtx.stroke();
    }
    if (id === lineageView.selectedId) {
      lineageCtx.strokeStyle = '#fff';
      lineageCtx.lineWidth = 2;
      lineageCtx.stroke();
    } else if (id === lineageView.hoverId) {
      lineageCtx.strokeStyle = 'rgba(255,255,255,0.6)';
      lineageCtx.lineWidth = 1.5;
      lineageCtx.stroke();
    }
  }

  // Edge-colour legend above the stats caption.
  const legend = [
    { evt: 'replicase',          label: 'repl' },
    { evt: 'crossover',          label: 'xover' },
    { evt: 'division-mutate',    label: 'div-mut' },
    { evt: 'degrade-checkpoint', label: 'degrade' },
    { evt: 'digest-checkpoint',  label: 'digest' },
  ];
  lineageCtx.font = '9px monospace';
  let legendX = 6;
  const legendY = H - 18;
  for (const entry of legend) {
    lineageCtx.fillStyle = edgeColorForEvent(entry.evt, true);
    lineageCtx.fillRect(legendX, legendY, 10, 5);
    lineageCtx.fillStyle = '#aaa';
    lineageCtx.fillText(entry.label, legendX + 13, legendY + 5);
    legendX += 13 + Math.ceil(lineageCtx.measureText(entry.label).width) + 8;
  }

  const stats = lineageStats();
  lineageCtx.fillStyle = '#8cf';
  lineageCtx.font = '10px monospace';
  const filterNote = lineageView.minCopiesEver > 1 ? ` · showing ${lineageLayout.visibleCount}/${stats.total} (copiesEver≥${lineageView.minCopiesEver})` : '';
  lineageCtx.fillText(`${stats.alive} alive / ${stats.ghost} ghost / ${stats.dead} dead · ${stats.copies} copies · ${stats.total} nodes${stats.merges ? ` · ${stats.merges} merged` : ''}${filterNote}`, 6, H - 4);
}

// ---------- Hit-testing ----------
function lineageHitTestNode(sx, sy) {
  if (lineageLayout.version !== lineage.structVersion || lineageLayout.filterThreshold !== lineageView.minCopiesEver) rebuildLineageLayout();
  let bestId = -1, bestD2 = Infinity;
  for (const [id, pos] of lineageLayout.positions) {
    const n = lineage.nodes.get(id);
    if (!n) continue;
    const s = worldToScreenL(pos.x, pos.y);
    const dx = s.sx - sx, dy = s.sy - sy;
    const r = lineageNodeRadius(n);
    const d2 = dx * dx + dy * dy;
    if (d2 <= r * r && d2 < bestD2) { bestD2 = d2; bestId = id; }
  }
  return bestId;
}

// Point-to-segment distance for edge hover.
function pointSegDist2(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const fx = x1 + t * dx, fy = y1 + t * dy;
  const ex = px - fx, ey = py - fy;
  return ex * ex + ey * ey;
}

function lineageHitTestEdge(sx, sy) {
  let best = null, bestD2 = 36; // within 6px
  for (const e of lineageLayout.edges) {
    const d2 = pointSegDist2(sx, sy, e.x1, e.y1, e.x2, e.y2);
    if (d2 < bestD2) { bestD2 = d2; best = e; }
  }
  return best;
}

// ---------- Interaction ----------
function attachLineageInteractions() {
  lineageCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

  lineageCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    lineageView.pinnedAutoFit = false;
    const rect = lineageCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const before = screenToWorldL(mx, my);
    const factor = Math.exp(-e.deltaY * 0.0015);
    lineageView.zoom = Math.min(8, Math.max(0.25, lineageView.zoom * factor));
    lineageView.offsetX = mx - before.x * lineageView.zoom;
    lineageView.offsetY = my - before.y * lineageView.zoom;
  }, { passive: false });

  lineageCanvas.addEventListener('mousedown', (e) => {
    const rect = lineageCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    // Right or middle button → pan.
    if (e.button === 1 || e.button === 2) {
      e.preventDefault();
      lineageView.panning = true;
      lineageView.lastMouseX = mx;
      lineageView.lastMouseY = my;
      return;
    }
    // Left button → click (tracked on mouseup).
    lineageView._downX = mx;
    lineageView._downY = my;
    lineageView._leftDown = true;
  });

  window.addEventListener('mousemove', (e) => {
    if (!lineageCanvas) return;
    const rect = lineageCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const inside = mx >= 0 && my >= 0 && mx < lineageCanvas.width && my < lineageCanvas.height;

    if (lineageView.panning) {
      const dx = mx - lineageView.lastMouseX, dy = my - lineageView.lastMouseY;
      if (dx || dy) {
        lineageView.offsetX += dx;
        lineageView.offsetY += dy;
        lineageView.pinnedAutoFit = false;
      }
      lineageView.lastMouseX = mx;
      lineageView.lastMouseY = my;
      return;
    }

    if (!inside) { hideLineageEdgeTooltip(); lineageView.hoverId = -1; return; }

    const nodeId = lineageHitTestNode(mx, my);
    lineageView.hoverId = nodeId;
    if (nodeId > 0) {
      lineageCanvas.style.cursor = 'pointer';
      hideLineageEdgeTooltip();
      return;
    }
    const edge = lineageHitTestEdge(mx, my);
    if (edge) {
      lineageCanvas.style.cursor = 'help';
      showLineageEdgeTooltip(edge, e.clientX, e.clientY);
    } else {
      lineageCanvas.style.cursor = 'grab';
      hideLineageEdgeTooltip();
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (lineageView.panning) { lineageView.panning = false; return; }
    if (!lineageView._leftDown) return;
    lineageView._leftDown = false;
    const rect = lineageCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const moved = Math.abs(mx - lineageView._downX) + Math.abs(my - lineageView._downY);
    const inside = mx >= 0 && my >= 0 && mx < lineageCanvas.width && my < lineageCanvas.height;
    if (moved < 4 && inside) {
      const id = lineageHitTestNode(mx, my);
      if (id > 0) { lineageView.selectedId = id; showLineagePopup(id, mx, my); }
      // Don't auto-close the popup on stray empty click — user can X/Esc.
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lineagePopup && lineagePopup.style.display !== 'none') {
      const active = document.activeElement;
      const tag = active && active.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      lineageView.selectedId = -1;
      hideLineagePopup();
    }
  });
}

// ---------- Edge tooltip ----------
function showLineageEdgeTooltip(edge, clientX, clientY) {
  if (!lineageEdgeTooltip) return;
  const child = lineage.nodes.get(edge.childId);
  const parent = lineage.nodes.get(edge.parentId);
  if (!child || !parent) return;
  const bytes = child.parentBytes ? (child.parentBytes[edge.parentIndex] || 0) : parent.length;
  const pct = parent.length > 0 ? (bytes / parent.length * 100).toFixed(1) : '—';
  lineageEdgeTooltip.innerHTML =
    `<b>#${parent.id} → #${child.id}</b><br>` +
    `bytes read: ${bytes} / ${parent.length} = ${pct}%<br>` +
    `child event: ${child.event}${edge.isMain ? '' : ' (secondary parent)'}<br>` +
    (child.parents.length > 1 ? `child has ${child.parents.length} parents` : '');
  lineageEdgeTooltip.style.display = 'block';
  lineageEdgeTooltip.style.left = (clientX + 14) + 'px';
  lineageEdgeTooltip.style.top = (clientY + 14) + 'px';
}
function hideLineageEdgeTooltip() { if (lineageEdgeTooltip) lineageEdgeTooltip.style.display = 'none'; }

// ---------- Popup (movable + resizable DNA inspector) ----------
function showLineagePopup(id, anchorX, anchorY) {
  if (!lineagePopup) return;
  const n = lineage.nodes.get(id);
  if (!n) { hideLineagePopup(); return; }

  const primary = n.primaryParentId > 0 ? lineage.nodes.get(n.primaryParentId) : null;
  const hash = '0x' + n.hashPrefix.toString(16).padStart(8, '0');
  const age = world.tick - n.birthTick;

  // Parent list w/ byte percentages.
  const parentRows = n.parents.map((pid, i) => {
    const p = lineage.nodes.get(pid);
    const len = p ? p.length : 0;
    const bytes = n.parentBytes ? (n.parentBytes[i] || 0) : len;
    const pct = len > 0 ? (bytes / len * 100).toFixed(1) : '—';
    const isPrimary = pid === n.primaryParentId;
    return `  <span style="color:#bbb;">${isPrimary ? '★' : ' '} <a href="#" class="lineage-parent-link" data-pid="${pid}" style="color:#8cf;">#${pid}</a> — ${bytes}/${len} = ${pct}%</span>`;
  }).join('\n');

  // Body has two regions:
  //   top:    one or two side-by-side panes (child / parent) — parent only when diff is on
  //   bottom: byte/decoded diff — only when diff is on AND primary exists
  // Diff toggle is sticky across navigation; see lineageDiffOpen.
  const showDiff = lineageDiffOpen && primary && primary.data;
  let dnaHtml = '';
  if (n.data) {
    dnaHtml += `<div style="display:flex; gap:8px; align-items:flex-start;">`;
    dnaHtml += `<div style="flex:1; min-width:0;">${renderDnaFull(n.data, `chromosome #${id}`, -1)}</div>`;
    if (showDiff) {
      dnaHtml += `<div style="flex:1; min-width:0; border-left:1px solid #2a2a2a; padding-left:8px;">${renderDnaFull(primary.data, `parent #${primary.id}`, -1)}</div>`;
    }
    dnaHtml += `</div>`;
    if (showDiff) {
      const common = Math.min(n.data.length, primary.data.length);
      let sameCount = 0;
      for (let i = 0; i < common; i++) if (n.data[i] === primary.data[i]) sameCount++;
      const samePct = common > 0 ? (sameCount / common * 100).toFixed(1) : '—';
      dnaHtml += `<div style="margin-top:8px;color:#888;">diff vs primary parent <a href="#" class="lineage-parent-link" data-pid="${primary.id}" style="color:#8cf;">#${primary.id}</a>: ${sameCount}/${common} bytes identical (${samePct}%)</div>`;
      dnaHtml += renderDnaDiff(n.data, primary.data);
    }
  }

  const hasHighlight = lineageHighlight.ids.size > 0;
  const clearBtn = hasHighlight
    ? `<button class="lineage-popup-highlight-clear" style="background:#422;color:#ddd;border:1px solid #844;padding:1px 6px;cursor:pointer;font-size:10px;">clear hl</button>`
    : '';
  const diffLabel = lineageDiffOpen ? 'hide diff' : 'show diff';
  const diffDisabled = !primary;
  const diffBtn =
    `<button class="lineage-popup-difftoggle" data-id="${id}"${diffDisabled ? ' disabled' : ''} ` +
    `style="background:${diffDisabled ? '#222' : '#234'};color:${diffDisabled ? '#555' : '#ddd'};border:1px solid ${diffDisabled ? '#333' : '#468'};padding:1px 6px;cursor:${diffDisabled ? 'default' : 'pointer'};font-size:10px;">${diffLabel}</button>`;
  const titleBar =
    `<div class="lineage-popup-title" style="cursor:move;padding:4px 8px;background:#223;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">` +
    `<b style="color:#8cf;">chromosome #${id}</b>` +
    `<span style="color:#888;">${n.event}${n.mergedCount ? ` (+${n.mergedCount} merged)` : ''}</span>` +
    `<span style="flex:1;"></span>` +
    `<button class="lineage-popup-highlight" data-id="${id}" data-mode="copies" style="background:#234;color:#ddd;border:1px solid #468;padding:1px 6px;cursor:pointer;font-size:10px;">highlight copies</button>` +
    `<button class="lineage-popup-highlight" data-id="${id}" data-mode="desc" style="background:#234;color:#ddd;border:1px solid #468;padding:1px 6px;cursor:pointer;font-size:10px;">+descendants</button>` +
    clearBtn +
    diffBtn +
    `<button class="lineage-popup-copy" data-id="${id}" style="background:#333;color:#ddd;border:1px solid #555;padding:1px 6px;cursor:pointer;font-size:10px;">copy hex</button>` +
    `<button class="lineage-popup-close" style="background:#333;color:#ddd;border:1px solid #555;padding:1px 6px;cursor:pointer;font-size:10px;">✕</button>` +
    `</div>`;

  const header =
    `<div style="padding:6px 8px;border-bottom:1px solid #333;">` +
    `<div>shape ${n.shape} · len ${n.length} · hash ${hash}</div>` +
    `<div>born tick ${n.birthTick} (age ${age})${n.alive ? ` · ${n.copies} live ${n.copies === 1 ? 'copy' : 'copies'}` : ' · dead at ' + n.deathTick} · ${n.copiesEver || 1} total appearances</div>` +
    `<div>descendants ever: ${n.descendantsEver}</div>` +
    (n.parents.length ? `<div style="margin-top:4px;">parents:</div><pre style="margin:0;white-space:pre-wrap;">${parentRows}</pre>` : `<div>parents: (root)</div>`) +
    `</div>`;

  lineagePopup.innerHTML = titleBar + header + `<div class="lineage-popup-body" style="padding:6px 8px;overflow:auto;flex:1;min-height:0;">${dnaHtml}</div>`;

  // Size & position defaults — only if popup is hidden so we don't stomp user-moved/resized state.
  const panel = document.getElementById('lineage-panel');
  const pr = panel.getBoundingClientRect();
  if (lineagePopup.style.display !== 'block') {
    lineagePopup.style.display = 'flex';
    lineagePopup.style.flexDirection = 'column';
    const initW = lineageDiffOpen ? Math.min(900, window.innerWidth - 60) : Math.min(520, window.innerWidth - 60);
    lineagePopup.style.width = initW + 'px';
    lineagePopup.style.height = Math.min(420, window.innerHeight - 60) + 'px';
    lineagePopup.style.left = Math.max(16, Math.min(window.innerWidth - initW - 20, pr.left + anchorX + 16)) + 'px';
    lineagePopup.style.top = Math.max(16, Math.min(window.innerHeight - 440, pr.top + anchorY + 16)) + 'px';
  }

  wireLineagePopupEvents();
}

function hideLineagePopup() {
  if (!lineagePopup) return;
  lineagePopup.style.display = 'none';
}

function wireLineagePopupEvents() {
  const close = lineagePopup.querySelector('.lineage-popup-close');
  if (close) close.addEventListener('click', () => { lineageView.selectedId = -1; hideLineagePopup(); });
  // Reopens the popup at its current on-screen position (so toggling highlight
  // buttons doesn't yank the popup back to the clicked node). anchorX/Y are
  // relative to the lineage panel rect — see the positioning block in showLineagePopup.
  const refreshInPlace = (id) => {
    const pr = lineagePopup.getBoundingClientRect();
    const panelRect = document.getElementById('lineage-panel').getBoundingClientRect();
    const ax = pr.left - panelRect.left - 16;
    const ay = pr.top - panelRect.top - 16;
    const prevDisplay = lineagePopup.style.display;
    lineagePopup.style.display = 'none'; // force reposition branch to re-run with our anchors
    showLineagePopup(id, ax, ay);
    if (prevDisplay) { /* reposition will have taken over */ }
  };
  for (const btn of lineagePopup.querySelectorAll('.lineage-popup-highlight')) {
    btn.addEventListener('click', () => {
      const id = +btn.dataset.id;
      const mode = btn.dataset.mode;
      if (!(id > 0)) return;
      if (mode === 'desc') setLineageHighlight(collectLineageDescendants(id));
      else setLineageHighlight(new Set([id]));
      refreshInPlace(id); // re-render so the "clear hl" button appears
    });
  }
  const diffBtn = lineagePopup.querySelector('.lineage-popup-difftoggle:not([disabled])');
  if (diffBtn) diffBtn.addEventListener('click', () => {
    lineageDiffOpen = !lineageDiffOpen;
    // Force a width adjustment ONCE on toggle so the user sees the expand/collapse.
    // Don't stomp user-resized widths during regular re-renders — we only run on click.
    const w = lineageDiffOpen
      ? Math.min(900, window.innerWidth - 60)
      : Math.min(520, window.innerWidth - 60);
    lineagePopup.style.width = w + 'px';
    refreshInPlace(+diffBtn.dataset.id);
  });
  const clearHl = lineagePopup.querySelector('.lineage-popup-highlight-clear');
  if (clearHl) clearHl.addEventListener('click', () => {
    clearLineageHighlight();
    const id = lineageView.selectedId;
    if (id > 0) refreshInPlace(id);
  });
  const copy = lineagePopup.querySelector('.lineage-popup-copy');
  if (copy) copy.addEventListener('click', () => {
    const id = +copy.dataset.id;
    const n = lineage.nodes.get(id);
    if (!n || !n.data) return;
    const hex = Array.from(n.data).map(b => b.toString(16).padStart(2, '0')).join(' ');
    navigator.clipboard.writeText(hex).then(() => {
      copy.textContent = 'copied!';
      setTimeout(() => { if (copy.isConnected) copy.textContent = 'copy hex'; }, 900);
    });
  });
  // Parent-jump links inside the popup.
  for (const a of lineagePopup.querySelectorAll('.lineage-parent-link')) {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const pid = +a.dataset.pid;
      if (lineage.nodes.has(pid)) {
        lineageView.selectedId = pid;
        const pos = lineageLayout.positions.get(pid);
        const r = lineagePopup.getBoundingClientRect();
        const panelRect = document.getElementById('lineage-panel').getBoundingClientRect();
        const axy = pos ? worldToScreenL(pos.x, pos.y) : { sx: r.left - panelRect.left, sy: r.top - panelRect.top };
        showLineagePopup(pid, axy.sx, axy.sy);
      }
    });
  }

  // Drag from the title bar.
  const title = lineagePopup.querySelector('.lineage-popup-title');
  if (title) makeDraggable(lineagePopup, title);
}

function makeDraggable(el, handle) {
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  handle.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect();
    ox = r.left; oy = r.top;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    el.style.left = (ox + (e.clientX - sx)) + 'px';
    el.style.top = (oy + (e.clientY - sy)) + 'px';
  });
  window.addEventListener('mouseup', () => { dragging = false; });
}

// Diff-render: two hex rows (child, primary parent), byte-aligned, with
// mismatches highlighted red. Reuses the PROTEIN_INFO tooltip hook.
function renderDnaDiff(childData, parentData) {
  const n = Math.max(childData.length, parentData.length);
  let childRow = '', parentRow = '';
  for (let i = 0; i < n; i++) {
    const cb = i < childData.length ? childData[i] : null;
    const pb = i < parentData.length ? parentData[i] : null;
    const cHex = cb === null ? '··' : cb.toString(16).padStart(2, '0');
    const pHex = pb === null ? '··' : pb.toString(16).padStart(2, '0');
    const mismatch = cb !== null && pb !== null && cb !== pb;
    const onlyInChild = cb !== null && pb === null;
    const onlyInParent = cb === null && pb !== null;
    const childColor = onlyInChild ? '#fa0' : (mismatch ? '#f66' : (cb === null ? '#444' : '#8c8'));
    const parentColor = onlyInParent ? '#fa0' : (mismatch ? '#fa6' : (pb === null ? '#444' : '#88a'));
    const cInfo = cb !== null ? getOpcodeInfo(cb) : { name: '—' };
    const pInfo = pb !== null ? getOpcodeInfo(pb) : { name: '—' };
    childRow += `<span class="dna-byte" style="color:${childColor};" data-tip="<span class='tip-title'>byte ${i} child 0x${cHex}</span>\n<span class='tip-desc'>${esc(cInfo.name)}</span>">${cHex}</span> `;
    parentRow += `<span class="dna-byte" style="color:${parentColor};" data-tip="<span class='tip-title'>byte ${i} parent 0x${pHex}</span>\n<span class='tip-desc'>${esc(pInfo.name)}</span>">${pHex}</span> `;
  }
  const hexBlock = `<div style="margin-top:6px;font-size:10px;line-height:1.4;"><div style="color:#888;">child</div><div style="word-break:break-all;">${childRow}</div><div style="color:#888;margin-top:4px;">parent</div><div style="word-break:break-all;">${parentRow}</div></div>`;

  // Decoded instruction diff: one row per aligned-by-offset instruction pair.
  // If the two decoded streams don't share the same offset sequence (insertion
  // / deletion / length mismatch), fall back to side-by-side blocks with no
  // per-line alignment.
  const cLines = decodeChromosome(childData);
  const pLines = decodeChromosome(parentData);
  const offsetsAlign = cLines.length === pLines.length
    && cLines.every((ln, i) => ln.off === pLines[i].off);

  const preStyle = 'font-size:10px;line-height:1.3;margin:2px 0;white-space:pre;color:#bbb;background:#0a0a0a;padding:4px;border:1px solid #222;border-radius:3px;overflow-x:auto;';
  let codeBlock = `<div style="color:#8cf;font-size:10px;margin-top:8px;">Decoded diff</div>`;

  if (offsetsAlign) {
    let childCode = '', parentCode = '';
    for (let i = 0; i < cLines.length; i++) {
      const cl = cLines[i], pl = pLines[i];
      const differ = cl.text !== pl.text;
      if (differ) {
        childCode += `<span style="color:#f66;">${esc(cl.text)}</span>\n`;
        parentCode += `<span style="color:#fa6;">${esc(pl.text)}</span>\n`;
      } else {
        childCode += `<span style="color:${cl.color};">${esc(cl.text)}</span>\n`;
        parentCode += `<span style="color:${pl.color};">${esc(pl.text)}</span>\n`;
      }
    }
    codeBlock += `<div style="display:flex;gap:8px;">` +
      `<div style="flex:1;min-width:0;"><div style="color:#888;font-size:10px;">child code</div><pre style="${preStyle}">${childCode}</pre></div>` +
      `<div style="flex:1;min-width:0;"><div style="color:#888;font-size:10px;">parent code</div><pre style="${preStyle}">${parentCode}</pre></div>` +
      `</div>`;
  } else {
    const renderLines = (lines) => lines.map(ln => `<span style="color:${ln.color};">${esc(ln.text)}</span>`).join('\n');
    codeBlock += `<div style="color:#888;font-size:10px;">offsets diverge — rendered independently</div>` +
      `<div style="display:flex;gap:8px;">` +
      `<div style="flex:1;min-width:0;"><div style="color:#888;font-size:10px;">child code</div><pre style="${preStyle}">${renderLines(cLines)}</pre></div>` +
      `<div style="flex:1;min-width:0;"><div style="color:#888;font-size:10px;">parent code</div><pre style="${preStyle}">${renderLines(pLines)}</pre></div>` +
      `</div>`;
  }

  return hexBlock + codeBlock;
}
