import { windowNostrTools } from 'https://unpkg.com/nostr-tools/lib/nostr.bundle.js';

export class NostrManager {
  constructor(relayUrl = 'wss://relay.damus.io') {
    this.relayUrl = relayUrl;
    this.relay = null;
  }

  // 1. 初始化並連線到 Nostr 中繼站
  async connect() {
    this.relay = windowNostrTools.relayInit(this.relayUrl);
    this.relay.on('connect', () => console.log(`已成功連接至 Nostr Relay: ${this.relayUrl}`));
    this.relay.on('error', () => console.error(`無法連接至 Nostr Relay: ${this.relayUrl}`));
    await this.relay.connect();
  }

  // 2. 發送加密事件到中繼站 (Kind 4 代表加密私訊)
  async sendEvent(mySk, friendPk, encryptedContent) {
    if (!this.relay) return console.error("Relay 未連線");

    const event = {
      kind: 4,
      pubkey: windowNostrTools.getPublicKey(mySk),
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', friendPk]], // 標記接收者的公鑰
      content: encryptedContent // 這裡傳入的是已經被 crypto.js 加密過的亂碼
    };

    // 計算雜湊值並用私鑰簽章，證明是本人發的
    event.id = windowNostrTools.getEventHash(event);
    event.sig = windowNostrTools.getSignature(event, mySk);

    // 發布到網路上
    await this.relay.publish(event);
    console.log("信令事件已發送至 Nostr 網路");
  }

  // 3. 監聽（訂閱）來自特定好友的訊息
  subscribeToFriend(myPk, friendPk, onMessageReceived) {
    if (!this.relay) return;

    // 訂閱條件：對方的公鑰發給我的事件
    const sub = this.relay.sub([
      {
        kinds: [4],
        authors: [friendPk],
        '#p': [myPk]
      }
    ]);

    sub.on('event', (event) => {
      // 收到事件後，把加密的 content 丟回給外部（讓 app.js 呼叫 crypto.js 解密）
      onMessageReceived(event.content);
    });

    return sub;
  }
}
