from pathlib import Path

# ---- nostr.js: multi subscriptions + immediate ready ----
p = Path('js/nostr.js')
s = p.read_text()
s = s.replace('    this.currentSub = null;\n', '    this.subscriptions = new Map();\n', 1)
old = '''        const changed = this.connectedRelaysStatus[index] !== connected;\n        this.connectedRelaysStatus[index] = connected;\n        if (changed || this.onStatusChange) {\n          if (this.onStatusChange) this.onStatusChange(index, connected);\n        }\n        return connected;'''
new = '''        const changed = this.connectedRelaysStatus[index] !== connected;\n        this.connectedRelaysStatus[index] = connected;\n        if (changed || this.onStatusChange) {\n          if (this.onStatusChange) this.onStatusChange(index, connected);\n        }\n        if (connected && this.onAnyRelayConnected) {\n          this.onAnyRelayConnected(url, index);\n        }\n        return connected;'''
if old not in s: raise SystemExit('nostr status anchor missing')
s = s.replace(old, new, 1)
s = s.replace("      if (results.some(Boolean) && this.onAnyRelayConnected) {\n        this.onAnyRelayConnected();\n      }\n", '', 1)
start = s.index('  subscribeToFriend(myPk, friendPk, onMessageReceived) {')
end = s.index('  clearAllSubscriptions() {', start)
end2 = s.index('  }\n}', end) + len('  }\n')
block = '''  subscribeToFriend(myPk, friendPk, onMessageReceived) {\n    this.unsubscribeFromFriend(friendPk);\n\n    const liveUrls = this.getLiveUrls();\n    if (liveUrls.length === 0) return false;\n\n    const filter = {\n      kinds: [4],\n      '#p': [myPk],\n      since: Math.floor(Date.now() / 1000) - APP_CONFIG.relaySubscribeLookbackSec\n    };\n    if (friendPk !== 'any') filter.authors = [friendPk];\n\n    const sub = this.pool.sub(liveUrls, [filter]);\n    this.subscriptions.set(friendPk, sub);\n\n    sub.on('event', event => {\n      if (!event || !event.id || !event.content || !event.pubkey) return;\n      if (this.seenEvents.has(event.id)) return;\n\n      this.seenEvents.add(event.id);\n      if (this.seenEvents.size > 3000) {\n        const first = this.seenEvents.values().next().value;\n        if (first) this.seenEvents.delete(first);\n      }\n\n      onMessageReceived(event.content, event.pubkey, event);\n    });\n\n    sub.on('eose', () => {\n      console.log(`[Nostr] EOSE - signaling cache synchronized (${friendPk}).`);\n    });\n\n    return true;\n  }\n\n  unsubscribeFromFriend(friendPk = null) {\n    const closeSub = sub => {\n      if (!sub) return;\n      try {\n        if (typeof sub.unsub === 'function') sub.unsub();\n        else if (typeof sub.close === 'function') sub.close();\n      } catch (error) {\n        console.warn('[Nostr] unsubscribe failed', error);\n      }\n    };\n\n    if (friendPk !== null && friendPk !== undefined) {\n      closeSub(this.subscriptions.get(friendPk));\n      this.subscriptions.delete(friendPk);\n      return;\n    }\n\n    for (const sub of this.subscriptions.values()) closeSub(sub);\n    this.subscriptions.clear();\n  }\n\n  clearAllSubscriptions() {\n    this.unsubscribeFromFriend();\n  }\n'''
s = s[:start] + block + s[end2:]
p.write_text(s)

# ---- app.js: background direct pool ----
p = Path('js/app.js')
a = p.read_text()
a = a.replace("let rtcConfig = directRtcConfig;\n", "let rtcConfig = directRtcConfig;\nconst backgroundSessions = new Map();\n", 1)

# preserve background subscriptions when foreground changes
old = '''function clearSessionState() {\n    nostr.clearAllSubscriptions();\n    if (qrTimeoutTimer) clearTimeout(qrTimeoutTimer);'''
new = '''function clearSessionState() {\n    nostr.unsubscribeFromFriend(GLOBAL_CHANNEL);\n    if (currentFriendPk) nostr.unsubscribeFromFriend(currentFriendPk);\n    if (qrTimeoutTimer) clearTimeout(qrTimeoutTimer);'''
if old not in a: raise SystemExit('clearSessionState anchor missing')
a = a.replace(old, new, 1)

# Insert background pool before openConversation
anchor = 'function openConversation(friendPk) {'
idx = a.index(anchor)
bg = r'''
function getBackgroundSession(friendPk) {
    let session = backgroundSessions.get(friendPk);
    if (!session) {
        session = {
            friendPk,
            peer: null,
            negotiationId: null,
            reconnectTimer: null,
            attemptTimer: null,
            attempt: 0,
            connected: false,
            subscribed: false
        };
        backgroundSessions.set(friendPk, session);
    }
    return session;
}

function clearBackgroundTimers(session) {
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    if (session.attemptTimer) clearTimeout(session.attemptTimer);
    session.reconnectTimer = null;
    session.attemptTimer = null;
}

function destroyBackgroundPeer(session) {
    clearBackgroundTimers(session);
    if (!session.peer) return;
    try {
        session.peer.removeAllListeners();
        session.peer.destroy();
    } catch (_) {}
    session.peer = null;
    session.connected = false;
}

function stopBackgroundSession(friendPk) {
    const session = backgroundSessions.get(friendPk);
    if (!session) {
        nostr.unsubscribeFromFriend(friendPk);
        return;
    }
    destroyBackgroundPeer(session);
    nostr.unsubscribeFromFriend(friendPk);
    backgroundSessions.delete(friendPk);
}

function scheduleBackgroundReconnect(friendPk, reason = 'retry') {
    const session = getBackgroundSession(friendPk);
    if (session.reconnectTimer || session.connected) return;
    if (currentFriendPk === friendPk && currentSystemState !== STATE_READY) return;

    const exponent = Math.min(session.attempt, 4);
    const delay = Math.min(APP_CONFIG.reconnectBaseDelayMs * Math.pow(2, exponent), APP_CONFIG.reconnectMaxDelayMs);
    session.reconnectTimer = setTimeout(() => {
        session.reconnectTimer = null;
        startBackgroundSession(friendPk, reason);
    }, delay);
}

async function sendBackgroundSignaling(friendPk, type, signal, negotiationId) {
    try {
        const encrypted = await encodeSignaling(friendPk, { type, signal, negotiationId });
        await nostr.sendEvent(myKeyPair.sk, friendPk, encrypted);
    } catch (error) {
        logger.error(`背景 ${type} signaling 發送失敗`, error);
        const session = getBackgroundSession(friendPk);
        session.attempt += 1;
        scheduleBackgroundReconnect(friendPk, 'signaling-failed');
    }
}

function createBackgroundPeer(friendPk, { initiator, signalType, negotiationId }) {
    const session = getBackgroundSession(friendPk);
    destroyBackgroundPeer(session);
    session.negotiationId = negotiationId || randomId();
    session.connected = false;

    const peer = new window.SimplePeer({
        initiator,
        trickle: false,
        config: directRtcConfig
    });
    session.peer = peer;

    if (signalType) {
        peer.on('signal', signalData => {
            if (session.peer !== peer || peer.destroyed) return;
            sendBackgroundSignaling(friendPk, signalType, signalData, session.negotiationId);
        });
    }

    peer.on('connect', () => {
        if (session.peer !== peer) return;
        clearBackgroundTimers(session);
        session.connected = true;
        session.attempt = 0;
        logger.debug(`🟢 背景 Direct P2P 已連線：${friendPk.slice(0, 8)}`);
        renderChatList();
    });

    peer.on('data', data => {
        if (session.peer !== peer) return;
        const text = data.toString();
        Storage.saveMessageLog(friendPk, text, 'friend');
        Storage.touchFriend(friendPk);
        if (currentFriendPk === friendPk && currentSystemState !== STATE_READY) appendMessage(text, 'friend');
        else renderChatList();
    });

    const retry = reason => {
        if (session.peer !== peer) return;
        session.connected = false;
        session.peer = null;
        session.attempt += 1;
        renderChatList();
        scheduleBackgroundReconnect(friendPk, reason);
    };
    peer.on('close', () => retry('close'));
    peer.on('error', () => retry('error'));

    session.attemptTimer = setTimeout(() => {
        if (session.peer !== peer || session.connected) return;
        try { peer.destroy(); } catch (_) {}
        if (session.peer === peer) session.peer = null;
        session.attempt += 1;
        scheduleBackgroundReconnect(friendPk, 'timeout');
    }, APP_CONFIG.peerAttemptTimeoutMs);

    return peer;
}

function subscribeBackgroundSession(friendPk) {
    const session = getBackgroundSession(friendPk);
    nostr.subscribeToFriend(myKeyPair.pk, friendPk, async (rawContent, authorPk) => {
        if (authorPk !== friendPk || !rawContent || rawContent.length > 100000) return;
        if (currentFriendPk === friendPk && currentSystemState !== STATE_READY) return;
        try {
            const data = await decodeSignaling(rawContent, authorPk);
            if (!data) return;

            if (data.type === 'reconnect-offer') {
                if (session.connected && session.peer && session.peer.connected) return;
                const negotiationId = data.negotiationId || randomId();
                const peer = createBackgroundPeer(friendPk, {
                    initiator: false,
                    signalType: 'reconnect-answer',
                    negotiationId
                });
                peer.signal(data.signal);
                return;
            }

            if (data.type === 'reconnect-answer') {
                if (data.negotiationId && session.negotiationId && data.negotiationId !== session.negotiationId) return;
                if (session.peer && !session.peer.destroyed) session.peer.signal(data.signal);
                return;
            }

            if (data.type === 'leave') {
                destroyBackgroundPeer(session);
                session.attempt += 1;
                scheduleBackgroundReconnect(friendPk, 'peer-left');
            }
        } catch (error) {
            logger.error('背景 signaling 處理失敗', error);
        }
    });
    session.subscribed = true;
}

function startBackgroundSession(friendPk, reason = 'background-start') {
    if (!isNostrReady || !isValidPubkey(friendPk) || !myKeyPair.pk) return;
    if (currentFriendPk === friendPk && currentSystemState !== STATE_READY) return;

    const session = getBackgroundSession(friendPk);
    subscribeBackgroundSession(friendPk);
    if (session.peer && session.peer.connected) {
        session.connected = true;
        return;
    }
    if (session.peer && !session.peer.destroyed) return;

    if (myKeyPair.pk > friendPk) {
        session.attempt += 1;
        session.negotiationId = randomId();
        logger.debug(`🔁 背景 reconnect ${friendPk.slice(0, 8)} #${session.attempt} (${reason})`);
        createBackgroundPeer(friendPk, {
            initiator: true,
            signalType: 'reconnect-offer',
            negotiationId: session.negotiationId
        });
    } else {
        scheduleBackgroundReconnect(friendPk, 'follower-wait');
    }
}

function startAllBackgroundConnections() {
    if (!isNostrReady || !myKeyPair.pk) return;
    const chats = Storage.getChatList();
    const wanted = new Set(chats.map(chat => chat.pk));

    for (const [pk] of backgroundSessions) {
        if (!wanted.has(pk) || (pk === currentFriendPk && currentSystemState !== STATE_READY)) {
            stopBackgroundSession(pk);
        }
    }

    chats.forEach(chat => {
        if (chat.pk !== currentFriendPk || currentSystemState === STATE_READY) {
            startBackgroundSession(chat.pk);
        }
    });
}

'''
a = a[:idx] + bg + a[idx:]

# Open current chat: stop only its background session, preserve others
a = a.replace('function openConversation(friendPk) {\n    if (!isValidPubkey(friendPk)) return;', 'function openConversation(friendPk) {\n    if (!isValidPubkey(friendPk)) return;\n    stopBackgroundSession(friendPk);', 1)

# return to list restarts all backgrounds
a = a.replace('    transitionToState(STATE_READY);\n}\n\nfunction deleteConversation', '    transitionToState(STATE_READY);\n    startAllBackgroundConnections();\n}\n\nfunction deleteConversation', 1)

# deletion stops background first
a = a.replace("function deleteConversation(friendPk) {\n    if (!isValidPubkey(friendPk)) return;", "function deleteConversation(friendPk) {\n    if (!isValidPubkey(friendPk)) return;\n    stopBackgroundSession(friendPk);", 1)

# bootstrap: any one relay immediately starts app/background work
old = '''    const onAnyRelayConnectedTrigger = function() {\n        if (!isNostrReady) logger.debug('✅ 至少一個 Nostr relay 已接通。');\n        isNostrReady = true;\n    };'''
new = '''    const onAnyRelayConnectedTrigger = function(url) {\n        const wasReady = isNostrReady;\n        isNostrReady = true;\n        if (!wasReady) logger.debug(`✅ Nostr 已可用：${url || '至少一個 relay'} 已接通；其餘 relay 繼續背景檢查。`);\n        startAllBackgroundConnections();\n    };'''
if old not in a: raise SystemExit('bootstrap anchor missing')
a = a.replace(old, new, 1)
a = a.replace('        .then(function() {\n            isNostrReady = true;\n        })', '        .then(function() {\n            isNostrReady = nostr.hasLiveRelay();\n            if (isNostrReady) startAllBackgroundConnections();\n        })', 1)

# Ready state also kick background pool after rendering
a = a.replace("        renderChatList();\n        const pairActions", "        renderChatList();\n        if (isNostrReady) queueMicrotask(startAllBackgroundConnections);\n        const pairActions", 1)

# Network recovery should wake all background sessions too
a = a.replace("    if (currentFriendPk && currentSystemState !== STATE_READY) {\n        transitionToState(STATE_CONNECTING);", "    startAllBackgroundConnections();\n\n    if (currentFriendPk && currentSystemState !== STATE_READY) {\n        transitionToState(STATE_CONNECTING);", 1)

p.write_text(a)

# ---- README concise behavior update ----
p = Path('README.md')
r = p.read_text()
needle = '切換聊天室時，系統會重新優先嘗試 Direct P2P。'
if needle in r:
    r = r.replace(needle, '多個 1 對 1 聊天室可以在背景同時嘗試 Direct P2P；切換聊天室不會讓其他聊天室停止背景連線。\n\nNostr 只要任一 Relay 成功連線就能立即使用，其他 Relay 會繼續在背景同步狀態。', 1)
else:
    r += '\n\n多個 1 對 1 聊天室可同時在背景嘗試 Direct P2P。Nostr 只要任一 Relay 成功連線即可立即使用，其餘 Relay 會繼續背景同步。\n'
p.write_text(r)
