import { Storage } from './storage.js';
import { Crypto } from './crypto.js';
import { NostrManager } from './nostr.js';

let myKeyPair = Storage.getMyKeys();
let p2pPeer = null;
let currentFriendPk = Storage.getLastChatPk(); 
let nostr = new NostrManager('wss://nos.lol');

// 防止多個異步事件同時發動重連，導致訊號在背景打架
let isNostrReady = false;
let isReconnecting = false;

if (!myKeyPair.sk || !myKeyPair.pk) {
    const sk = window.NostrTools.generatePrivateKey();
    const pk = window.NostrTools.getPublicKey(sk);
    Storage.saveKeyPair(sk, pk);
    myKeyPair = { sk, pk };
}

// 強制依序執行，先接通網路，再啟動重連
nostr.connect().then(() => {
    console.log("🌐 Nostr 網路骨幹已成功通電");
    isNostrReady = true; // 標記網路已就緒

    const friends = Storage.getFriends();
    Object.keys(friends).forEach(friendPk => {
        listenForMessages(friendPk);
    });

    if (currentFriendPk) {
        showChatInterface();
        restoreChatLogs();
        updateOnlineStatus(false);
        
        // 給手機版瀏覽器 2 秒的極致緩衝時間，確保訂閱聽筒完全打開
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

    nostr.subscribeToFriend(myKeyPair.pk, 'any', async (encryptedContent, authorPk) => {
        try {
            const decryptedText = await Crypto.decryptData(myKeyPair.sk, authorPk, encryptedContent);
            if (!decryptedText) return;

            let data;
            try { data = JSON.parse(decryptedText); } catch(jsonErr) { return; }

            if (data && data.type === 'init-offer') {
                currentFriendPk = authorPk;
                強制銷毀舊連線實體();
                
                p2pPeer = new window.SimplePeer({ initiator: false, trickle: false, config: undefined });
                p2pPeer.signal(data.sdp);

                p2pPeer.on('signal', async (webrtcAnswer) => {
                    const answerPackage = { type: 'init-answer', sdp: webrtcAnswer };
                    const encAnswer = await Crypto.encryptData(myKeyPair.sk, currentFriendPk, JSON.stringify(answerPackage));
                    await nostr.sendEvent(myKeyPair.sk, currentFriendPk, encAnswer);
                });

                const sharedSecret = await Crypto.getSharedSecret(myKeyPair.sk, currentFriendPk);
                Storage.saveFriend(currentFriendPk, sharedSecret);
                setupPeerEvents();
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
            showChatInterface();
            appendMessage("已成功掃描信任密鑰，正在背景交換加密信道協議...", "system");

            p2pPeer = new window.SimplePeer({ initiator: true, trickle: false, config: undefined });
            
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
    nostr.subscribeToFriend(myKeyPair.pk, friendPk, async (encryptedContent) => {
        try {
            const decryptedText = await Crypto.decryptData(myKeyPair.sk, friendPk, encryptedContent);
            if (!decryptedText) return;
            
            let data;
            try { data = JSON.parse(decryptedText); } catch(jsonErr) { return; }

            // 處理初次綁定
            if (data.type === 'init-answer') {
                if (p2pPeer && !p2pPeer.destroyed) p2pPeer.signal(data.sdp);
            } 
            // 處理被動接收重連
            else if (data.type === 'reconnect-offer') {
                console.log("📥 收到對方的重連請求 offer...");
                強制銷毀舊連線實體();
                
                p2pPeer = new window.SimplePeer({ initiator: false, trickle: false, config: undefined });
                p2pPeer.on('signal', async (myNewAnswer) => {
                    const reconnectAnswer = { type: 'reconnect-answer', sdp: myNewAnswer };
                    const encAnswer = await Crypto.encryptData(myKeyPair.sk, friendPk, JSON.stringify(reconnectAnswer));
                    await nostr.sendEvent(myKeyPair.sk, friendPk, encAnswer);
                });
                setupPeerEvents();
                p2pPeer.signal(data.sdp);
            } else if (data.type === 'reconnect-answer') {
                console.log("📥 收到對方的重連回應 answer，連線即將打通！");
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
        isReconnecting = false; // 成功打通直連，解除重連鎖
    } else {
        dot.style.background = '#52525B';
        dot.style.boxShadow = 'none';
        text.innerText = 'OFFLINE (RECONNECTING)';
        text.style.color = '#52525B';
    }
}

function leaveChat() {
    if (!confirm("確定要終止並離開對話？這將會徹底抹除本地的所有對話紀錄。")) return;
    強制銷毀舊連線實體();
    if (currentFriendPk) Storage.clearSession(currentFriendPk);
    location.href = location.pathname;
}

// 雙重鎖定重連機制
async function triggerNostrReconnect() {
    // 如果 Nostr 網路根本還沒通，或者現在正處於連線鎖定狀態，直接攔截退出
    if (!currentFriendPk || !isNostrReady || isReconnecting) return;
    
    // 如果當前連線其實已經是通的，就校正狀態，不需要重連
    if (p2pPeer && p2pPeer.connected) {
        updateOnlineStatus(true);
        return;
    }

    isReconnecting = true; // 防止並發重複進入
    updateOnlineStatus(false);
    強制銷毀舊連線實體();

    // 重新確保狀態鎖定
    isReconnecting = true; 

    p2pPeer = new window.SimplePeer({ initiator: true, trickle: false, config: undefined });
    
    p2pPeer.on('signal', async (newWebrtcData) => {
        // 確保在發射訊號時，還在這個交友對話中
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

// 每 4 秒動態掃描一次
setInterval(() => {
    if (currentFriendPk && isNostrReady && (!p2pPeer || !p2pPeer.connected) && !isReconnecting) {
        console.log("🔍 心跳排查：信道處於離線，發動安全協商...");
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
