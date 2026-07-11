import { bytesToHex } from './crypto.js';

export class NostrManager {
  constructor() {
    // 🟢 替換為亞洲區握手穿透率最高、最不易被公司學校防火牆阻擋的 4 個全新備援節點
    this.relayUrls = [
      'wss://relay.wtf',
      'wss://pub.elftown.com',
      'wss://relay.current.fyi',
      'wss://no-str.org'
    ];
    this.relays = {};        
    this.activeRelays = [];  
    this.activeSubs = {};    
    this.seenEvents = new Set(); 
    this.lastPublishTimes = {};  
  }

  async connect() {
    const self = this;
    const connectionPromises = this.relayUrls.map(function(url) {
      return new Promise(function(resolve) {
        try {
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

    const filter = { kinds: [4], '#p': [myPk] };
    if (friendPk !== 'any') filter.authors = [friendPk];

    const subsForThisFriend = [];
    const self = this;

    connectedRelays.forEach(function(relay) {
      try {
        const sub = relay.sub([filter]);
        sub.on('event', function(event) {
          if (!event || !event.id || !event.content || !event.pubkey) return;
          if (self.seenEvents.has(event.id)) return;
          self.seenEvents.add(event.id);
          
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
