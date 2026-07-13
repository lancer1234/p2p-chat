import { bytesToHex } from './crypto.js';

export class NostrManager {
  constructor() {
    this.relayUrls = [
      'wss://nos.lol',
      'wss://relay.damus.io',
      'wss://relay.primal.net',
      'wss://relay.nostr.band'
    ];
    // 💡 擁抱現代架構：全權委託 SimplePool 管理連線池，不 new 單一 Relay 實體，不註冊 EventEmitter
    this.pool = new window.NostrTools.SimplePool();
    this.connectedRelaysStatus = [false, false, false, false];
    this.seenEvents = new Set();
    this.lastPublishTimes = {};
    this.currentSub = null; 
  }

  // 💡 100% 落實修改：不靠隨機異步的事件觸發，改用純粹的 Promise 探針校驗連線可用性
  async connect(onStatusChange) {
    const self = this;
    
    const connectionPromises = this.relayUrls.map(function(url, index) {
      return new Promise(async function(resolve) {
        try {
          // ensureRelay 是現代池化標準 API：成功握手即返回 AbstractRelay，失敗直接丟 Exception
          const r = await self.pool.ensureRelay(url);
          
          if (r) {
            // 只要能成功取回實體，代表該節點通道健康可用
            self.connectedRelaysStatus[index] = true;
            if (onStatusChange) onStatusChange(index, true); // 🟢 UI 亮綠燈
            resolve(true);
          } else {
            self.connectedRelaysStatus[index] = false;
            if (onStatusChange) onStatusChange(index, false);
            resolve(false);
          }
        } catch(e) {
          // 💡 100% 不吞沒 Exception：回顯所有中繼站遭拒的細節
          console.error(`🔒 [SimplePool Tunnel Checked Fail] 節點 ${url}:`, e);
          self.connectedRelaysStatus[index] = false;
          if (onStatusChange) onStatusChange(index, false);
          resolve(false);
        }
      });
    });

    // 併發投遞探針
    await Promise.all(connectionPromises);
    
    // 檢查是否有至少一軌存活
    const anyAlive = self.connectedRelaysStatus.some(function(v) { return v === true; });
    if (!anyAlive) {
        throw new Error("全球信令矩陣目前全數斷連，請更換網路環境。");
    }
  }

  async sendEvent(mySk, friendPk, encryptedContent) {
    const now = Date.now();
    const lastTime = this.lastPublishTimes[friendPk] || 0;
    if (now - lastTime < 5000) return;
    this.lastPublishTimes[friendPk] = now;

    // 動態篩選當前對外可用的中繼矩陣
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

      // 💡 100% 修正 API 相容性：不使用 .on() 事件監聽。直接投遞，SimplePool 會自動以多重 Promise 管理 ACK
      const pubs = this.pool.publish(liveUrls, event);
      
      if (pubs && typeof pubs.then === 'function') {
          // v2 Promise 結構
          pubs.then(function() { console.log("🚀 [Pool Matrix] 信號完成全網擴散投遞"); })
              .catch(function(err) { console.warn("⚠️ [Pool Matrix] 部分節點拒絕投遞", err); });
      } else if (Array.isArray(pubs)) {
          // Promise 陣列結構
          Promise.all(pubs).then(function() { console.log("🚀 [Pool Matrix Array] 併發投遞完畢"); })
                           .catch(function(err) { console.error(err); });
      } else {
          console.log("🚀 [Pool Forward] 信號已推播至資料串流池");
      }
    } catch (e) {
      console.error("SimplePool 發射端嚴重異常:", e);
    }
  }

  subscribeToFriend(myPk, friendPk, onMessageReceived) {
    this.unsubscribeFromFriend();

    const liveUrls = this.relayUrls.filter((url, idx) => this.connectedRelaysStatus[idx]);
    if (liveUrls.length === 0) return;

    const filter = { kinds: [4], '#p': [myPk] };
    if (friendPk !== 'any') filter.authors = [friendPk];

    const self = this;
    
    // 💡 100% 修正：採用多中繼站合併訂閱（SimplePool.sub），自動在底層進行事件去重聚合
    this.currentSub = this.pool.sub(liveUrls, [filter]);
    
    this.currentSub.on('event', function(event) {
       if (!event || !event.id || !event.content || !event.pubkey) return;
       
       // 內建雙重防線去重
       if (self.seenEvents.has(event.id)) return;
       self.seenEvents.add(event.id);
       if (self.seenEvents.size > 2000) self.seenEvents.clear();

       onMessageReceived(event.content, event.pubkey);
    });

    // 💡 健全訂閱生命週期
    this.currentSub.on('eose', function() {
        console.log("📋 [Nostr EOSE] 信號快取載入完畢，進入監聽。");
    });
  }

  unsubscribeFromFriend() {
    if (this.currentSub) {
      try {
        if (typeof this.currentSub.unsub === 'function') this.currentSub.unsub();
        else if (typeof this.currentSub.close === 'function') this.currentSub.close();
      } catch(e) {}
      this.currentSub = null;
    }
  }

  clearAllSubscriptions() {
    this.unsubscribeFromFriend();
  }
}
