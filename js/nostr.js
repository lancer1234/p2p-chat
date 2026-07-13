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

  async connect(onStatusChange, onAnyRelayConnected) {
    const self = this;
    
    const connectionPromises = this.relayUrls.map(function(url, index) {
      return new Promise(async function(resolve) {
        try {
          const r = await self.pool.ensureRelay(url);
          if (r) {
            self.connectedRelaysStatus[index] = true;
            if (onStatusChange) onStatusChange(index, true);
            // 💡 只要有任一軌接通，立刻回傳驅動 READY 狀態
            if (onAnyRelayConnected) onAnyRelayConnected();
            resolve(true);
          } else {
            self.connectedRelaysStatus[index] = false;
            if (onStatusChange) onStatusChange(index, false);
            resolve(false);
          }
        } catch(e) {
          console.error(`🔒 [SimplePool Checked Fail] 節點 ${url}:`, e);
          self.connectedRelaysStatus[index] = false;
          if (onStatusChange) onStatusChange(index, false);
          resolve(false);
        }
      });
    });

    await Promise.all(connectionPromises);
    await new Promise(function(resolve) { setTimeout(resolve, 600); });
    
    // 💡 修正點 1 的核心邏輯：只要在線池裡有任何一軌是通的，就視為基礎信令功能完好，不丟 Error 攔截
    const anyAlive = self.connectedRelaysStatus.some(function(v) { return v === true; });
    if (anyAlive) {
        if (onAnyRelayConnected) onAnyRelayConnected();
    } else {
        throw new Error("全球信令矩陣目前全數斷連。");
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

      const pubs = this.pool.publish(liveUrls, event);
      if (pubs && typeof pubs.then === 'function') {
          pubs.then(function() { console.log("🚀 [Pool Matrix] 信號完成全網擴散投遞"); })
              .catch(function(err) { console.warn("⚠️ [Pool Matrix] 部分節點拒絕投遞", err); });
      } else if (Array.isArray(pubs)) {
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
    this.currentSub = this.pool.sub(liveUrls, [filter]);
    
    this.currentSub.on('event', function(event) {
       if (!event || !event.id || !event.content || !event.pubkey) return;
       if (self.seenEvents.has(event.id)) return;
       self.seenEvents.add(event.id);
       if (self.seenEvents.size > 2000) self.seenEvents.clear();

       onMessageReceived(event.content, event.pubkey);
    });

    this.currentSub.on('eose', function() {
        console.log("📋 [Nostr EOSE] 信號快取同步完畢。");
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
