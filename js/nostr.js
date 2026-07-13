import { bytesToHex } from './crypto.js';

export class NostrManager {
  constructor() {
    this.relayUrls = [
      'wss://nos.lol',
      'wss://relay.damus.io',
      'wss://relay.primal.net',
      'wss://relay.nostr.band'
    ];
    this.relays = {};        
    this.activeRelays = [];  
    this.activeSubs = {};    
    this.seenEvents = new Set(); 
    this.lastPublishTimes = {};  
  }

  // 💡 升級：傳入動態更新 UI 燈號的回呼函式 (onStatusChange)
  async connect(onStatusChange) {
    const self = this;
    const connectionPromises = this.relayUrls.map(function(url, index) {
      return new Promise(function(resolve) {
        try {
          if (self.relays[url] && self.relays[url].status === 1) {
            if (onStatusChange) onStatusChange(index, true);
            resolve(true);
            return;
          }

          const relay = window.NostrTools.relayInit(url);
          self.relays[url] = relay;

          relay.on('connect', function() {
            if (!self.activeRelays.includes(relay)) {
              self.activeRelays.push(relay);
            }
            if (onStatusChange) onStatusChange(index, true); // 🟢 亮綠燈
            resolve(true);
          });

          const removeRelayHandler = function() {
            self.activeRelays = self.activeRelays.filter(function(r) { return r !== relay; });
            if (onStatusChange) onStatusChange(index, false); // 🔴 亮紅燈
          };
          relay.on('disconnect', removeRelayHandler);
          relay.on('close', removeRelayHandler);

          relay.connect().catch(function() { 
            if (onStatusChange) onStatusChange(index, false);
            resolve(false); 
          });
        } catch(e) { 
          if (onStatusChange) onStatusChange(index, false);
          resolve(false); 
        }
      });
    });
    
    await Promise.all(connectionPromises);
  }

  async sendEvent(mySk, friendPk, encryptedContent) {
    const now = Date.now();
    const lastTime = this.lastPublishTimes[friendPk] || 0;
    if (now - lastTime < 5000) {
        console.warn(`🛡️ 狀態鎖定：發射頻率冷卻中。`);
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
          pub.on('failed', function(reason) { console.warn(`❌ ${relay.url} 拒絕: ${reason}`); });
        } catch(err) {}
      });
    } catch (e) { console.error(e); }
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
