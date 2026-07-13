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
let qrTimeoutTimer = null; 
let userPin = "";
let reconnectTimeoutTimer = null; 

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.services.mozilla.com' }
    ]
};

function updateRelayUIIndicator(index, isConnected) {
    const el = document.getElementById(`relay-${index}`);
    if (!el) return;
    if (isConnected) {
        el.className = "relay-status ok";
        el.innerText = "🟢 ON";
    } else {
        el.className = "relay-status fail";
        el.innerText = "🔴 OFF";
    }
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

// 🟢 修正點 2：對應 HTML 中真正的 id="pin-input"，完美封殺 TypeError
document.getElementById('checkbox-show-pin').addEventListener('change', function(e) {
    document.getElementById('pin-input').type = e.target.checked ? "text" : "password";
});

document.getElementById('btn-reset-identity').addEventListener('click', function() {
    const step1 = confirm("⚠️ 警告：即將物理清除身分！是否確定？");
    if (!step1) return;
    Storage.resetIdentity();
    location.reload();
});

async function executeUnlockFlow() {
    const pinInput = document.getElementById('pin-input').value;
    if (isWeakPassword(pinInput)) {
        alert("安全強度不足！密碼長度必須大於等於 8 位。");
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
            logger.debug("✨ 全新身分硬化儲存完畢。");
        }
        
        transitionToState(STATE_READY);
        bootstrapApp();
    } catch(e) {
        console.error(e);
        alert("解密驗證失敗！密碼錯誤或身分資料已受損。");
    }
}

document.getElementById('btn-unlock').addEventListener('click', executeUnlockFlow);

function bootstrapApp() {
    const onAnyRelayConnectedTrigger = function() {
        // 💡 修正點 1 落地：不使用舊版 API，只要收到連線池的成功回呼，100% 釋放 READY 狀態鎖
        if (!isNostrReady) {
            isNostrReady = true;
            logger.debug("🌐 全球信令陣列接通就緒。");
        }
    };

    nostr.connect(updateRelayUIIndicator, onAnyRelayConnectedTrigger).then(function() {
        isNostrReady = true;
    }).catch(function(err) {
        console.error("Pool連線阻斷", err);
    });
}

document.getElementById('btn-resume').addEventListener('click', function() {
    if (!isNostrReady) { alert("信令矩陣仍在同步中，請稍候。"); return; }
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
    nostr.clearAllSubscriptions();
    if (initTimer) clearInterval(initTimer);
    if (reconnectTimeoutTimer) clearTimeout(reconnectTimeoutTimer);
    if (qrTimeoutTimer) clearTimeout(qrTimeoutTimer);
    forceDestroyPeer();
}

async function handleIncomingInitiatorSignal(rawContent, authorPk) {
    if (currentSystemState !== STATE_CREATE_QR || !authorPk) return;
    if (p2pPeer && p2pPeer.connected) return;

    try {
        let data = null;
        try { data = JSON.parse(rawContent); } 
        catch (jsonErr) {
            try {
                const decryptedText = await Crypto.decryptData(myKeyPair.sk, authorPk, rawContent);
                if (decryptedText) data = JSON.parse(decryptedText);
            } catch (cryptoErr) { return; }
        }

        if (!isValidSignalingSchema(data) || data.type !== 'init-offer') return;

        if (initTimer) clearInterval(initTimer);
        if (qrTimeoutTimer) clearTimeout(qrTimeoutTimer);

        currentFriendPk = authorPk;
        forceDestroyPeer();
        
        p2pPeer = new window.SimplePeer({ initiator: false, trickle: false, config: rtcConfig });
        setupPeerEvents(); 
        p2pPeer.signal(data.sdp);

        p2pPeer.on('signal', async function(webrtcAnswer) {
            const answerPackage = { type: 'init-answer', sdp: webrtcAnswer };
            await nostr.sendEvent(myKeyPair.sk, currentFriendPk, JSON.stringify(answerPackage));
        });

        transitionToState(STATE_CONNECTING);
        restoreChatLogs();
        listenForMessages(currentFriendPk);
    } catch (e) { console.error(e); }
}

function startAsInitiator() {
    if (!isNostrReady) { alert("Nostr 矩陣尚未接通，請稍候。"); return; }
    
    clearSessionState();
    currentFriendPk = null;
    forceDestroyPeer();
    
    transitionToState(STATE_CREATE_QR);
    
    const container = document.getElementById('qrcode-container');
    const qr = window.qrcode(0, 'M');
    qr.addData(myKeyPair.pk);
    qr.make();
    container.innerHTML = '<h3>請對方掃描 QR Code</h3>' + qr.createImgTag(6);

    qrTimeoutTimer = setTimeout(function() {
        if (currentSystemState === STATE_CREATE_QR) {
            alert("⏳ 配對逾時，系統已自動重置。");
            clearSessionState();
            transitionToState(STATE_READY);
        }
    }, 60000);

    const runSubscription = function() {
        if (currentSystemState !== STATE_CREATE_QR) return;
        logger.debug("📡 等待配對 Offer 中...");
        nostr.subscribeToFriend(myKeyPair.pk, GLOBAL_CHANNEL, handleIncomingInitiatorSignal);
    };

    runSubscription();
    initTimer = setInterval(function() {
        if (currentSystemState === STATE_CREATE_QR) runSubscription();
        else clearInterval(initTimer);
    }, 5000);
}

function startCameraScan() {
    if (!isNostrReady) { alert("Nostr 矩陣尚未接通，請稍候。"); return; }
    
    clearSessionState();
    currentFriendPk = null;
    forceDestroyPeer();
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
        text.innerText = '🟢 P2P 直連管道打通 (SECURITY)';
        text.style.color = '#00FFCC';
    } else {
        dot.style.background = 'var(--warning)';
        dot.style.boxShadow = 'none';
        text.innerText = '🔴 離線 (中記矩陣背景重連中...)';
        text.style.color = 'var(--warning)';
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
        if (currentFriendPk) {
            Storage.saveFriend(currentFriendPk);
            localStorage.setItem('last_chat_pk', currentFriendPk);
        }
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
        if (currentSystemState === STATE_CONNECTED) transitionToState(STATE_CONNECTING);
    });
}

async function triggerNostrReconnect() {
    if (currentSystemState !== STATE_CONNECTING || !currentFriendPk || !isNostrReady) return;
    if (p2pPeer && p2pPeer.connected) { transitionToState(STATE_CONNECTED); return; }

    forceDestroyPeer();

    if (reconnectTimeoutTimer) clearTimeout(reconnectTimeoutTimer);
    reconnectTimeoutTimer = setTimeout(function() {
        if (currentSystemState === STATE_CONNECTING) {
            logger.debug("⏳ 探測冷卻結束，引導下一輪對接。");
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
    if (currentSystemState === STATE_CONNECTING) {
        triggerNostrReconnect();
    }
}, 12000);
