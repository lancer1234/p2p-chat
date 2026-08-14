import { bytesToHex } from './crypto.js';
import { APP_CONFIG } from './config.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class NostrManager {
  constructor() {
    this.relayUrls = [
      'wss://nos.lol',
      'wss://relay.damus.io',
      'wss://relay.primal.net',
      'wss://relay.nostr.band'
    ];

    this.pool = new window.NostrTools.SimplePool();
    this.connectedRelaysStatus = this.relayUrls.map(() => false);
    this.seenEvents = new Set();
    this.currentSub = null;

    this.onStatusChange = null;
    this.onAnyRelayConnected = null;
    this.healthTimer = null;
    this.connectInFlight = null;

    // 所有 signaling 都排隊送，絕不再用「5 秒內直接 return」的方式丟封包。
    this.outboundQueue = [];
    this.queueRunning = false;
  }

  async connect(onStatusChange, onAnyRelayConnected) {
    this.onStatusChange = onStatusChange || this.onStatusChange;
    this.onAnyRelayConnected = onAnyRelayConnected || this.onAnyRelayConnected;

    await this.refreshRelays();
    this.startHealthMonitor();

    if (!this.hasLiveRelay()) {
      throw new Error('全球信令矩陣目前全數斷連。');
    }
  }

  hasLiveRelay() {
    return this.connectedRelaysStatus.some(Boolean);
  }

  getLiveUrls() {
    return this.relayUrls.filter((url, index) => this.connectedRelaysStatus[index]);
  }

  getStatusSnapshot() {
    return this.relayUrls.map((url, index) => ({
      url,
      connected: !!this.connectedRelaysStatus[index]
    }));
  }

  async refreshRelays() {
    if (this.connectInFlight) return this.connectInFlight;

    this.connectInFlight = (async () => {
      const checks = this.relayUrls.map(async (url, index) => {
        let connected = false;
        try {
          const relay = await Promise.race([
            this.pool.ensureRelay(url),
            new Promise((_, reject) => setTimeout(() => reject(new Error('relay timeout')), 7000))
          ]);
          connected = !!relay;
        } catch (error) {
          connected = false;
          console.warn(`[Nostr] Relay unavailable: ${url}`, error);
        }

        const changed = this.connectedRelaysStatus[index] !== connected;
        this.connectedRelaysStatus[index] = connected;
        if (changed || this.onStatusChange) {
          if (this.onStatusChange) this.onStatusChange(index, connected);
        }
        return connected;
      });

      const results = await Promise.all(checks);
      if (results.some(Boolean) && this.onAnyRelayConnected) {
        this.onAnyRelayConnected();
      }
      return results;
    })();

    try {
      return await this.connectInFlight;
    } finally {
      this.connectInFlight = null;
    }
  }

  startHealthMonitor() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => {
      this.refreshRelays().catch(() => {});
    }, APP_CONFIG.relayHealthIntervalMs);
  }

  async ensureAtLeastOneRelay() {
    if (this.hasLiveRelay()) return true;
    await this.refreshRelays();
    return this.hasLiveRelay();
  }

  async sendEvent(mySk, friendPk, encryptedContent) {
    if (!mySk || !friendPk || !encryptedContent) {
      throw new Error('Nostr sendEvent 缺少必要欄位。');
    }

    return new Promise((resolve, reject) => {
      this.outboundQueue.push({ mySk, friendPk, encryptedContent, resolve, reject, attempts: 0 });
      this.drainQueue();
    });
  }

  async drainQueue() {
    if (this.queueRunning) return;
    this.queueRunning = true;

    try {
      while (this.outboundQueue.length > 0) {
        const job = this.outboundQueue[0];
        try {
          await this.publishOne(job.mySk, job.friendPk, job.encryptedContent);
          job.resolve(true);
          this.outboundQueue.shift();
          await sleep(APP_CONFIG.signalingQueueGapMs);
        } catch (error) {
          job.attempts += 1;
          console.warn(`[Nostr] signaling publish failed, attempt=${job.attempts}`, error);

          if (job.attempts >= 4) {
            job.reject(error);
            this.outboundQueue.shift();
          } else {
            await sleep(Math.min(1000 * Math.pow(2, job.attempts - 1), 5000));
            await this.refreshRelays().catch(() => {});
          }
        }
      }
    } finally {
      this.queueRunning = false;
    }
  }

  async publishOne(mySk, friendPk, encryptedContent) {
    const ready = await this.ensureAtLeastOneRelay();
    if (!ready) throw new Error('目前沒有可用 Nostr relay。');

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

    const liveUrls = this.getLiveUrls();
    if (liveUrls.length === 0) throw new Error('沒有可投遞的 relay。');

    const result = this.pool.publish(liveUrls, event);
    if (result && typeof result.then === 'function') {
      await result;
    } else if (Array.isArray(result)) {
      const promiseLikes = result.filter(item => item && typeof item.then === 'function');
      if (promiseLikes.length > 0) await Promise.allSettled(promiseLikes);
    }

    console.log(`[Nostr] signaling queued to ${liveUrls.length} relay(s): ${event.id}`);
  }

  subscribeToFriend(myPk, friendPk, onMessageReceived) {
    this.unsubscribeFromFriend();

    const liveUrls = this.getLiveUrls();
    if (liveUrls.length === 0) return false;

    const filter = {
      kinds: [4],
      '#p': [myPk],
      since: Math.floor(Date.now() / 1000) - APP_CONFIG.relaySubscribeLookbackSec
    };
    if (friendPk !== 'any') filter.authors = [friendPk];

    this.currentSub = this.pool.sub(liveUrls, [filter]);

    this.currentSub.on('event', event => {
      if (!event || !event.id || !event.content || !event.pubkey) return;
      if (this.seenEvents.has(event.id)) return;

      this.seenEvents.add(event.id);
      if (this.seenEvents.size > 3000) {
        const first = this.seenEvents.values().next().value;
        if (first) this.seenEvents.delete(first);
      }

      onMessageReceived(event.content, event.pubkey, event);
    });

    this.currentSub.on('eose', () => {
      console.log('[Nostr] EOSE - signaling cache synchronized.');
    });

    return true;
  }

  unsubscribeFromFriend() {
    if (!this.currentSub) return;
    try {
      if (typeof this.currentSub.unsub === 'function') this.currentSub.unsub();
      else if (typeof this.currentSub.close === 'function') this.currentSub.close();
    } catch (error) {
      console.warn('[Nostr] unsubscribe failed', error);
    }
    this.currentSub = null;
  }

  clearAllSubscriptions() {
    this.unsubscribeFromFriend();
  }
}
