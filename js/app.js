import { Storage } from './storage.js';
import { Crypto } from './crypto.js';
import { NostrManager } from './nostr.js';

let myKeyPair = Storage.getMyKeys();
let p2pPeer = null;
let currentFriendPk = localStorage.getItem('last_chat_pk'); 
let nostr = new NostrManager(); 

// 🔐 移動端專用核心鎖
let isNostrReady = false;
let isReconnecting = false;
let isInChatMode = false; 

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

// 網頁啟動生命週期
nostr.connect().then(() => {
    console.log("🌐 Nostr 網路骨幹已成功通電");
    isNostrReady = true;

    const friends = Storage.getFriends();
    Object.keys(friends).forEach(friendPk => {
        listenForMessages(friendPk);
    });

    // 只有當本地有歷史紀錄，且不是正要重新配對時，才自動回復聊天
    if (currentFriendPk) {
        isInChatMode = true; 
        showChatInterface();
        restoreChatLogs();
        updateOnlineStatus(false);
        
        setTimeout(() => {
            triggerNostrReconnect();
        }, 2000);
    }
});

// 監聽按鈕點擊
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
    // 🌟 【超核心修正】：既然點了產生全新 QR Code，立刻強制清空上一次的快取紀錄與記憶狀態！
    localStorage.removeItem('last_chat_pk');
    currentFriendPk = null;
    isInChatMode = false; 
    
    強制銷毀舊連線實體();
    
    document.getElementById('setup-container').style.display = 'none';
    const container = document.getElementById('qrcode-container');
    container.style.display = 'block';
    
    const qr = window.qrcode(0, 'M');
    qr.addData(myKeyPair.pk);
    qr.make();
    container.innerHTML = '<h3>請對方掃描 QR Code</h3>' + qr.createImgTag(6);

    // 開啟全域聽筒，等待初次對接
    nostr.subscribeToFriend(myKeyPair.pk, 'any', async (encryptedContent, authorPk) => {
        try {
            if (isInChatMode || (p2pPeer && p2pPeer.connected)) return;

            if (!authorPk) return;
            const decryptedText = await Crypto.decryptData(myKeyPair.sk, authorPk, encryptedContent);
            if (!decryptedText) return;

            let data;
            try { data = JSON.parse(decryptedText); } catch(jsonErr) { return; }

            if (data && data.type === 'init-offer') {
                currentFriendPk = authorPk;
                localStorage.setItem('last_chat_pk', currentFriendPk);
                
                強制銷毀舊連線實體();
                
                p2pPeer = new window.SimplePeer({ initiator: false, trickle: false, config: rtcConfig });
                setupPeerEvents(); 
                p2pPeer.signal(data.sdp);

                p2pPeer.on('signal', async (webrtcAnswer) => {
                    const answerPackage = { type: 'init-answer', sdp: webrtcAnswer };
                    const encAnswer = await Crypto.encryptData(myKeyPair.sk, currentFriendPk, JSON.stringify(answerPackage));
                    await nostr.sendEvent(myKeyPair.sk, currentFriendPk, encAnswer);
                });

                const sharedSecret = await Crypto.getSharedSecret(myKeyPair.sk, currentFriendPk);
                Storage.saveFriend(currentFriendPk, sharedSecret);
                
                isInChatMode = true;
                showChatInterface();
                restoreChatLogs();
            }
        } catch (e) { console.error("背景連線初始化異常:", e); }
    });
}

function startCameraScan() {
    // 🌟 【超核心修正】：既然要掃描別人，也立刻洗掉舊有的配對，防範跳轉打架
    localStorage.removeItem('last_chat_pk');
    currentFriendPk = null;
    isInChatMode = false;

    document.getElementById('setup-container').style.display = 'none';
    document.getElementById('reader').style.display = 'block';

    const html5QrcodeScanner = new window.Html5Qrcode("reader");
    html5QrcodeScanner.start(
        { facingMode: "environment" },
        { fps: 20, qrbox: 250 }, 
        async (decodedFriendPk) => {
            try { await html5QrcodeScanner.stop(); } catch (err) {}
            document.getElementById('reader').style.display = 'none';
            
            強制銷毀舊連線實體();
            
            currentFriendPk = decodedFriendPk;
            localStorage.setItem('last_chat_pk', currentFriendPk);
            
            isInChatMode = true; 
            showChatInterface();
            appendMessage("已成功掃描信任密鑰，正在背景交換加密信道協議...", "system");

            p2pPeer = new window.SimplePeer({ initiator: true, trickle: false, config: rtcConfig });
            setupPeerEvents();
            
            p2pPeer.on('signal', async (webrtcOffer) => {
                const offerPackage = { type: 'init-offer', sdp: webrtcOffer };
                const encOffer = await Crypto.encryptData(myKeyPair.sk, currentFriendPk, JSON.stringify(offerPackage));
                await nostr.sendEvent(myKeyPair.sk, currentFriendPk, encOffer);
            });

            const sharedSecret = await Crypto.getSharedSecret(myKeyPair.sk, currentFriendPk);
            Storage.saveFriend(currentFriendPk, sharedSecret);

            listenForMessages(currentFriendPk);
        },
        () => {}
    ).catch(() => location.reload());
}

function listenForMessages(friendPk) {
    if (!friendPk) return;
    nostr.subscribeToFriend(myKeyPair.pk, friendPk, async (encryptedContent, authorPk) => {
        try {
            const senderPk = authorPk || friendPk;
            const decryptedText = await Crypto.decryptData(myKeyPair.sk, senderPk, encryptedContent);
            if (!decryptedText) return;
            
            let data;
            try { data = JSON.parse(decryptedText); } catch(jsonErr) { return; }

            if (data.type === 'leave') {
                appendMessage("❌ 對方已中斷連線並離開了聊天室。", "system");
                updateOnlineStatus(false);
                強制銷毀舊連線實體();
                return;
            }

            if (!isInChatMode) return;

            if (data.type === 'init-answer') {
                if (p2pPeer && !p2pPeer.destroyed) p2pPeer.signal(data.sdp);
            } 
            else if (data.type === 'reconnect-offer') {
                console.log("📥 收到重連請求 offer...");
                強制銷毀舊連線實體();
                
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
    
    const chatUI = document.getElementById('chat-interface');
    chatUI.style.display = 'flex';
    chatUI.style.pointerEvents = 'auto'; 
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
        text.innerText = 'OFFLINE (RECONNECTING)';
        text.style.color = '#52525B';
    }
}

async function leaveChat() {
    if (!confirm("確定要終止並離開對話？這將會徹底抹除本地的所有對話紀錄。")) return;
    
    isInChatMode = false; 

    if (currentFriendPk && isNostrReady) {
        try {
            const leavePackage = { type: 'leave' };
            const encLeave = await Crypto.encryptData(myKeyPair.sk, currentFriendPk, JSON.stringify(leavePackage));
            await nostr.sendEvent(myKeyPair.sk, currentFriendPk, encLeave);
        } catch (e) {}
    }

    強制銷毀舊連線實體();
    if (currentFriendPk) Storage.clearSession(currentFriendPk);
    localStorage.removeItem('last_chat_pk'); 
    location.href = location.pathname;
}

function setupPeerEvents() {
    if (!p2pPeer) return;

    p2pPeer.on('connect', () => {
        console.log("⚡ WebRTC P2P 直連成功！");
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
    強制銷毀舊連線實體();

    isReconnecting = true; 
    console.log("🔄 正在發射主動重連協議...");

    p2pPeer = new window.SimplePeer({ initiator: true, trickle: false, config: rtcConfig });
    setupPeerEvents(); 

    p2pPeer.on('signal', async (newWebrtcData) => {
        if (!currentFriendPk || !isInChatMode) return;
        
        const reconnectOffer = { type: 'reconnect-offer', sdp: newWebrtcData };
        const encryptedMessage = await Crypto.encryptData(myKeyPair.sk, currentFriendPk, JSON.stringify(reconnectOffer));
        await nostr.sendEvent(myKeyPair.sk, currentFriendPk, encryptedMessage);
    });
}

setInterval(() => {
    if (isInChatMode && currentFriendPk && isNostrReady && (!p2pPeer || !p2pPeer.connected) && !isReconnecting) {
        console.log("🔍 心跳排查：直連中斷，雙向主動提議發動中...");
        triggerNostrReconnect();
    }
}, 5000);
