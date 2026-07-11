import { Storage } from './storage.js';
import { Crypto } from './crypto.js';
import { NostrManager } from './nostr.js';

// 💡 健常化常數定義，消除 Magic String
const GLOBAL_CHANNEL = 'any';
const PRODUCTION_MODE = false; // ⚠️ 正式發布時設為 true 會自動關閉 Debug Panel

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

// 🎛️ Logger 封裝控制類別
window.logDebug = function(msg) {
    if (PRODUCTION_MODE) return;
    const consoleEl = document.getElementById('debug-console');
    if (consoleEl) {
        consoleEl.innerText += `\n[${new Date().toLocaleTimeString()}] ${msg}`;
        consoleEl.scrollTop = consoleEl.scrollHeight;
    }
};

// 💡 RTC 多重備援伺服器配置（整合 STUN）
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.services.mozilla.com' }
    ]
};

// 🔓 安全解鎖流調度
document.getElementById('btn-unlock').addEventListener('click', async () => {
    const pinInput = document.getElementById('input-pin').value;
    if (!pinInput || pinInput.length < 6) {
        alert("請輸入完整 6 位數密碼");
        return;
    }
    userPin = pinInput;
    
    const cached = Storage.getEncryptedKeyPair();
    try {
        if (cached.esk && cached.pk) {
            // 現有用戶：利用密碼進行 AES-GCM 解密
            const decryptedSk = await Crypto.decryptSecret(cached.esk, userPin);
            myKeyPair = { sk: decryptedSk, pk: cached.pk };
            window.logDebug("🔑 身分解鎖成功，金鑰安全釋放至記憶體。");
        } else {
            // 全新用戶：動態生成新私鑰並用 PIN 碼安全加密
            const sk = window.NostrTools.generatePrivateKey();
            const pk = window.NostrTools.getPublicKey(sk);
            const encryptedSkHex = await Crypto.encryptSecret(sk, userPin);
            Storage.saveEncryptedKeyPair(encryptedSkHex, pk);
            myKeyPair = { sk, pk };
            window.logDebug("✨ 全新身分建立完畢，私鑰已通過 AES-GCM 安全硬化儲存。");
        }
        
        document.getElementById('pin-container').style.display = 'none';
        document.getElementById('setup-container').style.display = 'block';
        bootstrapApp(); // 啟動主程式
    } catch(e) {
        alert("密碼錯誤或身分金鑰受損！");
    }
});

function bootstrapApp() {
    nostr.connect().then(() => {
        isNostrReady = true;
        const savedLastPk = Storage.getLastChatPk();
        if (savedLastPk && !isGeneratingQR && !isScanningQR) {
            currentFriendPk = savedLastPk;
            isInChatMode = true; 
            showChatInterface();
            restoreChatLogs();
            updateOnlineStatus(false);
            listenForMessages(currentFriendPk);
            
            setTimeout(() => {
                if (!isGeneratingQR && !isScanningQR && isInChatMode) triggerNostrReconnect();
            }, 1500);
        }
    });
}

document.getElementById('btn-create').addEventListener('click', startAsInitiator);
document.getElementById('btn-scan').addEventListener('click', startCameraScan);
document.getElementById('btn-send').addEventListener('click', sendMessage);
document.getElementById('btn-leave').addEventListener('click', leaveChat);

// 💡 依據建議優化：使用現代標準 keydown 事件取代過期的 keypress
document.getElementById('input-msg').addEventListener('keydown', (e) => {
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

    const initSub = () => {
        if (!isGeneratingQR || isInChatMode || (p2pPeer && p2pPeer.connected)) return;
        window.logDebug("📡 正在等待對方掃碼並發送 Offer...");
        
        nostr.subscribeToFriend(myKeyPair.pk, GLOBAL_CHANNEL, async (rawContent, authorPk) => {
            try {
                // 💡 安全防禦：過濾異常大信號，阻斷潛在 DDOS 或 OOM 攻擊
                if (rawContent.length > 50000) return;
                if (!isGeneratingQR || isInChatMode || (p2pPeer && p2pPeer.connected) || !authorPk) return;
                
                let data = null;
                try {
                    data = JSON.parse(rawContent);
                } catch (jsonErr) {
                    try {
                        const decryptedText = await Crypto.decryptData(myKeyPair.sk, authorPk, rawContent);
                        if (decryptedText) data = JSON.parse(decryptedText);
                    } catch (cryptoErr) { return; }
                }

                if (data && data.type === 'init-offer') {
                    isGeneratingQR = false; 
                    if (initTimer) clearInterval(initTimer);
                    nostr.unsubscribeFromFriend(GLOBAL_CHANNEL);

                    currentFriendPk = authorPk;
                    localStorage.setItem('last_chat_pk', currentFriendPk);
                    forceDestroyPeer();
                    
                    p2pPeer = new window.SimplePeer({ initiator: false, trickle: false, config: rtcConfig });
                    setupPeerEvents(); 
                    p2pPeer.signal(data.sdp);

                    p2pPeer.on('signal', async (webrtcAnswer) => {
                        const answerPackage = { type: 'init-answer', sdp: webrtcAnswer };
                        await nostr.sendEvent(myKeyPair.sk, currentFriendPk, JSON.stringify(answerPackage));
                    });

                    Storage.saveFriend(currentFriendPk);
                    isInChatMode = true;
                    showChatInterface();
                    restoreChatLogs();
                    listenForMessages(currentFriendPk);
                }
            } catch (e) {}
        });
    };

    initSub();
    initTimer = setInterval(() => {
        if (isGeneratingQR && !isInChatMode && (!p2pPeer || !p2pPeer.connected)) initSub();
        else clearInterval(initTimer);
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
        async (decodedFriendPk) => {
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
            
            p2pPeer.on('signal', async (webrtcOffer) => {
                const offerPackage = { type: 'init-offer', sdp: webrtcOffer };
                await nostr.sendEvent(myKeyPair.sk, currentFriendPk, JSON.stringify(offerPackage));
            });

            Storage.saveFriend(currentFriendPk);
            listenForMessages(currentFriendPk);
        },
        () => {}
    ).catch((err) => { window.logDebug(`❌ 相機啟動失敗: ${err.message}`); });
}

function listenForMessages(friendPk) {
    if (!friendPk) return;
    nostr.subscribeToFriend(myKeyPair.pk, friendPk, async (rawContent, authorPk) => {
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
                } catch (cryptoErr) { return; }
            }
            
            if (!data) return;
            if (data.type === 'leave') {
                updateOnlineStatus(false);
                forceDestroyPeer();
                return;
            }

            if (!isInChatMode) return;

            if (data.type === 'init-answer') {
                if (p2pPeer && !p2pPeer.destroyed) p2pPeer.signal(data.sdp);
            } 
            else if (data.type === 'reconnect-offer') {
                forceDestroyPeer();
                p2pPeer = new window.SimplePeer({ initiator: false, trickle: false, config: rtcConfig });
                setupPeerEvents();
                p2pPeer.signal(data.sdp);

                p2pPeer.on('signal', async (myNewAnswer) => {
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
    logs.forEach(log => appendMessage(log.text, log.sender));
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

    p2pPeer.on('connect', () => {
        window.logDebug("⚡ [WebRTC] 雙向 P2P 直連管道打通！成功越過伺服器。");
        updateOnlineStatus(true);
    });

    p2pPeer.on('data', (data) => {
        const text = data.toString();
        Storage.saveMessageLog(currentFriendPk, text, 'friend');
        appendMessage(text, 'friend');
    });

    p2pPeer.on('close', () => { isReconnecting = false; updateOnlineStatus(false); });
    p2pPeer.on('error', (err) => { isReconnecting = false; updateOnlineStatus(false); });
}

async function triggerNostrReconnect() {
    if (isGeneratingQR || isScanningQR || !isInChatMode || !currentFriendPk || !isNostrReady || isReconnecting) return;
    if (p2pPeer && p2pPeer.connected) { updateOnlineStatus(true); return; }

    isReconnecting = true; 
    updateOnlineStatus(false);
    forceDestroyPeer();

    // Tie-Breaking 鎖定：大公鑰端為主動發起方
    const amIInitiator = myKeyPair.pk > currentFriendPk;

    if (amIInitiator) {
        p2pPeer = new window.SimplePeer({ initiator: true, trickle: false, config: rtcConfig });
        setupPeerEvents(); 

        p2pPeer.on('signal', async (newWebrtcData) => {
            if (isGeneratingQR || isScanningQR || !currentFriendPk || !isInChatMode) return;
            const reconnectOffer = { type: 'reconnect-offer', sdp: newWebrtcData };
            const encryptedMessage = await Crypto.encryptData(myKeyPair.sk, currentFriendPk, JSON.stringify(reconnectOffer));
            await nostr.sendEvent(myKeyPair.sk, currentFriendPk, encryptedMessage);
        });
    } else {
        p2pPeer = new window.SimplePeer({ initiator: false, trickle: false, config: rtcConfig });
        setupPeerEvents();
        setTimeout(() => { isReconnecting = false; }, 8000);
    }
}

setInterval(() => {
    if (!isGeneratingQR && !isScanningQR && isInChatMode && currentFriendPk && isNostrReady && (!p2pPeer || !p2pPeer.connected) && !isReconnecting) {
        triggerNostrReconnect();
    }
}, 5000);
