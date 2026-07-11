export class NostrManager {
  constructor(relayUrl = 'wss://nos.lol') {
    this.relayUrl = relayUrl;
    this.relay = null;
    this.activeSubs = {}; // 💡 改用物件儲存，key 為 friendPk，方便精準退訂
  }

  async connect() {
    try {
      this.relay = window.NostrTools.relayInit(this.relayUrl);
      this.relay.on('connect', () => {
        const logMsg = `🌐 信令通道已接通: ${this.relayUrl}`;
        console.log(logMsg);
        if (window.logDebug) window.logDebug(logMsg);
      });
      this.relay.on('error', () => {
        if (window.logDebug) window.logDebug("❌ Nostr 中繼站連線失敗");
      });
      await this.relay.connect();
    } catch (e) {
      if (window.logDebug) window.logDebug(`❌ Nostr 異常: ${e.message}`);
    }
  }

  async sendEvent(mySk, friendPk, encryptedContent) {
    if (!this.relay || this.relay.status !== 1) {
      if (window.logDebug) window.logDebug("⚠️ 無法發射信號：中繼站尚未連線");
      return;
    }

    try {
      const hexSk = typeof mySk === 'string' ? mySk : window.NostrTools.bytesToHex(mySk);
      const event = {
        kind: 4,
        pubkey: window.NostrTools.getPublicKey(hexSk),
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', friendPk]],
        content: encryptedContent
      };

      event.id = window.NostrTools.getEventHash(event);
      event.sig = window.NostrTools.getSignature(event, hexSk);

      await this.relay.publish(event);
      if (window.logDebug) window.logDebug("🚀 信號已成功推播至 Nostr 廣播網");
    } catch (e) {
      if (window.logDebug) window.logDebug(`❌ 信號發射失敗: ${e.message}`);
    }
  }

  subscribeToFriend(myPk, friendPk, onMessageReceived) {
    if (!this.relay || this.relay.status !== 1) return null;

    // 💡 如果該 PK 已經有訂閱了，先退訂，避免重複監聽打架
    this.unsubscribeFromFriend(friendPk);

    try {
      const filter = {
        kinds: [4],
        '#p': [myPk]
      };
      
      if (friendPk !== 'any') {
        filter.authors = [friendPk];
      }

      const sub = this.relay.sub([filter]);
      sub.on('event', (event) => {
        onMessageReceived(event.content, event.pubkey);
      });

      this.activeSubs[friendPk] = sub; // 💡 紀錄此好友的訂閱實體
      return sub;
    } catch (e) {
      console.error("Nostr 訂閱失敗:", e);
      return null;
    }
  }

  // 💡 【大絕招】精準斬斷特定朋友的背景監聽，徹底防止舊訊息借屍還魂
  unsubscribeFromFriend(friendPk) {
    if (this.activeSubs[friendPk]) {
      try {
        this.activeSubs[friendPk].unsub();
        console.log(`🧹 已精準退訂舊好友監聽: ${friendPk.substring(0,8)}...`);
      } catch(e) {}
      delete this.activeSubs[friendPk];
    }
  }

  clearAllSubscriptions() {
    Object.keys(this.activeSubs).forEach(friendPk => {
      try { this.activeSubs[friendPk].unsub(); } catch(e) {}
    });
    this.activeSubs = {};
    console.log("🧹 已物理抹除所有 Nostr 監聽器");
  }
}
