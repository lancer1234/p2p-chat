import { Storage } from './storage.js';
import { Crypto } from './crypto.js';
import { NostrManager } from './nostr.js';

let myKeyPair = Storage.getMyKeys();
let p2pPeer = null;
let currentFriendPk = null; 
let nostr = new NostrManager(); 

let isNostrReady = false;
let isReconnecting = false;
let isInChatMode = false; 
let initTimer = null;

// 可視化面板日誌輸出
window.logDebug = function(msg) {
    const consoleEl = document.getElementById('debug-console');
    if (consoleEl) {
        consoleEl.innerText += `\n[${new Date().toLocaleTimeString()}] ${msg}`;
        consoleEl.scrollTop = consoleEl.scrollHeight;
    }
};

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.services.mozilla.com' }
    ]
};

if (!myKeyPair.sk || !myKeyPair.pk) {
    const sk = window.NostrTools.generatePrivateKey();
    const pk = window.NostrTools.getPublicKey(sk);
    Storage.saveKeyPair(sk, pk);
    myKeyPair = { sk, pk };
}

window.logDebug(`我的公鑰: ${myKeyPair.pk.substring(0,8)}...`);

nostr.connect().then(() => {
    isNostrReady = true;
    
    const savedLastPk = Storage.getLastChatPk();
    if (savedLastPk) {
        window.logDebug("發現舊對話快取，正在嘗試背景無縫對接...");
        currentFriendPk = savedLastPk;
        isInChatMode = true; 
        showChatInterface();
        restoreChatLogs();
        updateOnlineStatus(false);
        listenForMessages(currentFriendPk);
        
        setTimeout(() => {
            triggerNostrReconnect();
        }, 1500);
    }
});

document.getElementById('btn-create').addEventListener('click', startAsInitiator);
document.getElementById('btn-scan').addEventListener('click', startCameraScan);
document.getElementById('btn-send').addEventListener('click', sendMessage);
document.getElementById('btn-leave').addEventListener('click', leaveChat);
document.getElementById('input-msg').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

// 修改點：改成英文名稱，防止瀏覽器語法解析崩潰
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
    isInChatMode = false;
    isReconnecting = false;
    currentFriendPk = null;
    localStorage.removeItem('last_chat_pk');
    if (initTimer) clearInterval(initTimer);
    forceDestroyPeer();
    nostr.clearAllSubscriptions();
    
    document.getElementById('chat-interface').style.display = 'none';
    document.getElementById('qrcode-container').style.display = 'none';
    document.getElementById('reader').style.display = 'none';
    document.getElementById('setup-container').style.display = 'block';
}

function startAsInitiator() {
    clearSessionState();
    window.logDebug("已重置環境，正在產生新通道...");
    
    document.getElementById('setup-container').style.display = 'none';
    const container = document.getElementById('qrcode-container');
    container.style.display = 'block';
    
    const qr = window.qrcode(0, 'M');
    qr.addData(myKeyPair.pk);
    qr.make();
    container.innerHTML = '<h3>請對方掃描 QR Code</h3>' + qr.createImgTag(6);

    const initSub = () => {
        if (isInChatMode || (p2pPeer && p2pPeer.connected)) return;
        window.logDebug("📡 正在等待對方掃碼並發送 Offer...");
        
        nostr.subscribeToFriend(myKeyPair.pk, 'any', async (rawContent, authorPk) => {
            try {
                if (isInChatMode || (p2pPeer && p2pPeer.connected)) return;
                if (!authorPk) return;
                
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

                if (data && data.type === 'init-offer') {
                    window.logDebug("📥 成功收到對方的連線邀請信號！");
                    if (initTimer) clearInterval(initTimer);
                    currentFriendPk = authorPk;
                    localStorage.setItem('last_chat_pk', currentFriendPk);
                    
                    forceDestroyPeer();
                    
                    p2pPeer = new window.SimplePeer({ initiator: false, trickle: false, config: rtcConfig });
                    setupPeerEvents(); 
                    p2pPeer.signal(data.sdp);

                    p2pPeer.on('signal', async (webrtcAnswer) => {
                        window.logDebug("📤 正在回傳應答信號 (Answer)...");
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
        if (!isInChatMode && (!p2pPeer || !p2pPeer.connected)) {
            initSub();
        } else {
            clearInterval(initTimer);
        }
    }, 5000);
}

function startCameraScan() {
    clearSessionState();

    document.getElementById('setup-container').style.display = 'none';
    document.getElementById('reader').style.display = 'block';

    window.logDebug("📷 相機啟動中...");
    const html5QrcodeScanner = new window.Html5Qrcode("reader");
    html5QrcodeScanner.start(
        { facingMode: "environment" },
        { fps: 20, qrbox: 250 }, 
        async (decodedFriendPk) => {
            try { await html5QrcodeScanner.stop(); } catch (err) {}
            document.getElementById('reader').style.display = 'none';
            
            window.logDebug("✅ 掃碼成功！正在初始化 WebRTC 實體...");
            currentFriendPk = decodedFriendPk;
            localStorage.setItem('last_chat_pk', currentFriendPk);
            
            isInChatMode = true; 
            showChatInterface();
            appendMessage("已成功掃描信任密鑰，正在發射 Offer 信號...", "system");

            p2pPeer = new window.SimplePeer({ initiator: true, trickle: false, config: rtcConfig });
            setupPeerEvents();
            
            p2pPeer.on('signal', async (webrtcOffer) => {
                window.logDebug("📤 正在向 Nostr 推播連線提議...");
                const offerPackage = { type: 'init-offer', sdp: webrtcOffer };
                await nostr.sendEvent(myKeyPair.sk, currentFriendPk, JSON.stringify(offerPackage));
            });

            Storage.saveFriend(currentFriendPk);
            listenForMessages(currentFriendPk);
        },
        () => {}
    ).catch((err) => {
        window.logDebug(`❌ 相機啟動失敗 (請確認是否為 HTTPS 或 localhost): ${err.message}`);
    });
}

function listenForMessages(friendPk) {
    if (!friendPk) return;
    nostr.subscribeToFriend(myKeyPair.pk, friendPk, async (rawContent, authorPk) => {
        try {
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
            
            if (!data) return;

            if (data.type === 'leave') {
                appendMessage("❌ 對方已中斷連線並離開了聊天室。", "system");
                updateOnlineStatus(false);
                forceDestroyPeer();
                return;
            }

            if (!isInChatMode) return;

            if (data.type === 'init-answer') {
                window.logDebug("📥 收到對方的 Answer 響應，正在打通對接直連...");
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

    p2pPeer.on('close', () => { 
        isReconnecting = false; 
        updateOnlineStatus(false); 
    });

    p2pPeer.on('error', (err) => { 
        window.logDebug(`⚠️ WebRTC 底層連線重置: ${err.message}`);
        isReconnecting = false; 
        updateOnlineStatus(false); 
    });
}

async function triggerNostrReconnect() {
    if (!isInChatMode || !currentFriendPk || !isNostrReady || isReconnecting) return;
    
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

        p2pPeer.on('signal', async (newWebrtcData) => {
            if (!currentFriendPk || !isInChatMode) return;
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
    if (isInChatMode && currentFriendPk && isNostrReady && (!p2pPeer || !p2pPeer.connected) && !isReconnecting) {
        triggerNostrReconnect();
    }
}, 5000);
