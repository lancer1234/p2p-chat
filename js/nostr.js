export class NostrManager {
  constructor(relayUrl = 'wss://relay.damus.io') {
    this.relayUrl = relayUrl;
    this.relay = null;
  }

  async connect() {
    this.relay = window.NostrTools.relayInit(this.relayUrl);
    this.relay.on('connect', () => console.log(`已連接至 Nostr: ${this.relayUrl}`));
    this.relay.on('error', () => console.error("Nostr 連接失敗"));
    await this.relay.connect();
  }

  async sendEvent(mySk, friendPk, encryptedContent) {
    if (!this.relay) return;

    const event = {
      kind: 4,
      pubkey: window.NostrTools.getPublicKey(mySk),
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', friendPk]],
      content: encryptedContent
    };

    event.id = window.NostrTools.getEventHash(event);
    event.sig = window.NostrTools.getSignature(event, mySk);

    await this.relay.publish(event);
  }

  subscribeToFriend(myPk, friendPk, onMessageReceived) {
    if (!this.relay) return;

    const sub = this.relay.sub([
      {
        kinds: [4],
        authors: [friendPk],
        '#p': [myPk]
      }
    ]);

    sub.on('event', (event) => {
      onMessageReceived(event.content);
    });

    return sub;
  }
}
