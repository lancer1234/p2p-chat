// P2P Chat 網路設定（GitHub Pages + Cloudflare Worker）
//
// 安全模型：
// 1. 預設只允許 DIRECT P2P。
// 2. Direct P2P 失敗時，只有使用者主動按下「使用加密 Relay」才向 Worker 要求 TURN。
// 3. Metered Secret Key 永遠只存在 Cloudflare Worker Secret，不會出現在 GitHub Pages 或瀏覽器。

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

  // Worker 產生 4 小時 credentials；前端在接近到期前不重用。
  turnRefreshSafetyMs: 5 * 60 * 1000,

  signalingMaxAgeMs: 120000,
  signalingQueueGapMs: 120,
  relaySubscribeLookbackSec: 15
};
