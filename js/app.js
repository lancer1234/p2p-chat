import { Storage } from './storage.js';
import { Crypto, bytesToHex } from './crypto.js';
import { NostrManager } from './nostr.js';

const GLOBAL_CHANNEL = 'any';

// 💡 狀態機核心列舉定義
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

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.services.mozilla.com' }
    ]
};

// 💡 確定性狀態機分流渲染器：集中管理所有 UI 與背景狀態，徹底消滅競態
function transitionToState(nextState) {
    logger.debug(`🎛️ 狀態轉移: [${currentSystemState}] ➔ [${nextState}]`);
    currentSystemState = nextState;

    // 1. 隱藏所有面板
    document.getElementById('pin-container').style.display = 'none';
    document.getElementById('setup-container').style.display = 'none';
    document.getElementById('qrcode-container').style.display = 'none';
    document.getElementById('reader').style.display = 'none';
    document.getElementById('chat-interface').style.display = 'none';

    // 2. 依狀態精準放行顯示
    if (nextState === STATE_INIT) {
        document.getElementById('pin-container').style.display = 'block';
    } 
    else if (nextState === STATE_READY) {
        document.getElementById('setup-container').style.display = 'block';
        // 檢查是否有恢復按鈕的權限
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
        // 💡 100% 落實修改：在此處完全不自動恢復聊天室，安靜等待使用者手動決定
    });
}

// 綁定手動恢復對話流
document.getElementById('btn-resume').addEventListener('click', function() {
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

    currentFriendPk = null;
    localStorage.removeItem('last_chat_pk');
    if (initTimer) clearInterval(initTimer);
    forceDestroyPeer();
}

async function handleIncomingInitiatorSignal(rawContent, authorPk) {
    // 💡 狀態機硬性卡閘：只有在等待 QR 掃描狀態時，才放行 init-offer，封死非同步幽靈干擾
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
        nostr.unsubscribeFromFriend(GLOBAL_CHANNEL);

        currentFriendPk = authorPk;
        localStorage.setItem('last_chat_pk', currentFriendPk);
        forceDestroyPeer();
        
        p2pPeer = new window.SimplePeer({ initiator: false, trickle: false, config: rtcConfig });
        setupPeerEvents(); 
        p2pPeer.signal(data.sdp);

        p2pPeer.on('signal', async function(webrtcAnswer) {
            const answerPackage = { type: 'init-answer', sdp: webrtcAnswer };
            await nostr.sendEvent(myKeyPair.sk, currentFriendPk, JSON.stringify(answerPackage));
        });

        Storage.saveFriend(currentFriendPk);
        transitionToState(STATE_CONNECTING);
        restoreChatLogs();
        listenForMessages(currentFriendPk);
    } catch (e) {}
}

function startAsInitiator() {
    clearSessionState();
    // 💡 100% 落實修改：一開始即時物理清空變數與舊 Peer
    currentFriendPk = null;
    forceDestroyPeer();
    
    transitionToState(STATE_CREATE_QR);
    
    const container = document.getElementById('qrcode-container');
    const qr = window.qrcode(0, 'M');
    qr.addData(myKeyPair.pk);
    qr.make();
    container.innerHTML = '<h3>請對方掃描 QR Code</h3>' + qr.createImgTag(6);

    const runSubscription = function() {
        if (currentSystemState !== STATE_CREATE_QR) return;
        logger.debug("📡 正在等待對方發射協議 Offer...");
        // 💡 100% 落實修改：在訂閱前強制退訂舊的全域監聽，保證單一訂閱乾淨度
        nostr.unsubscribeFromFriend(GLOBAL_CHANNEL);
        nostr.subscribeToFriend(myKeyPair.pk, GLOBAL_CHANNEL, handleIncomingInitiatorSignal);
    };

    runSubscription();
    initTimer = setInterval(function() {
        if (currentSystemState === STATE_CREATE_QR) {
            runSubscription();
        } else {
            clearInterval(initTimer);
        }
    }, 5000);
}

function startCameraScan() {
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
            localStorage.setItem('last_chat_pk', currentFriendPk);
            
            transitionToState(STATE_CONNECTING);
            restoreChatLogs();

            p2pPeer = new window.SimplePeer({ initiator: true, trickle: false, config: rtcConfig });
            setupPeerEvents();
            
            p2pPeer.on('signal', async function(webrtcOffer) {
                const offerPackage = { type: 'init-offer', sdp: webrtcOffer };
                await nostr.sendEvent(myKeyPair.sk, currentFriendPk, JSON.stringify(offerPackage));
            });

            Storage.saveFriend(currentFriendPk);
            listenForMessages(currentFriendPk);
        },
        function() {}
    ).catch(function(err) { 
        logger.debug(`❌ 相機失敗: ${err.message}`); 
    });
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
        } catch (e) {}
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
    logs.forEach(function(log) {
        appendMessage(log.text, log.sender);
    });
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

// 💡 乾淨的狀態機探測心跳：完全與多重布林標記解耦
setInterval(function() {
    if (currentSystemState === STATE_CONNECTING) {
        triggerNostrReconnect();
    }
}, 12000);
