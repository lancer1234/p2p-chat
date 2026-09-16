// Direct P2P first. TURN is requested only after the user enables Relay.
// Metered secrets stay in the Worker.

export const APP_CONFIG = {
  turnBackendUrl: 'https://p2p-chat-turn.danny950811.workers.dev/api/turn-credentials',

  stunIceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ],

  peerAttemptTimeoutMs: 30000,
  disconnectedGraceMs: 8000,
  reconnectBaseDelayMs: 1500,
  reconnectMaxDelayMs: 15000,
  relayHealthIntervalMs: 20000,

  // Do not reuse TURN credentials near expiry.
  turnRefreshSafetyMs: 5 * 60 * 1000,

  signalingMaxAgeMs: 120000,
  signalingQueueGapMs: 120,
  relaySubscribeLookbackSec: 15
};
