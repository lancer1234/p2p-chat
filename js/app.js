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

function setRelayFallbackVisible(visible) {
    const bar = document.getElementById('relay-fallback-bar');
    if (bar) bar.style.display = visible ? 'block' : 'none';
}

function refreshActiveRtcConfig() {
    rtcConfig = relayModeEnabled ? relayRtcConfig : directRtcConfig;
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
        const savedLastPk = Storage.getLastChatPk();
        document.getElementById('btn-resume').style.display = savedLastPk ? 'block' : 'none';
    } else if (nextState === STATE_CREATE_QR) {
        document.getElementById('qrcode-container').style.display = 'block';
    } else if (nextState === STATE_SCAN_QR) {
        document.getElementById('reader').style.display = 'block';
    } else if (nextState === STATE_CONNECTING || nextState === STATE_CONNECTED) {
        document.getElementById('chat-interface').style.display = 'flex';
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
    const onAnyRelayConnectedTrigger = function() {
        if (!isNostrReady) logger.debug('✅ 至少一個 Nostr relay 已接通。');
        isNostrReady = true;
    };

    nostr.connect(updateRelayUIIndicator, onAnyRelayConnectedTrigger)
        .then(function() {
            isNostrReady = true;
        })
        .catch(function(error) {
            isNostrReady = false;
            logger.error('Nostr relay 全數無法連線', error);
        });
}

document.getElementById('btn-resume').addEventListener('click', function() {
    if (!isNostrReady) {
        alert('矩陣仍在同步中，請稍候。');
        return;
    }

    const savedLastPk = Storage.getLastChatPk();
    if (!isValidPubkey(savedLastPk)) return;

    clearPeerTimers();
    forceDestroyPeer();
    currentFriendPk = savedLastPk;
    currentNegotiationId = null;
    reconnectAttempt = 0;

    transitionToState(STATE_CONNECTING);
    restoreChatLogs();
    listenForMessages(currentFriendPk);
    beginReconnectIfLeader('resume');
});

document.getElementById('btn-create').addEventListener('click', startAsQrOwner);
document.getElementById('btn-scan').addEventListener('click', startCameraScan);
document.getElementById('btn-send').addEventListener('click', sendMessage);
document.getElementById('btn-leave').addEventListener('click', leaveChat);
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
    if (e.key === 'Enter') sendMessage();
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
    nostr.clearAllSubscriptions();
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
                appendMessage('對方已離開對話。', 'system');
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

async function leaveChat() {
    if (!confirm('確定要終止並離開對話？這將會徹底抹除本地的所有對話紀錄。')) return;

    if (currentFriendPk && isNostrReady) {
        try {
            const encrypted = await encodeSignaling(currentFriendPk, {
                type: 'leave',
                negotiationId: currentNegotiationId
            });
            await nostr.sendEvent(myKeyPair.sk, currentFriendPk, encrypted);
        } catch (error) {
            logger.error('leave signaling 發送失敗', error);
        }
    }

    if (currentFriendPk) Storage.clearSession(currentFriendPk);
    clearSessionState();
    currentFriendPk = null;
    transitionToState(STATE_READY);
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

    try {
        await nostr.refreshRelays();
        isNostrReady = nostr.hasLiveRelay();
    } catch (error) {
        isNostrReady = false;
    }

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

document.addEventListener('visibilitychange', function() {
    if (!document.hidden && navigator.onLine && currentFriendPk && currentSystemState === STATE_CONNECTING) {
        recoverAfterNetworkChange('foreground');
    }
});
