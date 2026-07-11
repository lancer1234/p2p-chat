import { Storage } from './storage.js';
import { Crypto, bytesToHex } from './crypto.js';
import { NostrManager } from './nostr.js';

const GLOBAL_CHANNEL = 'any';

const STATE_INIT = "INIT";
const STATE_READY = "READY";
const STATE_CREATE_QR = "CREATE_QR";
const STATE_SCAN_QR = "SCAN_QR";
const STATE_CONNECTING = "CONNECTING";
const STATE_CONNECTED = "CONNECTED";

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
    }
}
const logger = new SafeLogger(false);

let myKeyPair = { sk: null, pk: null };
let p2pPeer = null;
let currentFriendPk = null; 
let nostr = new NostrManager(); 
let isNostrReady = false;
let initTimer = null;
let userPin = "";
let reconnectTimeoutTimer = null; // 💡 全局重連超時器

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.services.mozilla.com' }
    ]
};

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
    } 
    else if (nextState === STATE_READY) {
        document.getElementById('setup-container').style.display = 'block';
        const savedLastPk = Storage.getLastChatPk();
        document.getElementById('btn-resume').style.display = savedLastPk ? 'block' : 'none';
    } 
    else if (nextState === STATE_CREATE_QR) {
        document.getElementById('qrcode-container').style.display = 'block';
    } 
    else if (nextState === STATE_SCAN_QR) {
        document.getElementById('reader').style.display = 'block';
    } 
    else if (nextState === STATE_CONNECTING || nextState === STATE_CONNECTED) {
        document.getElementById('chat-interface').style.display = 'flex';
        updateOnlineStatus(nextState === STATE_CONNECTED);
    }
}

function isWeakPassword(pin) {
    const weakPatterns = ["12345678", "00000000", "11111111", "88888888", "password"];
    return pin.length < 8 || weakPatterns.includes(pin.toLowerCase());
}

function isValidSignalingSchema(data) {
    if (!data || typeof data !== 'object') return false;
    const validTypes = ['init-offer', 'init-answer', 'reconnect-offer', 'reconnect-answer'];
    return validTypes.includes(data.type) && data.sdp;
}

async function executeUnlockFlow() {
    const pinInput = document.getElementById('input-pin').value;
    if (isWeakPassword(pinInput)) {
        alert("安全強度不足！密碼長度必須大於等於 8 位，且禁止使用連續或單一重複數字。");
        return;
    }
    userPin = pinInput;
    
    const cached = Storage.getEncryptedKeyPair();
    try {
        if (cached.esk && cached.pk) {
            const decryptedSk = await Crypto.decryptSecret(cached.esk, userPin);
            myKeyPair = { sk: decryptedSk, pk: cached.pk };
            logger.debug("🔑 身分解鎖成功。");
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
            myKeyPair = { sk: skHex, pk: pk };
            logger.debug("✨ 全新密碼學硬化身分建立完畢。");
        }
        
        transitionToState(STATE_READY);
        bootstrapApp();
    } catch(e) {
        console.error(e);
        alert(e.stack || e.message || "密碼錯誤或身分金鑰受損！");
    }
}

document.getElementById('btn-unlock').addEventListener('click', executeUnlockFlow);

function bootstrapApp() {
    nostr.connect().then(function() {
        isNostrReady = true;
        logger.debug("🌐 全球信令陣列接通就緒。");
    }).catch(function(err) {
        logger.debug(`❌ 信令網初始化失敗: ${err.message}`);
    });
}

document.getElementById('btn-resume').addEventListener('click', function() {
    if (!isNostrReady) { alert("信令中繼站仍在連線中，請稍候 1~2 秒。"); return; }
    const savedLastPk = Storage.getLastChatPk();
    if (!savedLastPk) return;
    
    currentFriendPk = savedLastPk;
    transitionToState(STATE_CONNECTING);
    restoreChatLogs();
    listenForMessages(currentFriendPk);
    triggerNostrReconnect();
});

document.getElementById('btn-create').addEventListener('click', startAsInitiator);
document.getElementById('btn-scan').addEventListener('click', startCameraScan);
document.getElementById('btn-send').addEventListener('click', sendMessage);
document.getElementById('btn-leave').addEventListener('click', leaveChat);

document.getElementById('input-msg').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') sendMessage();
});

function forceDestroyPeer() {
    if (p2pPeer) {
        try {
            p2pPeer.removeAllListeners();
            p2pPeer.destroy();
        } catch(e) {}
        p2pPeer = null;
    }
}

function clearSessionState() {
    if (currentFriendPk) nostr.unsubscribeFromFriend(currentFriendPk);
    nostr.unsubscribeFromFriend(GLOBAL_CHANNEL);
    if (initTimer) clearInterval(initTimer);
    if (reconnectTimeoutTimer) clearTimeout(reconnectTimeoutTimer);
    isReconnecting = false;
    forceDestroyPeer();
}

async function handleIncomingInitiatorSignal(rawContent, authorPk) {
    // 💡 100% 落實修改 1：精準卡閘，只有在展示 QR 等待配對狀態時才允許解析 init-offer
    if (currentSystemState !== STATE_CREATE_QR || !authorPk) return;
    if (p2pPeer && p2pPeer.connected) return;

    try {
        let data = null;
        try { data = JSON.parse(rawContent); } 
        catch (jsonErr) {
            try {
                const decryptedText = await Crypto.decryptData(myKeyPair.sk, authorPk, rawContent);
                if (decryptedText) data = JSON.parse(decryptedText);
            } catch (cryptoErr) { 
                console.error("解密無效信號包", cryptoErr);
                return; 
            }
        }

        if (!isValidSignalingSchema(data) || data.type !== 'init-offer') return;

        if (initTimer) clearInterval(initTimer);
        nostr.unsubscribeFromFriend(GLOBAL_CHANNEL);

        currentFriendPk = authorPk;
        forceDestroyPeer();
        
        p2pPeer = new window.SimplePeer({ initiator: false, trickle: false, config: rtcConfig });
        setupPeerEvents(); 
        p2pPeer.signal(data.sdp);

        p2pPeer.on('signal', async function(webrtcAnswer) {
            const answerPackage = { type: 'init-answer', sdp: webrtcAnswer };
            await nostr.sendEvent(myKeyPair.sk, currentFriendPk, JSON.stringify(answerPackage));
        });

        // 💡 100% 落實修改：在此處【絕不】寫入快取，僅切換到連線中畫面，靜候 WebRTC 成功對接
        transitionToState(STATE_CONNECTING);
        restoreChatLogs();
        listenForMessages(currentFriendPk);
    } catch (e) { console.error(e); }
}

function startAsInitiator() {
    if (!isNostrReady) { alert("Nostr 矩陣尚未接通，請稍候 1~2 秒再試。"); return; }
    
    clearSessionState();
    currentFriendPk = null;
    
    transitionToState(STATE_CREATE_QR);
    
    const container = document.getElementById('qrcode-container');
    const qr = window.qrcode(0, 'M');
    qr.addData(myKeyPair.pk);
    qr.make();
    container.innerHTML = '<h3>請對方掃描 QR Code</h3>' + qr.createImgTag(6);

    const runSubscription = function() {
        if (currentSystemState !== STATE_CREATE_QR) return;
        logger.debug("📡 正在開啟萬能集線器，等待對方 Offer...");
        // 💡 100% 落實修改：subscribe 前先強制斬斷舊頻道，在 nostr.js 內部也做了去重覆保護
        nostr.unsubscribeFromFriend(GLOBAL_CHANNEL);
        nostr.subscribeToFriend(myKeyPair.pk, GLOBAL_CHANNEL, handleIncomingInitiatorSignal);
    };

    runSubscription();
    initTimer = setInterval(function() {
        if (currentSystemState === STATE_CREATE_QR) runSubscription();
        else clearInterval(initTimer);
    }, 5000);
}

function startCameraScan() {
    if (!isNostrReady) { alert("Nostr 矩陣尚未接通，請稍候 1~2 秒再試。"); return; }
    
    clearSessionState();
    currentFriendPk = null;
    transitionToState(STATE_SCAN_QR);

    const html5QrcodeScanner = new window.Html5Qrcode("reader");
    html5QrcodeScanner.start(
        { facingMode: "environment" }, { fps: 20, qrbox: 250 }, 
        async function(decodedFriendPk) {
            try { await html5QrcodeScanner.stop(); } catch (err) {}
            if (currentSystemState !== STATE_SCAN_QR) return;
            
            currentFriendPk = decodedFriendPk;
            transitionToState(STATE_CONNECTING);
            restoreChatLogs();

            p2pPeer = new window.SimplePeer({ initiator: true, trickle: false, config: rtcConfig });
            setupPeerEvents();
            
            p2pPeer.on('signal', async function(webrtcOffer) {
                const offerPackage = { type: 'init-offer', sdp: webrtcOffer };
                await nostr.sendEvent(myKeyPair.sk, currentFriendPk, JSON.stringify(offerPackage));
            });

            listenForMessages(currentFriendPk);
        },
        function() {}
    ).catch(function(err) { logger.error(err); });
}

function listenForMessages(friendPk) {
    if (!friendPk) return;
    // 💡 100% 落實修改：在重新監聽前，物理阻斷該聯絡人的舊訂閱，杜絕重複疊加 callback
    nostr.unsubscribeFromFriend(friendPk);
    
    nostr.subscribeToFriend(myKeyPair.pk, friendPk, async function(rawContent, authorPk) {
        try {
            if (rawContent.length > 50000 || currentSystemState === STATE_READY) return;
            const senderPk = authorPk || friendPk;
            let data = null;
            
            try { data = JSON.parse(rawContent); } 
            catch (jsonErr) {
                try {
                    const decryptedText = await Crypto.decryptData(myKeyPair.sk, senderPk, rawContent);
                    if (decryptedText) data = JSON.parse(decryptedText);
                } catch (cryptoErr) { return; }
            }
            
            if (!isValidSignalingSchema(data)) return;

            if (data.type === 'init-answer') {
                if (p2pPeer && !p2pPeer.destroyed) p2pPeer.signal(data.sdp);
            } 
            else if (data.type === 'reconnect-offer') {
                forceDestroyPeer();
                p2pPeer = new window.SimplePeer({ initiator: false, trickle: false, config: rtcConfig });
                setupPeerEvents();
                p2pPeer.signal(data.sdp);

                p2pPeer.on('signal', async function(myNewAnswer) {
                    const reconnectAnswer = { type: 'reconnect-answer', sdp: myNewAnswer };
                    const encAnswer = await Crypto.encryptData(myKeyPair.sk, senderPk, JSON.stringify(reconnectAnswer));
                    await nostr.sendEvent(myKeyPair.sk, senderPk, encAnswer);
                });
            } else if (data.type === 'reconnect-answer') {
                if (p2pPeer && !p2pPeer.destroyed) p2pPeer.signal(data.sdp);
            }
        } catch (e) { console.error(e); }
    });
}

function sendMessage() {
    const input = document.getElementById('input-msg');
    const text = input.value.trim();
    if (!text) return;

    if (currentSystemState === STATE_CONNECTED && p2pPeer && p2pPeer.connected) {
        p2pPeer.send(text);
        Storage.saveMessageLog(currentFriendPk, text, 'me');
        appendMessage(text, 'me');
        input.value = '';
    } else {
        appendMessage("⚠️ 目前處於離線狀態，正在等待通道自動對接...", "system");
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
    logs.forEach(function(log) { appendMessage(log.text, log.sender); });
    if (logs.length === 0) {
        box.innerHTML = `<div class="msg system">加密信道已就緒，等待背景協議對接...</div>`;
    }
}

function updateOnlineStatus(isOnline) {
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    if (!dot || !text) return;
    if (isOnline) {
        dot.style.background = '#00FFCC';
        dot.style.boxShadow = '0 0 8px #00FFCC';
        text.innerText = 'ONLINE';
        text.style.color = '#00FFCC';
    } else {
        dot.style.background = '#52525B';
        dot.style.boxShadow = 'none';
        text.innerText = 'OFFLINE (RECONNECTING)';
        text.style.color = '#52525B';
    }
}

async function leaveChat() {
    if (!confirm("確定要終止並離開對話？這將會徹底抹除本地的所有對話紀錄。")) return;

    if (currentFriendPk && isNostrReady) {
        try {
            const leavePackage = { type: 'leave' };
            const encLeave = await Crypto.encryptData(myKeyPair.sk, currentFriendPk, JSON.stringify(leavePackage));
            await nostr.sendEvent(myKeyPair.sk, currentFriendPk, encLeave);
        } catch (e) {}
    }

    if (currentFriendPk) Storage.clearSession(currentFriendPk);
    clearSessionState();
    transitionToState(STATE_READY);
}

function setupPeerEvents() {
    if (!p2pPeer) return;

    p2pPeer.on('connect', function() {
        // 💡 100% 落實修改 2：只有當 WebRTC 真正握手打通的這一瞬間，才允許將資料永久化寫入快取與快取歷史！
        if (currentFriendPk) {
            Storage.saveFriend(currentFriendPk);
            localStorage.setItem('last_chat_pk', currentFriendPk);
        }
        isReconnecting = false;
        if (reconnectTimeoutTimer) clearTimeout(reconnectTimeoutTimer);
        transitionToState(STATE_CONNECTED);
    });

    p2pPeer.on('data', function(data) {
        const text = data.toString();
        Storage.saveMessageLog(currentFriendPk, text, 'friend');
        appendMessage(text, 'friend');
    });

    p2pPeer.on('close', function() { 
        if (currentSystemState === STATE_CONNECTED) transitionToState(STATE_CONNECTING);
    });
    p2pPeer.on('error', function(err) { 
        console.error("WebRTC底層通訊重置", err);
        if (currentSystemState === STATE_CONNECTED) transitionToState(STATE_CONNECTING);
    });
}

async function triggerNostrReconnect() {
    if (currentSystemState !== STATE_CONNECTING || !currentFriendPk || !isNostrReady || isReconnecting) return;

    isReconnecting = true; 
    updateOnlineStatus(false);
    forceDestroyPeer();

    // 💡 100% 落實修改 4：為 initiator 與 receiver 雙向分支建立平等的 15 秒重連解鎖超時保護
    if (reconnectTimeoutTimer) clearTimeout(reconnectTimeoutTimer);
    reconnectTimeoutTimer = setTimeout(function() {
        if (isReconnecting && currentSystemState === STATE_CONNECTING) {
            logger.debug("⏳ 重連發射超時保護發動，解除 Reconnecting 鎖定引導下一輪探測。");
            isReconnecting = false;
        }
    }, 15000);

    const amIInitiator = myKeyPair.pk > currentFriendPk;

    if (amIInitiator) {
        p2pPeer = new window.SimplePeer({ initiator: true, trickle: false, config: rtcConfig });
        setupPeerEvents(); 

        p2pPeer.on('signal', async function(newWebrtcData) {
            if (currentSystemState !== STATE_CONNECTING) return;
            const reconnectOffer = { type: 'reconnect-offer', sdp: newWebrtcData };
            const encryptedMessage = await Crypto.encryptData(myKeyPair.sk, currentFriendPk, JSON.stringify(reconnectOffer));
            await nostr.sendEvent(myKeyPair.sk, currentFriendPk, encryptedMessage);
        });
    } else {
        p2pPeer = new window.SimplePeer({ initiator: false, trickle: false, config: rtcConfig });
        setupPeerEvents();
    }
}

setInterval(function() {
    if (currentSystemState === STATE_CONNECTING && !isReconnecting) {
        triggerNostrReconnect();
    }
}, 12000);
