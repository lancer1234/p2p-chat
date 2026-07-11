import { bytesToHex } from './crypto.js';

export class NostrManager {
  constructor() {
    // 🟢 汰換斷線的 snort，改用 2026 最穩定的四大核心骨幹節點
    this.relayUrls = [
      'wss://nos.lol',
      'wss://relay.damus.io',
      'wss://relay.primal.net',
      'wss://relay.nostr.band'
    ];
    this.activeRelays = [];
    this.activeSubs = {}; 
    this.lastPublishTime = 0; // 💡 建立密碼學信號發射防護鎖
  }

  async connect() {
    const self = this;
    const connectionPromises = this.relayUrls.map(function(url) {
      return new Promise(function(resolve) {
        try {
          const relay = window.NostrTools.relayInit(url);
          relay.on('connect', function() {
            self.activeRelays.push(relay);
            resolve(true);
          });
          relay.on('error', function() { resolve(false); });
          relay.connect().catch(function() { resolve(false); });
        } catch(e) { resolve(false); }
      });
    });
    await Promise.all(connectionPromises);
  }

  async sendEvent(mySk, friendPk, encryptedContent) {
    // 💡 【100% 落實保護】：限制中中繼站發射冷卻，防止高頻踩踏踩中 Rate Limit
    const now = Date.now();
    if (now - this.lastPublishTime < 4000) {
        console.warn("🛡️ 觸發信號防護鎖：發射過於頻繁，就地實施防禦性丟棄。");
        return;
    }
    this.lastPublishTime = now;

    const connectedRelays = this.activeRelays.filter(function(r) { return r.status === 1; });
    if (connectedRelays.length === 0) return;

    try {
      const hexSk = typeof mySk === 'string' ? mySk : bytesToHex(mySk);
      const event = {
        kind: 4,
        pubkey: window.NostrTools.getPublicKey(hexSk),
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', friendPk]],
        content: encryptedContent
      };

      event.id = window.NostrTools.getEventHash(event);
      event.sig = window.NostrTools.getSignature(event, hexSk);

      connectedRelays.forEach(function(relay) {
        try { relay.publish(event); } catch(err) {}
      });
    } catch (e) {
      console.error("廣播失敗", e);
    }
  }

  subscribeToFriend(myPk, friendPk, onMessageReceived) {
    this.unsubscribeFromFriend(friendPk);
    const connectedRelays = this.activeRelays.filter(function(r) { return r.status === 1; });
    if (connectedRelays.length === 0) return;

    const filter = { kinds: [4], '#p': [myPk] };
    if (friendPk !== 'any') filter.authors = [friendPk];

    const subsForThisFriend = [];
    connectedRelays.forEach(function(relay) {
      try {
        const sub = relay.sub([filter]);
        sub.on('event', function(event) {
          onMessageReceived(event.content, event.pubkey);
        });
        subsForThisFriend.push(sub);
      } catch(e) {}
    });

    this.activeSubs[friendPk] = subsForThisFriend;
  }

  unsubscribeFromFriend(friendPk) {
    if (this.activeSubs[friendPk]) {
      this.activeSubs[friendPk].forEach(function(sub) {
        try { sub.unsub(); } catch(e) {}
      });
      delete this.activeSubs[friendPk];
    }
  }

  clearAllSubscriptions() {
    const self = this;
    Object.keys(this.activeSubs).forEach(function(friendPk) {
      self.unsubscribeFromFriend(friendPk);
    });
  }
}
