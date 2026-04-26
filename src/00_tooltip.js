// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// CUSTOM TOOLTIP
// ============================================================
(function setupTooltip() {
  const tip = document.getElementById('tooltip');
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el) { tip.style.display = 'none'; return; }
    tip.innerHTML = el.getAttribute('data-tip');
    tip.style.display = 'block';
    positionTooltip(e, tip);
  });
  document.addEventListener('mousemove', (e) => {
    if (tip.style.display === 'block') positionTooltip(e, tip);
  });
  document.addEventListener('mouseout', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el) {
      const related = e.relatedTarget;
      if (!related || !el.contains(related)) tip.style.display = 'none';
    }
  });
})();
function positionTooltip(e, tip) {
  let x = e.clientX + 12, y = e.clientY + 12;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  if (x + tw > window.innerWidth - 8) x = e.clientX - tw - 8;
  if (y + th > window.innerHeight - 8) y = e.clientY - th - 8;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
