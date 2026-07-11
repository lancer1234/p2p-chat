import { bytesToHex } from './crypto.js';

export class NostrManager {
  constructor() {
    this.relayUrls = [
      'wss://nos.lol',
      'wss://relay.damus.io',
      'wss://relay.primal.net',
      'wss://relay.nostr.band'
    ];
    this.relays = {};        // 💡 Singleton: 確保每個網域永遠只 new 一次
    this.activeRelays = [];  // 當前真正在線的連線池
    this.activeSubs = {};    
    this.seenEvents = new Set(); // 💡 【核心救星】：杜絕多個中繼站重複推送造成的信令碰撞
    this.lastPublishTimes = {};  // 💡 分流冷卻：依聯絡人公鑰實施節流鎖
  }

  async connect() {
    const self = this;
    const connectionPromises = this.relayUrls.map(function(url) {
      return new Promise(function(resolve) {
        try {
          // 💡 阻斷重複建立實體
          if (self.relays[url]) {
            if (self.relays[url].status === 1) {
              resolve(true);
              return;
            }
          }

          const relay = window.NostrTools.relayInit(url);
          self.relays[url] = relay;

          relay.on('connect', function() {
            if (!self.activeRelays.includes(relay)) {
              self.activeRelays.push(relay);
            }
            resolve(true);
          });

          // 💡 【100% 落實解綁】：一旦中繼站斷線或關閉，立刻從在線集線器中清空，防止殘留無效物件
          const removeRelayHandler = function() {
            self.activeRelays = self.activeRelays.filter(function(r) { return r !== relay; });
          };
          relay.on('disconnect', removeRelayHandler);
          relay.on('close', removeRelayHandler);

          relay.connect().catch(function() { resolve(false); });
        } catch(e) { resolve(false); }
      });
    });
    
    await Promise.all(connectionPromises);
    if (this.activeRelays.length === 0) {
      throw new Error("No secure relays connected");
    }
  }

  async sendEvent(mySk, friendPk, encryptedContent) {
    const now = Date.now();
    const lastTime = this.lastPublishTimes[friendPk] || 0;
    if (now - lastTime < 5000) {
        console.warn(`🛡️ 好友 ${friendPk.substring(0,6)} 通道冷卻中，避免觸發限流。`);
        return;
    }
    this.lastPublishTimes[friendPk] = now;

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
        try {
          const pub = relay.publish(event);
          // 💡 增加監聽，可在控制台精準掌握中繼站對信號的反饋狀態
          pub.on('ok', function() { console.log(`✅ 信號在 ${relay.url} 發射成功`); });
          pub.on('failed', function(reason) { console.warn(`❌ ${relay.url} 拒絕發射: ${reason}`); });
        } catch(err) {}
      });
    } catch (e) {
      console.error("發射模組異常", e);
    }
  }

  subscribeToFriend(myPk, friendPk, onMessageReceived) {
    this.unsubscribeFromFriend(friendPk);
    const connectedRelays = this.activeRelays.filter(function(r) { return r.status === 1; });
    if (connectedRelays.length === 0) return;

    // 💡 緊縮過濾器防禦網：在 any 模式下依然要求嚴格的 NIP-04 架構，減輕回呼負載
    const filter = { kinds: [4], '#p': [myPk] };
    if (friendPk !== 'any') filter.authors = [friendPk];

    const subsForThisFriend = [];
    const self = this;

    connectedRelays.forEach(function(relay) {
      try {
        const sub = relay.sub([filter]);
        sub.on('event', function(event) {
          // 💡 安全防禦：檢查事件完整性
          if (!event || !event.id || !event.content || !event.pubkey) return;

          // 💡 【終極防線】：如果別的中繼站已經處理過同一個事件 ID，立刻截斷，拒絕重複傳遞給 WebRTC
          if (self.seenEvents.has(event.id)) return;
          self.seenEvents.add(event.id);
          
          // 定期滾動清空 Set，防記憶體洩漏
          if (self.seenEvents.size > 2000) self.seenEvents.clear();

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
        try {
          if (typeof sub.unsub === 'function') sub.unsub();
          else if (typeof sub.close === 'function') sub.close();
        } catch(e) {}
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
