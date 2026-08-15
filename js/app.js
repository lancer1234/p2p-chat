import { Storage } from './storage.js';
import { Crypto, bytesToHex } from './crypto.js';
import { NostrManager } from './nostr.js';
import { APP_CONFIG } from './config.js';
import { getPeerConnection, getSelectedCandidateInfo } from './webrtc.js';

const GLOBAL_CHANNEL = 'any';

const STATE_INIT = 'INIT';
const STATE_READY = 'READY';
const STATE_CREATE_QR = 'CREATE_QR';
const STATE_SCAN_QR = 'SCAN_QR';
const STATE_CONNECTING = 'CONNECTING';
const STATE_CONNECTED = 'CONNECTED';

let currentSystemState = STATE_INIT;

class SafeLogger {
    constructor(isProduction = false) {
        this.isProd = isProduction;
    }

    debug(msg) {
        if (this.isProd) return;
        const consoleEl = document.getElementById('debug-console');
        if (consoleEl) {
            consoleEl.innerText += `\n[${new Date().toLocaleTimeString()}] ${msg}`;
            consoleEl.scrollTop = consoleEl.scrollHeight;
        }
        console.log(msg);
    }

    error(msg, error) {
        this.debug(`❌ ${msg}${error && error.message ? `: ${error.message}` : ''}`);
        if (error) console.error(msg, error);
    }
}

const logger = new SafeLogger(false);

let myKeyPair = { sk: null, pk: null };
let p2pPeer = null;
let currentFriendPk = null;
let currentNegotiationId = null;
let nostr = new NostrManager();
let isNostrReady = false;
let userPin = '';
let qrTimeoutTimer = null;
let reconnectTimer = null;
let disconnectGraceTimer = null;
let peerAttemptTimer = null;
let reconnectAttempt = 0;
let lastIceState = 'new';
let relayModeEnabled = false;
let relayIceServers = [];
let relayCredentialsExpiresAt = 0;
let relayCredentialsPromise = null;
let directRtcConfig = {
    iceServers: [...APP_CONFIG.stunIceServers],
    iceCandidatePoolSize: 4,
    bundlePolicy: 'max-bundle'
};
let relayRtcConfig = { ...directRtcConfig };
let rtcConfig = directRtcConfig;
const backgroundSessions = new Map();

function setRelayFallbackVisible(visible) {
    const bar = document.getElementById('relay-fallback-bar');
    if (bar) bar.style.display = visible ? 'block' : 'none';
}

function refreshActiveRtcConfig() {
    rtcConfig = relayModeEnabled ? relayRtcConfig : directRtcConfig;
}

function resetRelayModeForDirectAttempt(reason, clearExpiredCredentials = false) {
    relayModeEnabled = false;

    if (clearExpiredCredentials) {
        relayIceServers = [];
        relayCredentialsExpiresAt = 0;
        relayCredentialsPromise = null;
        relayRtcConfig = { ...directRtcConfig };
    }

    refreshActiveRtcConfig();
    setRelayFallbackVisible(false);
    updateNetworkDetail(hasRelayBackend()
        ? 'DIRECT P2P ONLY · RELAY ON-DEMAND'
        : 'DIRECT P2P ONLY · TURN UNAVAILABLE');
    logger.debug(`🟢 Relay mode 已重置；本次連線重新從 Direct P2P 開始 (${reason})。`);
}

function randomId() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return bytesToHex(bytes);
}

function isValidPubkey(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function updateRelayUIIndicator(index, isConnected) {
    const el = document.getElementById(`relay-${index}`);
    if (!el) return;

    if (isConnected) {
        el.className = 'relay-status ok';
        el.innerText = '🟢 ON';
    } else {
        el.className = 'relay-status fail';
        el.innerText = '🔴 OFF';
    }
}

function updateNetworkDetail(text) {
    const el = document.getElementById('network-detail');
    if (el) el.innerText = text;
}

function transitionToState(nextState) {
    logger.debug(`🎛️ 狀態轉移: [${currentSystemState}] ➔ [${nextState}]`);
    currentSystemState = nextState;

    document.getElementById('pin-container').style.display = 'none';
    document.getElementById('setup-container').style.display = 'none';
    document.getElementById('qrcode-container').style.display = 'none';
    document.getElementById('reader').style.display = 'none';
    document.getElementById('chat-interface').style.display = 'none';

    if (nextState === STATE_INIT) {
        document.getElementById('pin-container').style.display = 'block';
    } else if (nextState === STATE_READY) {
        document.getElementById('setup-container').style.display = 'block';
        renderChatList();
        if (isNostrReady) queueMicrotask(startAllBackgroundConnections);
        const pairActions = document.getElementById('pair-actions');
        if (pairActions) pairActions.style.display = 'none';
    } else if (nextState === STATE_CREATE_QR) {
        document.getElementById('qrcode-container').style.display = 'block';
    } else if (nextState === STATE_SCAN_QR) {
        document.getElementById('reader').style.display = 'block';
    } else if (nextState === STATE_CONNECTING || nextState === STATE_CONNECTED) {
        document.getElementById('chat-interface').style.display = 'flex';
        updateCurrentPeerLabel();
        updateOnlineStatus(nextState === STATE_CONNECTED);
    }
}

function isWeakPassword(pin) {
    const weakPatterns = ['12345678', '00000000', '11111111', '88888888', 'password'];
    return pin.length < 8 || weakPatterns.includes(pin.toLowerCase());
}

function normalizeSignalingPackage(data) {
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return null;

    if (['leave', 'relay-request', 'relay-ack'].includes(data.type)) {
        return {
            type: data.type,
            sentAt: Number(data.sentAt || 0),
            negotiationId: data.negotiationId || null,
            signal: null
        };
    }

    const validTypes = ['init-offer', 'init-answer', 'reconnect-offer', 'reconnect-answer'];
    if (!validTypes.includes(data.type)) return null;

    const signal = data.signal || data.sdp;
    if (!signal || typeof signal !== 'object') return null;

    return {
        type: data.type,
        signal,
        sentAt: Number(data.sentAt || 0),
        negotiationId: data.negotiationId || null
    };
}

function isFreshSignalingPackage(data) {
    if (!data || !data.sentAt) return true;
    return Math.abs(Date.now() - data.sentAt) <= APP_CONFIG.signalingMaxAgeMs;
}

async function encodeSignaling(friendPk, payload) {
    const enriched = {
        ...payload,
        sentAt: Date.now()
    };
    return Crypto.encryptData(myKeyPair.sk, friendPk, JSON.stringify(enriched));
}

async function decodeSignaling(rawContent, authorPk) {
    if (!rawContent || !authorPk) return null;

    try {
        const decrypted = await Crypto.decryptData(myKeyPair.sk, authorPk, rawContent);
        if (decrypted) {
            const parsed = normalizeSignalingPackage(JSON.parse(decrypted));
            if (parsed && isFreshSignalingPackage(parsed)) return parsed;
        }
    } catch (error) {}

    try {
        const parsed = normalizeSignalingPackage(JSON.parse(rawContent));
        if (parsed && isFreshSignalingPackage(parsed)) return parsed;
    } catch (error) {}

    return null;
}

async function loadIceConfiguration() {
    directRtcConfig = {
        iceServers: [...APP_CONFIG.stunIceServers],
        iceCandidatePoolSize: 4,
        bundlePolicy: 'max-bundle'
    };

    relayIceServers = [];
    relayCredentialsExpiresAt = 0;
    relayCredentialsPromise = null;
    relayRtcConfig = { ...directRtcConfig };
    relayModeEnabled = false;
    refreshActiveRtcConfig();
    setRelayFallbackVisible(false);

    if (APP_CONFIG.turnBackendUrl) {
        logger.debug('🔒 TURN 採用 on-demand 短效 credentials；目前不會取得或使用 TURN。');
        updateNetworkDetail('DIRECT P2P ONLY · RELAY ON-DEMAND');
    } else {
        logger.debug('⚠️ 未設定 TURN backend；目前只能 Direct P2P。');
        updateNetworkDetail('DIRECT P2P ONLY · TURN UNAVAILABLE');
    }
}

function hasRelayBackend() {
    if (typeof APP_CONFIG.turnBackendUrl !== 'string') return false;
    const url = APP_CONFIG.turnBackendUrl.trim();
    if (!url) return false;
    return !url.includes('YOUR-WORKER') && !url.includes('YOUR-SUBDOMAIN');
}

function relayCredentialsStillValid() {
    return relayIceServers.length > 0 &&
        relayCredentialsExpiresAt > Date.now() + APP_CONFIG.turnRefreshSafetyMs;
}

async function ensureRelayIceServers(forceRefresh = false) {
    if (!hasRelayBackend()) throw new Error('TURN backend URL 未設定');
    if (!forceRefresh && relayCredentialsStillValid()) return relayIceServers;
    if (relayCredentialsPromise) return relayCredentialsPromise;

    relayCredentialsPromise = (async function() {
        logger.debug('🔐 正在向後端要求 4 小時短效 TURN credentials...');

        const response = await fetch(APP_CONFIG.turnBackendUrl, {
            method: 'GET',
            cache: 'no-store',
            mode: 'cors',
            credentials: 'omit',
            referrerPolicy: 'strict-origin-when-cross-origin',
            headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) {
            let reason = `HTTP ${response.status}`;
            try {
                const body = await response.json();
                if (body && body.error) reason = body.error;
            } catch (_) {}
            throw new Error(reason);
        }

        const payload = await response.json();
        const servers = Array.isArray(payload) ? payload : payload.iceServers;
        if (!Array.isArray(servers)) throw new Error('TURN backend 回傳格式錯誤');

        const turnOnly = servers.filter(server => {
            const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
            return urls.some(url => typeof url === 'string' && /^turns?:/i.test(url));
        });
        if (turnOnly.length === 0) throw new Error('TURN backend 沒有回傳 TURN server');

        relayIceServers = turnOnly;
        const expiresIn = Number(payload.expiresIn || payload.expiryInSeconds || 14400);
        relayCredentialsExpiresAt = Date.now() + Math.max(60, expiresIn) * 1000;

        relayRtcConfig = {
            iceServers: [...APP_CONFIG.stunIceServers, ...turnOnly],
            iceCandidatePoolSize: 4,
            bundlePolicy: 'max-bundle'
        };

        logger.debug(`✅ 短效 TURN credentials 已取得，約 ${Math.round(expiresIn / 60)} 分鐘後失效。`);
        return relayIceServers;
    })();

    try {
        return await relayCredentialsPromise;
    } finally {
        relayCredentialsPromise = null;
    }
}

document.getElementById('checkbox-show-pin').addEventListener('change', function(e) {
    document.getElementById('pin-input').type = e.target.checked ? 'text' : 'password';
});

document.getElementById('btn-reset-identity').addEventListener('click', function() {
    const step1 = confirm('⚠️ 警告：即將清除身分！是否確定？');
    if (!step1) return;
    Storage.resetIdentity();
    location.reload();
});

async function executeUnlockFlow() {
    const pinInput = document.getElementById('pin-input').value;
    if (isWeakPassword(pinInput)) {
        alert('安全強度不足！密碼長度必須大於等於 8 位。');
        return;
    }

    userPin = pinInput;
    const cached = Storage.getEncryptedKeyPair();

    try {
        if (cached.esk && cached.pk) {
            const decryptedSk = await Crypto.decryptSecret(cached.esk, userPin);
            myKeyPair = { sk: decryptedSk, pk: cached.pk };
            logger.debug('身分解鎖成功。');
        } else {
            let skBytes;
            if (window.NostrTools && typeof window.NostrTools.generateSecretKey === 'function') {
                skBytes = window.NostrTools.generateSecretKey();
            } else {
                skBytes = window.NostrTools.generatePrivateKey();
            }

            const skHex = typeof skBytes === 'string' ? skBytes : bytesToHex(skBytes);
            const pk = window.NostrTools.getPublicKey(skHex);
            const encryptedSkHex = await Crypto.encryptSecret(skHex, userPin);

            Storage.saveEncryptedKeyPair(encryptedSkHex, pk);
            myKeyPair = { sk: skHex, pk };
            logger.debug('全新身分儲存完畢。');
        }

        transitionToState(STATE_READY);
        await loadIceConfiguration();
        bootstrapApp();
    } catch (error) {
        console.error(error);
        alert('解密驗證失敗！密碼錯誤或身分資料已受損。');
    }
}

document.getElementById('btn-unlock').addEventListener('click', executeUnlockFlow);

function bootstrapApp() {
    const onAnyRelayConnectedTrigger = function(url) {
        const wasReady = isNostrReady;
        isNostrReady = true;
        if (!wasReady) logger.debug(`✅ Nostr 已可用：${url || '至少一個 relay'} 已接通；其餘 relay 繼續背景檢查。`);
        startAllBackgroundConnections();
    };

    nostr.connect(updateRelayUIIndicator, onAnyRelayConnectedTrigger)
        .then(function() {
            isNostrReady = nostr.hasLiveRelay();
            if (isNostrReady) startAllBackgroundConnections();
        })
        .catch(function(error) {
            isNostrReady = false;
            logger.error('Nostr relay 全數無法連線', error);
        });
}

function formatChatTime(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    if (sameDay) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const diff = now.getTime() - date.getTime();
    if (diff < 7 * 24 * 60 * 60 * 1000) return date.toLocaleDateString([], { weekday: 'short' });
    return date.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
}

function getFriendDisplayName(friendPk) {
    const friend = Storage.getFriends()[friendPk];
    return friend?.name || `聯絡人 ${String(friendPk || '').slice(0, 8)}`;
}

function updateCurrentPeerLabel() {
    const el = document.getElementById('chat-peer-name');
    if (!el) return;
    el.innerText = currentFriendPk ? getFriendDisplayName(currentFriendPk) : '對話';
}

function renderChatList() {
    const list = document.getElementById('chat-list');
    const count = document.getElementById('chat-count');
    if (!list) return;
    const chats = Storage.getChatList();
    if (count) count.innerText = String(chats.length);
    list.innerHTML = '';

    if (chats.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'chat-empty';
        empty.innerText = '目前沒有對話\n按「＋ 新增對話」開始配對';
        list.appendChild(empty);
        return;
    }

    chats.forEach(chat => {
        const row = document.createElement('div');
        row.className = 'chat-row';
        const open = document.createElement('button');
        open.className = 'chat-open';
        open.dataset.pk = chat.pk;
        const avatar = document.createElement('div');
        avatar.className = 'chat-avatar';
        avatar.innerText = chat.pk.slice(0, 2).toUpperCase();
        const main = document.createElement('div');
        main.className = 'chat-main';
        const top = document.createElement('div');
        top.className = 'chat-topline';
        const name = document.createElement('span');
        name.className = 'chat-name';
        name.innerText = chat.name;
        const time = document.createElement('span');
        time.className = 'chat-time';
        time.innerText = formatChatTime(chat.updatedAt);
        top.append(name, time);
        const preview = document.createElement('div');
        preview.className = 'chat-preview';
        preview.innerText = chat.lastMessage || '尚無訊息';
        main.append(top, preview);
        open.append(avatar, main);
        const del = document.createElement('button');
        del.className = 'chat-delete';
        del.dataset.deletePk = chat.pk;
        del.setAttribute('aria-label', '刪除對話');
        del.innerText = '×';
        row.append(open, del);
        list.appendChild(row);
    });
}


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
    if (session.subscribed) return;
    const subscribed = nostr.subscribeToFriend(myKeyPair.pk, friendPk, async (rawContent, authorPk) => {
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
    session.subscribed = !!subscribed;
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

function openConversation(friendPk) {
    if (!isValidPubkey(friendPk)) return;
    stopBackgroundSession(friendPk);
    if (!isNostrReady) {
        alert('矩陣仍在同步中，請稍候。');
        return;
    }
    clearSessionState();
    currentFriendPk = friendPk;
    currentNegotiationId = null;
    reconnectAttempt = 0;
    Storage.touchFriend(friendPk);
    resetRelayModeForDirectAttempt('open-conversation', !relayCredentialsStillValid());
    updateCurrentPeerLabel();
    transitionToState(STATE_CONNECTING);
    restoreChatLogs();
    listenForMessages(currentFriendPk);
    beginReconnectIfLeader('chat-list-open');
}

async function returnToChatList() {
    const leavingPk = currentFriendPk;
    if (leavingPk && isNostrReady) {
        try {
            const encrypted = await encodeSignaling(leavingPk, { type: 'leave', negotiationId: currentNegotiationId });
            await nostr.sendEvent(myKeyPair.sk, leavingPk, encrypted);
        } catch (error) {
            logger.error('leave signaling 發送失敗', error);
        }
    }
    clearSessionState();
    currentFriendPk = null;
    updateCurrentPeerLabel();
    transitionToState(STATE_READY);
    startAllBackgroundConnections();
}

function deleteConversation(friendPk) {
    if (!isValidPubkey(friendPk)) return;
    stopBackgroundSession(friendPk);
    const name = getFriendDisplayName(friendPk);
    if (!confirm(`刪除「${name}」？\n\n本機聊天紀錄也會一起刪除。`)) return;
    Storage.clearSession(friendPk);
    renderChatList();
}

document.getElementById('chat-list').addEventListener('click', function(event) {
    const deleteButton = event.target.closest('[data-delete-pk]');
    if (deleteButton) {
        event.stopPropagation();
        deleteConversation(deleteButton.dataset.deletePk);
        return;
    }
    const openButton = event.target.closest('[data-pk]');
    if (openButton) openConversation(openButton.dataset.pk);
});

document.getElementById('btn-new-chat').addEventListener('click', function() {
    const actions = document.getElementById('pair-actions');
    if (!actions) return;
    actions.style.display = actions.style.display === 'flex' ? 'none' : 'flex';
});

document.getElementById('btn-create').addEventListener('click', startAsQrOwner);
document.getElementById('btn-scan').addEventListener('click', startCameraScan);
document.getElementById('btn-send').addEventListener('click', sendMessage);
document.getElementById('btn-leave').addEventListener('click', returnToChatList);
document.getElementById('btn-use-relay').addEventListener('click', async function() {
    if (!currentFriendPk) return;
    if (!hasRelayBackend()) {
        alert('TURN Relay backend 尚未設定。');
        return;
    }

    const ok = confirm('Direct P2P 無法建立。要改用端對端加密的 TURN Relay 嗎？\n\n聊天內容仍由 WebRTC 加密，但加密封包會經過 Metered TURN 伺服器轉送。');
    if (!ok) return;

    await enableEncryptedRelay(true);
});

document.getElementById('input-msg').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        sendMessage();
    }
});

function clearPeerTimers() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (disconnectGraceTimer) clearTimeout(disconnectGraceTimer);
    if (peerAttemptTimer) clearTimeout(peerAttemptTimer);
    reconnectTimer = null;
    disconnectGraceTimer = null;
    peerAttemptTimer = null;
}

function forceDestroyPeer() {
    clearPeerTimers();
    if (!p2pPeer) return;

    try {
        p2pPeer.removeAllListeners();
        p2pPeer.destroy();
    } catch (error) {}

    p2pPeer = null;
    lastIceState = 'closed';
}

function clearSessionState() {
    nostr.unsubscribeFromFriend(GLOBAL_CHANNEL);
    if (currentFriendPk) nostr.unsubscribeFromFriend(currentFriendPk);
    if (qrTimeoutTimer) clearTimeout(qrTimeoutTimer);
    qrTimeoutTimer = null;
    forceDestroyPeer();
    currentNegotiationId = null;
    reconnectAttempt = 0;
    relayModeEnabled = false;
    refreshActiveRtcConfig();
    setRelayFallbackVisible(false);
}

function armPeerAttemptTimeout(label) {
    if (peerAttemptTimer) clearTimeout(peerAttemptTimer);

    peerAttemptTimer = setTimeout(function() {
        if (currentSystemState !== STATE_CONNECTING) return;
        if (p2pPeer && p2pPeer.connected) return;

        logger.debug(`⏳ ${label} 超過 ${APP_CONFIG.peerAttemptTimeoutMs / 1000} 秒仍未接通。`);
        if (!relayModeEnabled && hasRelayBackend()) {
            setRelayFallbackVisible(true);
            updateNetworkDetail('DIRECT P2P BLOCKED · RELAY AVAILABLE');
            appendMessage('Direct P2P 無法建立。你可以選擇「使用加密 Relay 連線」，系統不會自動切換。', 'system');
        }
        forceDestroyPeer();
        scheduleReconnect('attempt-timeout', true);
    }, APP_CONFIG.peerAttemptTimeoutMs);
}

async function sendSignaling(type, signal, negotiationId) {
    if (!currentFriendPk) return;

    try {
        const encrypted = await encodeSignaling(currentFriendPk, {
            type,
            signal,
            negotiationId
        });
        await nostr.sendEvent(myKeyPair.sk, currentFriendPk, encrypted);
        logger.debug(`📤 ${type} 已送出。`);
    } catch (error) {
        logger.error(`${type} signaling 發送失敗`, error);
        scheduleReconnect('signaling-send-failed');
    }
}

async function sendControlSignaling(type) {
    if (!currentFriendPk) return;
    try {
        const encrypted = await encodeSignaling(currentFriendPk, {
            type,
            negotiationId: currentNegotiationId
        });
        await nostr.sendEvent(myKeyPair.sk, currentFriendPk, encrypted);
        logger.debug(`📤 ${type} control 已送出。`);
    } catch (error) {
        logger.error(`${type} control 發送失敗`, error);
    }
}

async function enableEncryptedRelay(notifyPeer = false) {
    if (!hasRelayBackend()) {
        throw new Error('TURN Relay backend unavailable');
    }

    try {
        await ensureRelayIceServers();
    } catch (error) {
        logger.error('短效 TURN credentials 取得失敗', error);
        appendMessage('TURN Relay 暫時無法啟用：無法取得短效 credentials。', 'system');
        updateNetworkDetail('TURN CREDENTIAL ERROR');
        setRelayFallbackVisible(true);
        return;
    }

    relayModeEnabled = true;
    refreshActiveRtcConfig();
    setRelayFallbackVisible(false);
    updateNetworkDetail('ENCRYPTED RELAY · NEGOTIATING');
    appendMessage('已允許使用端對端加密 TURN Relay。只有本次連線會使用；重新配對時仍會先嘗試 Direct P2P。', 'system');

    if (notifyPeer) await sendControlSignaling('relay-request');

    transitionToState(STATE_CONNECTING);
    forceDestroyPeer();
    scheduleReconnect('user-enabled-relay');
}

function createPeer({ initiator, signalType, negotiationId }) {
    forceDestroyPeer();

    // TURN credential 過期後絕不拿舊 Relay 設定繼續重連。
    // 先回到 Direct P2P；若仍被網路阻擋，再由使用者重新允許 Relay。
    if (relayModeEnabled && !relayCredentialsStillValid()) {
        resetRelayModeForDirectAttempt('turn-credential-expired', true);
        appendMessage('TURN credential 已過期；已重新嘗試 Direct P2P。若仍無法直連，可再次手動啟用加密 Relay。', 'system');
    }

    currentNegotiationId = negotiationId || randomId();
    refreshActiveRtcConfig();
    logger.debug(`🌐 建立 Peer：${relayModeEnabled ? 'ENCRYPTED RELAY ALLOWED' : 'DIRECT P2P ONLY'}`);

    p2pPeer = new window.SimplePeer({
        initiator,
        trickle: false,
        config: rtcConfig
    });

    setupPeerEvents();

    if (signalType) {
        p2pPeer.on('signal', async function(signalData) {
            if (!p2pPeer || p2pPeer.destroyed) return;
            await sendSignaling(signalType, signalData, currentNegotiationId);
        });
    }

    armPeerAttemptTimeout(initiator ? '主動 ICE negotiation' : '被動 ICE negotiation');
    return p2pPeer;
}

async function handleIncomingQrPairSignal(rawContent, authorPk) {
    if (currentSystemState !== STATE_CREATE_QR || !isValidPubkey(authorPk)) return;
    if (p2pPeer && p2pPeer.connected) return;

    try {
        const data = await decodeSignaling(rawContent, authorPk);
        if (!data || data.type !== 'init-offer') return;

        if (qrTimeoutTimer) clearTimeout(qrTimeoutTimer);
        qrTimeoutTimer = null;

        currentFriendPk = authorPk;
        currentNegotiationId = data.negotiationId || randomId();

        const peer = createPeer({
            initiator: false,
            signalType: 'init-answer',
            negotiationId: currentNegotiationId
        });

        peer.signal(data.signal);

        transitionToState(STATE_CONNECTING);
        restoreChatLogs();
        listenForMessages(currentFriendPk);
    } catch (error) {
        logger.error('處理初始 offer 失敗', error);
    }
}

function startAsQrOwner() {
    if (!isNostrReady) {
        alert('Nostr 矩陣尚未接通，請稍候。');
        return;
    }

    clearSessionState();
    currentFriendPk = null;
    transitionToState(STATE_CREATE_QR);

    const container = document.getElementById('qrcode-container');
    const qr = window.qrcode(0, 'M');
    qr.addData(myKeyPair.pk);
    qr.make();
    container.innerHTML = '<h3>請對方掃描 QR Code</h3>' + qr.createImgTag(6);

    qrTimeoutTimer = setTimeout(function() {
        if (currentSystemState === STATE_CREATE_QR) {
            alert('⏳ 配對逾時，系統已自動重置。');
            clearSessionState();
            transitionToState(STATE_READY);
        }
    }, 90000);

    logger.debug('📡 等待加密 init-offer...');
    nostr.subscribeToFriend(myKeyPair.pk, GLOBAL_CHANNEL, handleIncomingQrPairSignal);
}

function startCameraScan() {
    if (!isNostrReady) {
        alert('Nostr 矩陣尚未接通，請稍候。');
        return;
    }

    clearSessionState();
    currentFriendPk = null;
    transitionToState(STATE_SCAN_QR);

    const html5QrcodeScanner = new window.Html5Qrcode('reader');
    html5QrcodeScanner.start(
        { facingMode: 'environment' },
        { fps: 20, qrbox: 250 },
        async function(decodedFriendPk) {
            try { await html5QrcodeScanner.stop(); } catch (error) {}
            if (currentSystemState !== STATE_SCAN_QR) return;

            const normalizedPk = String(decodedFriendPk || '').trim().toLowerCase();
            if (!isValidPubkey(normalizedPk)) {
                alert('QR Code 不是有效的 64 位 Nostr 公鑰。');
                transitionToState(STATE_READY);
                return;
            }
            if (normalizedPk === myKeyPair.pk) {
                alert('不能掃描自己的 QR Code。');
                transitionToState(STATE_READY);
                return;
            }

            currentFriendPk = normalizedPk;
            currentNegotiationId = randomId();
            transitionToState(STATE_CONNECTING);
            restoreChatLogs();

            listenForMessages(currentFriendPk);

            createPeer({
                initiator: true,
                signalType: 'init-offer',
                negotiationId: currentNegotiationId
            });
        },
        function() {}
    ).catch(function(error) {
        logger.error('相機掃描啟動失敗', error);
        transitionToState(STATE_READY);
    });
}

function listenForMessages(friendPk) {
    if (!isValidPubkey(friendPk)) return;

    nostr.subscribeToFriend(myKeyPair.pk, friendPk, async function(rawContent, authorPk) {
        try {
            if (!rawContent || rawContent.length > 100000 || currentSystemState === STATE_READY) return;
            if (authorPk !== friendPk) return;

            const data = await decodeSignaling(rawContent, authorPk);
            if (!data) return;

            if (data.type === 'leave') {
                appendMessage('對方目前未開啟此對話。', 'system');
                forceDestroyPeer();
                transitionToState(STATE_CONNECTING);
                return;
            }

            if (data.type === 'relay-request') {
                if (!hasRelayBackend()) {
                    appendMessage('對方要求使用 Relay，但本機沒有設定 TURN backend。', 'system');
                    return;
                }

                try {
                    await ensureRelayIceServers();
                } catch (error) {
                    logger.error('收到 Relay 請求，但短效 TURN credentials 取得失敗', error);
                    appendMessage('對方要求使用 Relay，但本機無法取得短效 TURN credentials。', 'system');
                    return;
                }

                relayModeEnabled = true;
                refreshActiveRtcConfig();
                setRelayFallbackVisible(false);
                appendMessage('對方已選擇使用端對端加密 Relay；正在切換連線模式。', 'system');
                await sendControlSignaling('relay-ack');
                transitionToState(STATE_CONNECTING);
                forceDestroyPeer();
                scheduleReconnect('relay-request');
                return;
            }

            if (data.type === 'relay-ack') {
                if (!relayModeEnabled && hasRelayBackend()) {
                    relayModeEnabled = true;
                    refreshActiveRtcConfig();
                }
                setRelayFallbackVisible(false);
                appendMessage('雙方已啟用端對端加密 Relay，正在重新建立通道。', 'system');
                transitionToState(STATE_CONNECTING);
                forceDestroyPeer();
                scheduleReconnect('relay-ack');
                return;
            }

            if (data.type === 'init-answer') {
                if (data.negotiationId && currentNegotiationId && data.negotiationId !== currentNegotiationId) return;
                if (p2pPeer && !p2pPeer.destroyed) p2pPeer.signal(data.signal);
                return;
            }

            if (data.type === 'reconnect-offer') {
                if (currentSystemState === STATE_CONNECTED && p2pPeer && p2pPeer.connected) return;

                const negotiationId = data.negotiationId || randomId();
                const peer = createPeer({
                    initiator: false,
                    signalType: 'reconnect-answer',
                    negotiationId
                });

                peer.signal(data.signal);
                transitionToState(STATE_CONNECTING);
                return;
            }

            if (data.type === 'reconnect-answer') {
                if (data.negotiationId && currentNegotiationId && data.negotiationId !== currentNegotiationId) return;
                if (p2pPeer && !p2pPeer.destroyed) p2pPeer.signal(data.signal);
            }
        } catch (error) {
            logger.error('處理 signaling 失敗', error);
        }
    });
}

function sendMessage() {
    const input = document.getElementById('input-msg');
    const text = input.value.trim();
    if (!text) return;

    if (currentSystemState === STATE_CONNECTED && p2pPeer && p2pPeer.connected) {
        try {
            p2pPeer.send(text);
            Storage.saveMessageLog(currentFriendPk, text, 'me');
            appendMessage(text, 'me');
            input.value = '';
        } catch (error) {
            appendMessage('⚠️ 傳送失敗，正在重新建立通道...', 'system');
            scheduleReconnect('data-send-failed', true);
        }
    } else {
        appendMessage('⚠️ 目前處於離線狀態，正在等待通道自動對接...', 'system');
    }
}

function appendMessage(text, sender) {
    const box = document.getElementById('chat-messages');
    if (!box) return;

    const msgDiv = document.createElement('div');
    msgDiv.classList.add('msg', sender);
    msgDiv.innerText = text;
    box.appendChild(msgDiv);
    box.scrollTop = box.scrollHeight;
}

function restoreChatLogs() {
    const box = document.getElementById('chat-messages');
    if (!box) return;

    box.innerHTML = '';
    const logs = Storage.getMessageLogs(currentFriendPk);
    logs.forEach(function(log) {
        appendMessage(log.text, log.sender);
    });

    if (logs.length === 0) {
        box.innerHTML = '<div class="msg system">加密信道已就緒，等待背景協議對接...</div>';
    }
}

function updateOnlineStatus(isOnline) {
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    if (!dot || !text) return;

    if (isOnline) {
        dot.style.background = '#00FFCC';
        dot.style.boxShadow = '0 0 8px #00FFCC';
        text.innerText = '🟢 P2P SECURE';
        text.style.color = '#00FFCC';
    } else {
        dot.style.background = 'var(--warning)';
        dot.style.boxShadow = 'none';
        text.innerText = '🟠 OFFLINE (RECONNECTING...)';
        text.style.color = 'var(--warning)';
    }
}

function setupPeerEvents() {
    if (!p2pPeer) return;
    const peer = p2pPeer;
    const pc = getPeerConnection(peer);

    peer.on('connect', async function() {
        if (peer !== p2pPeer) return;

        clearPeerTimers();
        reconnectAttempt = 0;

        if (currentFriendPk) {
            Storage.saveFriend(currentFriendPk);
            localStorage.setItem('last_chat_pk', currentFriendPk);
        }

        transitionToState(STATE_CONNECTED);
        setRelayFallbackVisible(false);

        const info = await getSelectedCandidateInfo(peer);
        if (info) {
            const route = info.usingTurn ? 'ENCRYPTED TURN RELAY' : 'DIRECT P2P · NO RELAY';
            const transport = info.relayProtocol || info.protocol || 'unknown';
            updateNetworkDetail(`${route} · ${transport.toUpperCase()} · ${info.localType}/${info.remoteType}`);
            logger.debug(`🌐 ICE route: ${route}, transport=${transport}, local=${info.localType}, remote=${info.remoteType}`);
        } else {
            updateNetworkDetail('P2P CONNECTED');
        }
    });

    peer.on('data', function(data) {
        if (peer !== p2pPeer) return;
        const text = data.toString();
        Storage.saveMessageLog(currentFriendPk, text, 'friend');
        appendMessage(text, 'friend');
    });

    peer.on('close', function() {
        if (peer !== p2pPeer) return;
        logger.debug('🔌 Peer channel closed.');
        if (currentSystemState !== STATE_READY && currentSystemState !== STATE_CREATE_QR && currentSystemState !== STATE_SCAN_QR) {
            transitionToState(STATE_CONNECTING);
            scheduleReconnect('peer-close', true);
        }
    });

    peer.on('error', function(error) {
        if (peer !== p2pPeer) return;
        logger.error('WebRTC peer error', error);
        if (currentSystemState !== STATE_READY) {
            transitionToState(STATE_CONNECTING);
            scheduleReconnect('peer-error', true);
        }
    });

    if (pc) {
        pc.addEventListener('iceconnectionstatechange', function() {
            if (peer !== p2pPeer) return;
            lastIceState = pc.iceConnectionState;
            logger.debug(`🧊 ICE state: ${lastIceState}`);
            updateNetworkDetail(`ICE: ${lastIceState.toUpperCase()}`);

            if (lastIceState === 'connected' || lastIceState === 'completed') {
                if (disconnectGraceTimer) clearTimeout(disconnectGraceTimer);
                disconnectGraceTimer = null;
                return;
            }

            if (lastIceState === 'disconnected') {
                if (disconnectGraceTimer) clearTimeout(disconnectGraceTimer);
                disconnectGraceTimer = setTimeout(function() {
                    if (peer !== p2pPeer) return;
                    if (pc.iceConnectionState === 'disconnected') {
                        logger.debug('🧊 ICE disconnected 超過寬限時間，開始重連。');
                        transitionToState(STATE_CONNECTING);
                        scheduleReconnect('ice-disconnected', true);
                    }
                }, APP_CONFIG.disconnectedGraceMs);
                return;
            }

            if (lastIceState === 'failed') {
                if (!relayModeEnabled && hasRelayBackend()) {
                    setRelayFallbackVisible(true);
                    updateNetworkDetail('DIRECT P2P BLOCKED · RELAY AVAILABLE');
                }
                transitionToState(STATE_CONNECTING);
                scheduleReconnect('ice-failed', true);
            }
        });

        pc.addEventListener('icegatheringstatechange', function() {
            if (peer !== p2pPeer) return;
            logger.debug(`🧊 ICE gathering: ${pc.iceGatheringState}`);
        });

        pc.addEventListener('connectionstatechange', function() {
            if (peer !== p2pPeer) return;
            logger.debug(`🔗 PC state: ${pc.connectionState}`);
        });
    }
}

function amReconnectLeader() {
    return !!(currentFriendPk && myKeyPair.pk > currentFriendPk);
}

function beginReconnectIfLeader(reason) {
    if (currentSystemState !== STATE_CONNECTING || !currentFriendPk) return;
    if (p2pPeer && p2pPeer.connected) {
        transitionToState(STATE_CONNECTED);
        return;
    }

    if (!amReconnectLeader()) {
        logger.debug(`🕓 等待對方發起 reconnect-offer (${reason})。`);
        scheduleReconnect('follower-wait', false);
        return;
    }

    reconnectAttempt += 1;
    currentNegotiationId = randomId();
    logger.debug(`🔁 發起 reconnect #${reconnectAttempt} (${reason})。`);

    createPeer({
        initiator: true,
        signalType: 'reconnect-offer',
        negotiationId: currentNegotiationId
    });
}

function scheduleReconnect(reason, destroyFirst = false) {
    if (currentSystemState === STATE_READY || currentSystemState === STATE_CREATE_QR || currentSystemState === STATE_SCAN_QR) return;
    if (!currentFriendPk) return;
    if (p2pPeer && p2pPeer.connected) return;
    if (reconnectTimer) return;

    if (destroyFirst) forceDestroyPeer();

    const exponent = Math.min(reconnectAttempt, 4);
    const delay = Math.min(
        APP_CONFIG.reconnectBaseDelayMs * Math.pow(2, exponent),
        APP_CONFIG.reconnectMaxDelayMs
    );

    logger.debug(`⏱️ ${Math.round(delay / 100) / 10}s 後重連 (${reason})。`);
    reconnectTimer = setTimeout(async function() {
        reconnectTimer = null;
        if (currentSystemState !== STATE_CONNECTING) return;

        try {
            await nostr.refreshRelays();
            isNostrReady = nostr.hasLiveRelay();
        } catch (error) {
            isNostrReady = false;
        }

        if (!isNostrReady) {
            reconnectAttempt += 1;
            scheduleReconnect('relay-offline');
            return;
        }

        if (amReconnectLeader()) {
            beginReconnectIfLeader(reason);
        } else {
            listenForMessages(currentFriendPk);
            reconnectAttempt += 1;
            scheduleReconnect('still-waiting-for-leader');
        }
    }, delay);
}

async function recoverAfterNetworkChange(reason) {
    if (!navigator.onLine) return;
    logger.debug(`📶 網路恢復/切換：${reason}`);

    // 換網路後重新給 Direct P2P 一次機會。
    // 例如機場 Wi-Fi 曾使用 TURN，回到家用 Wi-Fi 後不應繼續沿用 Relay。
    if (relayModeEnabled && (reason === 'online' || reason === 'connection-change')) {
        resetRelayModeForDirectAttempt(`network-${reason}`, false);
        appendMessage('偵測到網路環境變更；已退出上一個 Relay session，重新優先嘗試 Direct P2P。', 'system');
    } else if (relayModeEnabled && !relayCredentialsStillValid()) {
        resetRelayModeForDirectAttempt(`expired-${reason}`, true);
    }

    try {
        await nostr.refreshRelays();
        isNostrReady = nostr.hasLiveRelay();
    } catch (error) {
        isNostrReady = false;
    }

    startAllBackgroundConnections();

    if (currentFriendPk && currentSystemState !== STATE_READY) {
        transitionToState(STATE_CONNECTING);
        listenForMessages(currentFriendPk);
        scheduleReconnect(`network-${reason}`, true);
    }
}

window.addEventListener('offline', function() {
    logger.debug('📴 Browser reports network offline.');
    if (currentSystemState === STATE_CONNECTED) transitionToState(STATE_CONNECTING);
    updateNetworkDetail('NETWORK OFFLINE');
});

window.addEventListener('online', function() {
    recoverAfterNetworkChange('online');
});

if (navigator.connection && typeof navigator.connection.addEventListener === 'function') {
    navigator.connection.addEventListener('change', function() {
        recoverAfterNetworkChange('connection-change');
    });
}

let appHiddenAt = 0;
let foregroundRecoveryTimer = null;

function peerConnectionLooksHealthy(peer) {
    if (!peer || peer.destroyed || !peer.connected) return false;
    const pc = getPeerConnection(peer);
    if (!pc) return !!peer.connected;
    const ice = pc.iceConnectionState;
    const state = pc.connectionState;
    return (ice === 'connected' || ice === 'completed') &&
        (!state || state === 'connected');
}

function restartStaleBackgroundConnections() {
    for (const [friendPk, session] of backgroundSessions) {
        if (currentFriendPk === friendPk && currentSystemState !== STATE_READY) continue;
        if (peerConnectionLooksHealthy(session.peer)) continue;
        destroyBackgroundPeer(session);
        session.attempt = 0;
        startBackgroundSession(friendPk, 'foreground-resume');
    }
}

async function recoverAfterForeground() {
    if (!navigator.onLine) return;
    const hiddenForMs = appHiddenAt ? Date.now() - appHiddenAt : 0;
    logger.debug(`📱 App 回到前景；背景約 ${Math.round(hiddenForMs / 100) / 10}s。`);

    try {
        await nostr.refreshRelays();
        isNostrReady = nostr.hasLiveRelay();
    } catch (_) {
        isNostrReady = false;
    }

    if (!isNostrReady) {
        logger.debug('🟠 回到前景後暫無 Nostr relay，等待 health monitor 恢復。');
        return;
    }

    restartStaleBackgroundConnections();
    startAllBackgroundConnections();

    if (!currentFriendPk || currentSystemState === STATE_READY ||
        currentSystemState === STATE_CREATE_QR || currentSystemState === STATE_SCAN_QR) return;

    // iOS 可能在背景凍結連線但沒有及時觸發 close/error。
    // 回到前景時直接檢查底層 ICE/PC，而不是只相信 SimplePeer.connected。
    if (peerConnectionLooksHealthy(p2pPeer)) {
        listenForMessages(currentFriendPk);
        transitionToState(STATE_CONNECTED);
        return;
    }

    transitionToState(STATE_CONNECTING);
    listenForMessages(currentFriendPk);
    scheduleReconnect('foreground-resume', true);
}

document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
        appHiddenAt = Date.now();
        return;
    }

    if (!navigator.onLine) return;
    if (foregroundRecoveryTimer) clearTimeout(foregroundRecoveryTimer);
    foregroundRecoveryTimer = setTimeout(function() {
        foregroundRecoveryTimer = null;
        recoverAfterForeground();
    }, 120);
});

// iOS 有時 pageshow / focus 先於或取代 visibilitychange。
window.addEventListener('pageshow', function() {
    if (!document.hidden && navigator.onLine) recoverAfterForeground();
});
window.addEventListener('focus', function() {
    if (!document.hidden && navigator.onLine) recoverAfterForeground();
});
