export class NostrManager {
  constructor(relayUrl = 'wss://relay.damus.io') {
    this.relayUrl = relayUrl;
    this.relay = null;
    this.activeSubs = [];
  }

  async connect() {
    try {
      this.relay = window.NostrTools.relayInit(this.relayUrl);
      this.relay.on('connect', () => console.log(`🌐 成功直連 Nostr 骨幹信道: ${this.relayUrl}`));
      this.relay.on('error', () => console.error("Nostr 連接失敗"));
      await this.relay.connect();
    } catch (e) {
      console.error("Nostr 連線異常:", e);
    }
  }

  async sendEvent(mySk, friendPk, encryptedContent) {
    if (!this.relay || this.relay.status !== 1) return;

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
      console.log("🚀 加密信號已發射");
    } catch (e) {
      console.error("Nostr 發送失敗:", e);
    }
  }

  subscribeToFriend(myPk, friendPk, onMessageReceived) {
    if (!this.relay || this.relay.status !== 1) return null;

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

      this.activeSubs.push(sub);
      return sub;
    } catch (e) {
      console.error("Nostr 訂閱失敗:", e);
      return null;
    }
  }

  clearAllSubscriptions() {
    this.activeSubs.forEach(sub => {
      try { sub.unsub(); } catch(e) {}
    });
    this.activeSubs = [];
    console.log("🧹 已清空所有舊的 Nostr 訂閱監聽器");
  }
}
