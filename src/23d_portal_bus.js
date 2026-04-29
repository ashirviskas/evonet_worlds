// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Matas Minelga
// ============================================================
// PORTAL BUS — BroadcastChannel comms for the multiverse.
// ============================================================
// Same-origin pub/sub between tabs of poc.html. All multiverse-scoped traffic
// flows through this single channel: world discovery (whois/iam/bye), cell
// portal-eject events, and the lazy lineage request/fill protocol. We do
// nothing here beyond plumbing — the actual handler bodies live in
// 23c_multiverse.js (identity/discovery) and 23e_portal_lineage.js (cell +
// lineage transport). BroadcastChannel does not deliver the sender's own
// messages back to itself, so no self-filter is needed.
// ============================================================

const portalBus = {
  channel: null,
  // Idempotency: msgIds we've already processed. Bounded by tick-based prune
  // every CONFIG.portalHeartbeatTicks to avoid unbounded growth.
  seenMsgIds: new Set(),
  seenMsgIdsList: [],   // FIFO ring for cheap prune
  seenMsgIdsCap: 4096,
};

function portalBusOpen() {
  if (portalBus.channel) return;
  if (typeof BroadcastChannel === 'undefined') {
    console.warn('BroadcastChannel unavailable — multiverse disabled.');
    return;
  }
  portalBus.channel = new BroadcastChannel('evonet-multiverse');
  portalBus.channel.onmessage = (ev) => _portalBusDispatch(ev.data);
}

function portalBusSend(msg) {
  if (!portalBus.channel) return;
  if (!msg.msgId) msg.msgId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  try {
    portalBus.channel.postMessage(msg);
  } catch (e) {
    console.warn('portalBusSend failed:', e, msg.type);
  }
}

function _portalBusSeen(msgId) {
  if (!msgId) return false;
  if (portalBus.seenMsgIds.has(msgId)) return true;
  portalBus.seenMsgIds.add(msgId);
  portalBus.seenMsgIdsList.push(msgId);
  if (portalBus.seenMsgIdsList.length > portalBus.seenMsgIdsCap) {
    const drop = portalBus.seenMsgIdsList.shift();
    portalBus.seenMsgIds.delete(drop);
  }
  return false;
}

function _portalBusDispatch(m) {
  if (!m || !m.type || m.srcWorldUuid === world.uuid) return;
  // Per-message-type targeting check happens in handlers; whois/iam/bye are
  // always-broadcast.
  switch (m.type) {
    case 'whois':
      // Reply with our current iam — only if we've already placed ourselves.
      // (If we're still booting, the requester will see us via its own
      // boot-time scan window or our subsequent heartbeat.)
      if (world.multiverseReady) {
        portalBusSend({
          type: 'iam',
          srcWorldUuid: world.uuid,
          mx: world.multiverseX,
          my: world.multiverseY,
          color: world.color,
        });
      }
      break;
    case 'iam':
      multiverseObserveIam(m.srcWorldUuid, m.mx, m.my, m.color);
      break;
    case 'bye':
      multiverseObserveBye(m.srcWorldUuid);
      break;
    case 'portal-eject':
      if (m.dstWorldUuid !== world.uuid) return;
      if (_portalBusSeen(m.msgId)) return;
      catchJumper(m);
      break;
    case 'portal-lineage-request':
      if (m.dstWorldUuid !== world.uuid) return;
      if (_portalBusSeen(m.msgId)) return;
      replyLineageFill(m);
      break;
    case 'portal-lineage-fill':
      if (m.dstWorldUuid !== world.uuid) return;
      if (_portalBusSeen(m.msgId)) return;
      mergeLineageFill(m);
      break;
    default:
      // Unknown type — ignore. Forward-compat with future message types.
      break;
  }
}
