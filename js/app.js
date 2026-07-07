import { Storage } from './storage.js';
import { Crypto } from './crypto.js';
import { NostrManager } from './nostr.js';

let myKeyPair = Storage.getMyKeys();
let p2pPeer = null;
let currentFriendPk = Storage.getLastChatPk(); 
let nostr = new NostrManager('wss://nos.lol');

// 移動端與私密轉送專用狀態鎖
let isNostrReady = false;
let isReconnecting = false;

// 公共 STUN 伺服器
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' }
    ]
};

if (!myKeyPair.sk || !myKeyPair.pk) {
    const sk = window.NostrTools.generatePrivateKey();
    const pk = window.NostrTools.getPublicKey(sk);
    Storage.saveKeyPair(sk, pk);
    myKeyPair = { sk, pk };
}

// 網頁啟動：優先初始化 Nostr，再啟動流程
nostr.connect().then(() => {
    console.log("🌐 Nostr 網路骨幹已成功通電");
    isNostrReady = true;

    // 監聽所有已知好友（包含重連與離開提示）
    const friends = Storage.getFriends();
    Object.keys(friends).forEach(friendPk => {
        listenForMessages(friendPk);
    });

    if (currentFriendPk) {
        showChatInterface();
        restoreChatLogs();
        updateOnlineStatus(false);
        
        // 給手機版瀏覽器緩衝，等待 Nostr 監聽完全就位
        setTimeout(() => {
            triggerNostrReconnect();
        }, 2000);
    }
});

document.getElementById('btn-create').addEventListener('click', startAsInitiator);
document.getElementById('btn-scan').addEventListener('click', startCameraScan);
document.getElementById('btn-send').addEventListener('click', sendMessage);
document.getElementById('btn-leave').addEventListener('click', leaveChat);
document.getElementById('input-msg').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

function 強制銷毀舊連線實體() {
    if (p2pPeer) {
        try {
            p2pPeer.removeAllListeners();
            p2pPeer.destroy();
        } catch(e) {}
        p2pPeer = null;
    }
}

function startAsInitiator() {
    強制銷毀舊連線實體();
    document.getElementById('setup-container').style.display = 'none';
    const container = document.getElementById('qrcode-container');
    container.style.display = 'block';
    
    const qr = window.qrcode(0, 'M');
    qr.addData(myKeyPair.pk);
    qr.make();
    container.innerHTML = '<h3>請對方掃描 QR Code</h3>' + qr.createImgTag(6);

    // 創建人也立刻將 currentFriendPk 設為 any 監聽狀態，並允許心跳介入
    nostr.subscribeToFriend(myKeyPair.pk, 'any', async (encryptedContent, authorPk) => {
        try {
            const decryptedText = await Crypto.decryptData(myKeyPair.sk, authorPk, encryptedContent);
            if (!decryptedText) return;

            let data;
            try { data = JSON.parse(decryptedText); } catch(jsonErr) { return; }

            if (data && data.type === 'init-offer') {
                // 鎖定當前對話朋友
                currentFriendPk = authorPk;
                Storage.saveLastChatPk(currentFriendPk);
                
                強制銷毀舊連線實體();
                
                p2pPeer = new window.SimplePeer({ initiator: false, trickle: false, config: rtcConfig });
                p2pPeer.signal(data.sdp);

                p2pPeer.on('signal', async (webrtcAnswer) => {
                    const answerPackage = { type: 'init-answer', sdp: webrtcAnswer };
                    const encAnswer = await Crypto.encryptData(myKeyPair.sk, currentFriendPk, JSON.stringify(answerPackage));
                    await nostr.sendEvent(myKeyPair.sk, currentFriendPk, encAnswer);
                });

                const sharedSecret = await Crypto.getSharedSecret(myKeyPair.sk, currentFriendPk);
                Storage.saveFriend(currentFriendPk, sharedSecret);
                setupPeerEvents();
                listenForMessages(currentFriendPk);
            }
        } catch (e) { console.error("背景連線初始化異常:", e); }
    });
}

function startCameraScan() {
    document.getElementById('setup-container').style.display = 'none';
    document.getElementById('reader').style.display = 'block';

    const html5QrcodeScanner = new window.Html5Qrcode("reader");
    html5QrcodeScanner.start(
        { facingMode: "environment" },
        { fps: 20, qrbox: 250 }, 
        async (decodedFriendPk) => {
            await html5QrcodeScanner.stop();
            document.getElementById('reader').style.display = 'none';
            
            強制銷毀舊連線實體();
            currentFriendPk = decodedFriendPk;
            Storage.saveLastChatPk(currentFriendPk);
            
            showChatInterface();
            appendMessage("已成功掃描信任密鑰，正在背景交換加密信道協議...", "system");

            p2pPeer = new window.SimplePeer({ initiator: true, trickle: false, config: rtcConfig });
            
            p2pPeer.on('signal', async (webrtcOffer) => {
                const offerPackage = { type: 'init-offer', sdp: webrtcOffer };
                const encOffer = await Crypto.encryptData(myKeyPair.sk, currentFriendPk, JSON.stringify(offerPackage));
                await nostr.sendEvent(myKeyPair.sk, currentFriendPk, encOffer);
            });

            const sharedSecret = await Crypto.getSharedSecret(myKeyPair.sk, currentFriendPk);
            Storage.saveFriend(currentFriendPk, sharedSecret);
            setupPeerEvents();

            listenForMessages(currentFriendPk);
        },
        () => {}
    ).catch(() => location.reload());
}

function listenForMessages(friendPk) {
    nostr.subscribeToFriend(myKeyPair.pk, friendPk, async (encryptedContent, authorPk) => {
        try {
            // 安全檢查：確保只處理來自目前交友或合法對端的信號
            const senderPk = authorPk || friendPk;
            const decryptedText = await Crypto.decryptData(myKeyPair.sk, senderPk, encryptedContent);
            if (!decryptedText) return;
            
            let data;
            try { data = JSON.parse(decryptedText); } catch(jsonErr) { return; }

            if (data.type === 'leave') {
                appendMessage("對方已中斷連線並離開了聊天室。", "system");
                updateOnlineStatus(false);
                強制銷毀舊連線實體();
                return;
            }

            if (data.type === 'init-answer') {
                if (p2pPeer && !p2pPeer.destroyed) p2pPeer.signal(data.sdp);
            } 
            else if (data.type === 'reconnect-offer') {
                console.log("收到重連請求 offer...");
                強制銷毀舊連線實體();
                
                p2pPeer = new window.SimplePeer({ initiator: false, trickle: false, config: rtcConfig });
                p2pPeer.on('signal', async (myNewAnswer) => {
                    const reconnectAnswer = { type: 'reconnect-answer', sdp: myNewAnswer };
                    const encAnswer = await Crypto.encryptData(myKeyPair.sk, senderPk, JSON.stringify(reconnectAnswer));
                    await nostr.sendEvent(myKeyPair.sk, senderPk, encAnswer);
                });
                setupPeerEvents();
                p2pPeer.signal(data.sdp);
            } else if (data.type === 'reconnect-answer') {
                console.log("收到重連回應 answer！");
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
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('msg', sender);
    msgDiv.innerText = text;
    box.appendChild(msgDiv);
    box.scrollTop = box.scrollHeight;
}

function restoreChatLogs() {
    const box = document.getElementById('chat-messages');
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
    
    const chatUI = document.getElementById('chat-interface');
    chatUI.style.display = 'flex';
    chatUI.style.pointerEvents = 'auto'; 
}

function updateOnlineStatus(isOnline) {
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    if (isOnline) {
        dot.style.background = '#00FFCC';
        dot.style.boxShadow = '0 0 8px #00FFCC';
        text.innerText = 'ONLINE';
        text.style.color = '#00FFCC';
        isReconnecting = false; 
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
            // 廣播離開訊號給對方
            const leavePackage = { type: 'leave' };
            const encLeave = await Crypto.encryptData(myKeyPair.sk, currentFriendPk, JSON.stringify(leavePackage));
            await nostr.sendEvent(myKeyPair.sk, currentFriendPk, encLeave);
        } catch (e) {
            console.log("發送離開通知失敗");
        }
    }

    強制銷毀舊連線實體();
    if (currentFriendPk) Storage.clearSession(currentFriendPk);
    location.href = location.pathname;
}

// 主動重連發射行程
async function triggerNostrReconnect() {
    if (!currentFriendPk || !isNostrReady || isReconnecting) return;
    
    if (p2pPeer && p2pPeer.connected) {
        updateOnlineStatus(true);
        return;
    }

    isReconnecting = true; 
    updateOnlineStatus(false);
    強制銷毀舊連線實體();

    isReconnecting = true; 

    p2pPeer = new window.SimplePeer({ initiator: true, trickle: false, config: rtcConfig });
    
    p2pPeer.on('signal', async (newWebrtcData) => {
        if (!currentFriendPk) return;
        
        const reconnectOffer = { type: 'reconnect-offer', sdp: newWebrtcData };
        const encryptedMessage = await Crypto.encryptData(myKeyPair.sk, currentFriendPk, JSON.stringify(reconnectOffer));
        await nostr.sendEvent(myKeyPair.sk, currentFriendPk, encryptedMessage);
    });
    
    p2pPeer.on('connect', () => updateOnlineStatus(true));
    p2pPeer.on('data', (data) => {
        const text = data.toString();
        Storage.saveMessageLog(currentFriendPk, text, 'friend');
        appendMessage(text, 'friend');
    });

    p2pPeer.on('close', () => { isReconnecting = false; updateOnlineStatus(false); });
    p2pPeer.on('error', () => { isReconnecting = false; updateOnlineStatus(false); });
}

setInterval(() => {
    if (currentFriendPk && isNostrReady && (!p2pPeer || !p2pPeer.connected) && !isReconnecting) {
        console.log("心跳排查：直連中斷，雙向主動握手發動中...");
        triggerNostrReconnect();
    }
}, 4000);

function setupPeerEvents() {
    p2pPeer.on('connect', () => updateOnlineStatus(true));
    p2pPeer.on('data', (data) => {
        const text = data.toString();
        Storage.saveMessageLog(currentFriendPk, text, 'friend');
        appendMessage(text, 'friend');
    });
    p2pPeer.on('close', () => { isReconnecting = false; updateOnlineStatus(false); });
    p2pPeer.on('error', () => { isReconnecting = false; updateOnlineStatus(false); });
}
