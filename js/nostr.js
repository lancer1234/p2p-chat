import { bytesToHex } from './crypto.js';

export class NostrManager {
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
        try {
          const relay = window.NostrTools.relayInit(url);
          relay.on('connect', () => {
            this.activeRelays.push(relay);
            resolve(true);
          });
          relay.on('error', () => resolve(false));
          relay.connect().catch(() => resolve(false));
        } catch(e) { resolve(false); }
      });
    });
    await Promise.all(connectionPromises);
  }

  async sendEvent(mySk, friendPk, encryptedContent) {
    const connectedRelays = this.activeRelays.filter(r => r.status === 1);
    if (connectedRelays.length === 0) return;

    try {
      // 🟢 修正：完全阻斷對新舊版金鑰轉換 API 的依賴，相容二代結構
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

      connectedRelays.forEach(relay => {
        try { relay.publish(event); } catch(err) {}
      });
    } catch (e) {
      console.error("廣播失敗", e);
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
    }
  }

  clearAllSubscriptions() {
    Object.keys(this.activeSubs).forEach(friendPk => this.unsubscribeFromFriend(friendPk));
  }
}
