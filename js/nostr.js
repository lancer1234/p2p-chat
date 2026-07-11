export class NostrManager {
  // 💡 多重 Relay 池化備援：防範單點中繼站掛點導致服務停擺
  constructor() {
    this.relayUrls = [
      'wss://nos.lol',
      'wss://relay.snort.social',
      'wss://relay.damus.io',
      'wss://relay.primal.net'
    ];
    this.activeRelays = [];
    this.activeSubs = {}; 
  }

  async connect() {
    const connectionPromises = this.relayUrls.map(url => {
      return new Promise((resolve) => {
        const relay = window.NostrTools.relayInit(url);
        relay.on('connect', () => {
          console.log(`🌐 信令通道併發接通: ${url}`);
          this.activeRelays.push(relay);
          resolve(true);
        });
        relay.on('error', () => resolve(false));
        relay.connect().catch(() => resolve(false));
      });
    });

    // 只要有任何一個 Relay 連上，引路人機制就成功啟動
    const results = await Promise.all(connectionPromises);
    if (!results.some(r => r) && window.logDebug) {
      window.logDebug("❌ 全球信令矩陣連線失敗，請檢查網路環境");
    }
  }

  async sendEvent(mySk, friendPk, encryptedContent) {
    const connectedRelays = this.activeRelays.filter(r => r.status === 1);
    if (connectedRelays.length === 0) return;

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

      // 同步推播到所有存活的備援節點
      connectedRelays.forEach(relay => {
        relay.publish(event).catch(()=>{});
      });
    } catch (e) {
      console.error("信號擴散失敗", e);
    }
  }

  subscribeToFriend(myPk, friendPk, onMessageReceived) {
    this.unsubscribeFromFriend(friendPk);

    const connectedRelays = this.activeRelays.filter(r => r.status === 1);
    if (connectedRelays.length === 0) return;

    const filter = { kinds: [4], '#p': [myPk] };
    if (friendPk !== 'any') filter.authors = [friendPk];

    const subsForThisFriend = [];

    connectedRelays.forEach(relay => {
      try {
        const sub = relay.sub([filter]);
        sub.on('event', (event) => onMessageReceived(event.content, event.pubkey));
        subsForThisFriend.push(sub);
      } catch(e) {}
    });

    this.activeSubs[friendPk] = subsForThisFriend;
  }

  unsubscribeFromFriend(friendPk) {
    if (this.activeSubs[friendPk]) {
      this.activeSubs[friendPk].forEach(sub => {
        try { sub.unsub(); } catch(e) {}
      });
      delete this.activeSubs[friendPk];
      console.log(`🧹 物理退訂成功: ${friendPk.substring(0,8)}...`);
    }
  }

  clearAllSubscriptions() {
    Object.keys(this.activeSubs).forEach(friendPk => this.unsubscribeFromFriend(friendPk));
  }
}
