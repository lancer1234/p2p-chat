export class NostrManager {
  constructor(relayUrl = 'wss://relay.damus.io') { // 預設改用極速、自由、無 PoW 的公共 Damus 節點
    this.relayUrl = relayUrl;
    this.relay = null;
  }

  async connect() {
    try {
      this.relay = window.NostrTools.relayInit(this.relayUrl);
      this.relay.on('connect', () => console.log(`已連接至 Nostr: ${this.relayUrl}`));
      this.relay.on('error', () => console.error("Nostr 連接失敗"));
      await this.relay.connect();
    } catch (e) {
      console.error("Nostr 連線異常:", e);
    }
  }

  async sendEvent(mySk, friendPk, encryptedContent) {
    if (!this.relay) return;

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

      await this.relay.publish(event);
    } catch (e) {
      console.error("Nostr 發送失敗:", e);
    }
  }

  subscribeToFriend(myPk, friendPk, onMessageReceived) {
    if (!this.relay) return null;

    try {
      const filter = {
        kinds: [4],
        '#p': [myPk]
      };
      
      if (friendPk !== 'any') {
        filter.authors = [friendPk];
      }

      const sub = this.relay.sub([filter]);

      sub.on('event', (event) => {
        onMessageReceived(event.content, event.pubkey);
      });

      return sub;
    } catch (e) {
      console.error("Nostr 訂閱失敗:", e);
      return null;
    }
  }
}
