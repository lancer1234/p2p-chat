export class NostrManager {
  constructor(relayUrl = 'wss://nos.lol') { // 預設直接改用連線速度較快的 nos.lol
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
      // 修正點：顯式轉換私鑰型態，確保相容性
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
      // 修正點：用最安全、絕對不會引發 SyntaxError 的動態鍵值宣告方式
      const filter = {
        kinds: [4],
        authors: [friendPk]
      };
      filter['#p'] = [myPk]; // 安全地塞入 #p 標籤條件

      const sub = this.relay.sub([filter]);

      sub.on('event', (event) => {
        onMessageReceived(event.content);
      });

      return sub;
    } catch (e) {
      console.error("Nostr 訂閱失敗:", e);
      return null;
    }
  }
}
