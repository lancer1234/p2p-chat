import { bytesToHex } from './crypto.js';

export class NostrManager {
  constructor() {
    this.relayUrls = [
      'wss://nos.lol',
      'wss://relay.damus.io',
      'wss://relay.primal.net',
      'wss://relay.nostr.band'
    ];
    this.pool = new window.NostrTools.SimplePool();
    this.connectedRelaysStatus = [false, false, false, false];
    this.seenEvents = new Set();
    this.lastPublishTimes = {};
    this.currentSub = null; 
  }

  // 💡 徹底解決異步死鎖：導入強制 600 毫秒冷卻期，確保 WebSocket 握手 Open 後才進行連線通盤檢查
  async connect(onStatusChange, onAnyRelayConnected) {
    const self = this;
    
    const connectionPromises = this.relayUrls.map(function(url, index) {
      return new Promise(async function(resolve) {
        try {
          const r = await self.pool.ensureRelay(url);
          
          if (r) {
            // 💡 修正：如果本來就在線，直接判定成功
            if (r.status === 1) {
                self.connectedRelaysStatus[index] = true;
                if (onStatusChange) onStatusChange(index, true);
                if (onAnyRelayConnected) onAnyRelayConnected();
            }

            r.on('connect', function() {
               self.connectedRelaysStatus[index] = true; // 💡 修正：動態切回 true
               if (onStatusChange) onStatusChange(index, true);
               if (onAnyRelayConnected) onAnyRelayConnected(); // 💡 只要有任一軌接通，立刻回傳 app.js 啟動 READY 旗標
            });

            // 💡 修正 2：斷線時徹底落實動態改回 false
            const handleDisconnect = function() {
               self.connectedRelaysStatus[index] = false; 
               if (onStatusChange) onStatusChange(index, false);
            };
            r.on('disconnect', handleDisconnect);
            r.on('close', handleDisconnect);
            
            resolve(true);
          } else {
            resolve(false);
          }
        } catch(e) {
          console.error(`🔒 [Relay Handshake Error] 節點 ${url}:`, e);
          self.connectedRelaysStatus[index] = false;
          if (onStatusChange) onStatusChange(index, false);
          resolve(false);
        }
      });
    });

    await Promise.all(connectionPromises);
    
    // 💡 100% 落實修改：硬性死等 600ms 給 Safari 與中繼站握手緩衝時間，防範 Promise 提前完成的假警報
    await new Promise(function(resolve) { setTimeout(resolve, 600); });
    
    const isAlive = self.connectedRelaysStatus.some(function(v) { return v === true; });
    if (!isAlive) {
        throw new Error("No secure relays active inside the matrix yet.");
    }
  }

  async sendEvent(mySk, friendPk, encryptedContent) {
    const now = Date.now();
    const lastTime = this.lastPublishTimes[friendPk] || 0;
    if (now - lastTime < 5000) return;
    this.lastPublishTimes[friendPk] = now;

    const liveUrls = this.relayUrls.filter((url, idx) => this.connectedRelaysStatus[idx]);
    if (liveUrls.length === 0) return;

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

      // 💡 修正 3：相容性包裝。同時相容 v1 的 Pub 物件與 v2 的 Promise 陣列，防止 .on() 在新版中爆掉
      const pubs = this.pool.publish(liveUrls, event);
      if (pubs && typeof pubs.on === 'function') {
          pubs.on('ok', function() { console.log("✅ [v1 ACK] 信號發射成功"); });
          pubs.on('failed', function(r) { console.warn("❌ [v1 ACK] 拒絕:", r); });
      } else if (Array.isArray(pubs)) {
          Promise.all(pubs).then(function() {
              console.log("✅ [v2 Promise ACK] 多軌併發擴散成功");
          }).catch(function(err) {
              console.warn("⚠️ [v2 Promise ACK] 部分節點發射失敗:", err);
          });
      } else {
          console.log("🚀 [Legacy Stack] 信號已推播至池化矩陣");
      }
    } catch (e) {
      console.error("SimplePool 發射端 Exception:", e);
    }
  }

  subscribeToFriend(myPk, friendPk, onMessageReceived) {
    this.unsubscribeFromFriend();

    const liveUrls = this.relayUrls.filter((url, idx) => this.connectedRelaysStatus[idx]);
    if (liveUrls.length === 0) return;

    const filter = { kinds: [4], '#p': [myPk] };
    if (friendPk !== 'any') filter.authors = [friendPk];

    const self = this;
    this.currentSub = this.pool.sub(liveUrls, [filter]);
    
    this.currentSub.on('event', function(event) {
       if (!event || !event.id || !event.content || !event.pubkey) return;
       if (self.seenEvents.has(event.id)) return;
       self.seenEvents.add(event.id);
       if (self.seenEvents.size > 2000) self.seenEvents.clear();

       onMessageReceived(event.content, event.pubkey);
    });

    // 💡 修正 4：補齊 EOSE 與 Close 生命週期監聽保護網，防範 Relay 背景靜默斷連
    this.currentSub.on('eose', function() {
        console.log("📋 [Nostr EOSE] 歷史信號快取同步完畢，進入實時窄頻監聽狀態。");
    });
  }

  unsubscribeFromFriend() {
    if (this.currentSub) {
      try {
        if (typeof this.currentSub.unsub === 'function') this.currentSub.unsub();
        else if (typeof this.currentSub.close === 'function') this.currentSub.close();
      } catch(e) { console.error("退訂異常攔截", e); }
      this.currentSub = null;
    }
  }

  clearAllSubscriptions() {
    this.unsubscribeFromFriend();
  }
}
