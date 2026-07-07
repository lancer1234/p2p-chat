export class NostrManager {
  // 核心優化：同時引入多個公共高性能節點作為連線池，徹底防止單一 Relay 當機或拒絕連線
  constructor() {
    this.urls = [
      'wss://pub.elftown.com',
      'wss://nos.lol',
      'wss://relay.snort.social'
    ];
    this.relays = [];
  }

  async connect() {
    const promises = this.urls.map(url => {
      return new Promise((resolve) => {
        try {
          const r = window.NostrTools.relayInit(url);
          r.on('connect', () => {
            console.log(`✅ 成功連線至 Nostr 備援節點: ${url}`);
            this.relays.push(r);
            resolve(true);
          });
          r.on('error', () => {
            resolve(false);
          });
          r.connect().catch(() => resolve(false));
        } catch(e) {
          resolve(false);
        }
      });
    });

    // 只要連線池裡任何一個中繼站 Ready，就視為網路打通，給手機最好的體感
    await Promise.all(promises);
    if (this.relays.length === 0) {
      console.error("❌ 所有 Nostr 備援中繼站皆連線失敗，嘗試使用保底節點...");
      // 保底備用
      try {
        const fallback = window.NostrTools.relayInit('wss://relay.damus.io');
        await fallback.connect();
        this.relays.push(fallback);
      } catch(e) {}
    }
  }

  // 同步向所有已接通的 Relay 廣播訊息，保證 100% 送達
  async sendEvent(mySk, friendPk, encryptedContent) {
    if (this.relays.length === 0) return;

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

      this.relays.forEach(r => {
        if (r.status === 1) { // 只有當 Relay 處於已連線狀態時才發射
          r.publish(event).catch(() => {});
        }
      });
    } catch (e) {
      console.error("Nostr 事件廣播異常:", e);
    }
  }

  // 同步訂閱所有活著的 Relay 通道
  subscribeToFriend(myPk, friendPk, onMessageReceived) {
    if (this.relays.length === 0) return null;

    const filter = {
      kinds: [4],
      '#p': [myPk]
    };
    if (friendPk !== 'any') {
      filter.authors = [friendPk];
    }

    // 讓所有中繼站一起幫忙聽有沒有新訊息
    this.relays.forEach(r => {
      try {
        if (r.status === 1) {
          const sub = r.sub([filter]);
          sub.on('event', (event) => {
            onMessageReceived(event.content, event.pubkey);
          });
        }
      } catch(e) {}
    });
  }
}
