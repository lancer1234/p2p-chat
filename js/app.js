import { Storage } from './storage.js';
import { Crypto } from './crypto.js';
import { NostrManager } from './nostr.js';

const GLOBAL_CHANNEL = 'any';

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
let isReconnecting = false;
let isInChatMode = false; 
let initTimer = null;
let isGeneratingQR = false;
let isScanningQR = false;
let userPin = "";

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.services.mozilla.com' }
    ]
};

function isWeakPassword(pin) {
    const weakPatterns = ["12345678", "00000000", "11111111", "88888888", "password"];
    return pin.length < 8 || weakPatterns.includes(pin.toLowerCase());
}

function isValidSignalingSchema(data) {
    if (!data || typeof data !== 'object') return false;
    const validTypes = ['init-offer', 'init-answer', 'reconnect-offer', 'reconnect-answer'];
    return validTypes.includes(data.type) && data.sdp;
}

// 🟢 密鑰解鎖核心流（已補強錯誤追蹤）
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
            // 💡 修正點 4：向下相容新舊版 nostr-tools (v1 使用 generatePrivateKey, v2 改名為 generateSecretKey)
            let skBytes;
            if (typeof window.NostrTools.generateSecretKey === 'function') {
                skBytes = window.NostrTools.generateSecretKey();
            } else {
                skBytes = window.NostrTools.generatePrivateKey();
            }
            const skHex = typeof skBytes === 'string' ? skBytes : window.NostrTools.bytesToHex(skBytes);
            const pk = window.NostrTools.getPublicKey(skHex);
            
            const encryptedSkHex = await Crypto.encryptSecret(skHex, userPin);
            Storage.saveEncryptedKeyPair(encryptedSkHex, pk);
            myKeyPair = { sk: skHex, pk: pk };
            logger.debug("✨ 全新密碼學硬化身分建立完畢。");
        }
        
        document.getElementById('pin-container').style.display = 'none';
        document.getElementById('setup-container').style.display = 'block';
        bootstrapApp();
    } catch(e) {
        // 💡 修正點 1：落實 Code Review 精神，徹底把底層拋出的 Web Crypto Error 回顯至畫面
        console.error("🔒 [Security Module Error]", e);
        alert(e.stack || e.message || "未知密碼學核心錯誤");
    }
}

document.getElementById('btn-unlock').addEventListener('click', executeUnlockFlow);

function bootstrapApp() {
    nostr.connect().then(function() {
        isNostrReady = true;
        const savedLastPk = Storage.getLastChatPk();
        if (savedLastPk && !isGeneratingQR && !isScanningQR) {
            currentFriendPk = savedLastPk;
            isInChatMode = true; 
            showChatInterface();
            restoreChatLogs();
            updateOnlineStatus(false);
            listenForMessages(currentFriendPk);
            
            setTimeout(function() {
                if (!isGeneratingQR && !isScanningQR && isInChatMode) {
                    triggerNostrReconnect();
                }
            }, 1500);
        }
    });
}

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

    isInChatMode = false;
    isReconnecting = false;
    currentFriendPk = null;
    localStorage.removeItem('last_chat_pk');
    if (initTimer) clearInterval(initTimer);
    forceDestroyPeer();
    
    document.getElementById('chat-interface').style.display = 'none';
    document.getElementById('qrcode-container').style.display = 'none';
    document.getElementById('reader').style.display = 'none';
    document.getElementById('setup-container').style.display = 'block';
}

async function handleIncomingInitiatorSignal(rawContent, authorPk) {
    if (rawContent.length > 50000 || !isGeneratingQR || isInChatMode || !authorPk) return;
    if (p2pPeer && p2pPeer.connected) return;

    try {
        let data = null;
        try {
            data = JSON.parse(rawContent);
        } catch (jsonErr) {
            try {
                const decryptedText = await Crypto.decryptData(myKeyPair.sk, authorPk, rawContent);
                if (decryptedText) data = JSON.parse(decryptedText);
            } catch (cryptoErr) { 
                return; 
            }
        }

        if (!isValidSignalingSchema(data) || data.type !== 'init-offer') return;

        isGeneratingQR = false; 
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
        isInChatMode = true;
        showChatInterface();
        restoreChatLogs();
        listenForMessages(currentFriendPk);
    } catch (e) {}
}

function startAsInitiator() {
    clearSessionState();
    isGeneratingQR = true;  
    isScanningQR = false;
    
    document.getElementById('setup-container').style.display = 'none';
    const container = document.getElementById('qrcode-container');
    container.style.display = 'block';
    
    const qr = window.qrcode(0, 'M');
    qr.addData(myKeyPair.pk);
    qr.make();
    container.innerHTML = '<h3>請對方掃描 QR Code</h3>' + qr.createImgTag(6);

    const runSubscription = function() {
        if (!isGeneratingQR || isInChatMode) return;
        if (p2pPeer && p2pPeer.connected) return;
        logger.debug("📡 正在等待對方發射協議 Offer...");
        nostr.subscribeToFriend(myKeyPair.pk, GLOBAL_CHANNEL, handleIncomingInitiatorSignal);
    };

    runSubscription();
    initTimer = setInterval(function() {
        if (isGeneratingQR && !isInChatMode) {
            runSubscription();
        } else {
            clearInterval(initTimer);
        }
    }, 5000);
}

function startCameraScan() {
    clearSessionState();
    isScanningQR = true; 
    isGeneratingQR = false;

    document.getElementById('setup-container').style.display = 'none';
    document.getElementById('reader').style.display = 'block';

    const html5QrcodeScanner = new window.Html5Qrcode("reader");
    html5QrcodeScanner.start(
        { facingMode: "environment" }, { fps: 20, qrbox: 250 }, 
        async function(decodedFriendPk) {
            try { await html5QrcodeScanner.stop(); } catch (err) {}
            document.getElementById('reader').style.display = 'none';
            
            if (!isScanningQR) return;
            isScanningQR = false; 
            
            currentFriendPk = decodedFriendPk;
            localStorage.setItem('last_chat_pk', currentFriendPk);
            isInChatMode = true; 
            showChatInterface();

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
            if (rawContent.length > 50000 || isGeneratingQR || isScanningQR) return;
            const senderPk = authorPk || friendPk;
            let data = null;
            
            try {
                data = JSON.parse(rawContent);
            } catch (jsonErr) {
                try {
                    const decryptedText = await Crypto.decryptData(myKeyPair.sk, senderPk, rawContent);
                    if (decryptedText) data = JSON.parse(decryptedText);
                } catch (cryptoErr) { 
                    return; 
                }
            }
            
            if (!isValidSignalingSchema(data)) return;
            if (!isInChatMode) return;

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

    if (p2pPeer && p2pPeer.connected) {
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

function showChatInterface() {
    document.getElementById('setup-container').style.display = 'none';
    document.getElementById('qrcode-container').style.display = 'none';
    document.getElementById('reader').style.display = 'none';
    document.getElementById('chat-interface').style.display = 'flex';
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
        isReconnecting = false; 
    } else {
        dot.style.background = '#52525B';
        dot.style.boxShadow = 'none';
        text.innerText = isReconnecting ? 'OFFLINE (RECONNECTING)' : 'OFFLINE';
        text.style.color = '#52525B';
    }
}

async function leaveChat() {
    if (!confirm("確定要終止並離開對話？這將會徹底抹除本地的所有對話紀錄。")) return;
    isGeneratingQR = false;
    isScanningQR = false;

    if (currentFriendPk && isNostrReady) {
        try {
            const leavePackage = { type: 'leave' };
            const encLeave = await Crypto.encryptData(myKeyPair.sk, currentFriendPk, JSON.stringify(leavePackage));
            await nostr.sendEvent(myKeyPair.sk, currentFriendPk, encLeave);
        } catch (e) {}
    }

    if (currentFriendPk) Storage.clearSession(currentFriendPk);
    clearSessionState();
    location.reload();
}

function setupPeerEvents() {
    if (!p2pPeer) return;

    p2pPeer.on('connect', function() {
        logger.debug("⚡ [WebRTC] P2P 直連管道建立成功。");
        updateOnlineStatus(true);
    });

    p2pPeer.on('data', function(data) {
        const text = data.toString();
        Storage.saveMessageLog(currentFriendPk, text, 'friend');
        appendMessage(text, 'friend');
    });

    p2pPeer.on('close', function() { 
        isReconnecting = false; 
        updateOnlineStatus(false); 
    });
    p2pPeer.on('error', function(err) { 
        isReconnecting = false; 
        updateOnlineStatus(false); 
    });
}

async function triggerNostrReconnect() {
    if (isGeneratingQR || isScanningQR || !isInChatMode || !currentFriendPk || !isNostrReady || isReconnecting) return;
    if (p2pPeer && p2pPeer.connected) { 
        updateOnlineStatus(true); 
        return; 
    }

    isReconnecting = true; 
    updateOnlineStatus(false);
    forceDestroyPeer();

    const amIInitiator = myKeyPair.pk > currentFriendPk;

    if (amIInitiator) {
        p2pPeer = new window.SimplePeer({ initiator: true, trickle: false, config: rtcConfig });
        setupPeerEvents(); 

        p2pPeer.on('signal', async function(newWebrtcData) {
            if (isGeneratingQR || isScanningQR || !currentFriendPk || !isInChatMode) return;
            const reconnectOffer = { type: 'reconnect-offer', sdp: newWebrtcData };
            const encryptedMessage = await Crypto.encryptData(myKeyPair.sk, currentFriendPk, JSON.stringify(reconnectOffer));
            await nostr.sendEvent(myKeyPair.sk, currentFriendPk, encryptedMessage);
        });
    } else {
        p2pPeer = new window.SimplePeer({ initiator: false, trickle: false, config: rtcConfig });
        setupPeerEvents();
        setTimeout(function() { 
            isReconnecting = false; 
        }, 8000);
    }
}

setInterval(function() {
    if (!isGeneratingQR && !isScanningQR && isInChatMode && currentFriendPk && isNostrReady && (!p2pPeer || !p2pPeer.connected) && !isReconnecting) {
        triggerNostrReconnect();
    }
}, 5000);
