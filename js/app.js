import { Storage } from './storage.js';
import { Crypto } from './crypto.js';
import { NostrManager } from './nostr.js';

let myKeyPair = Storage.getMyKeys();
let p2pPeer = null;
let currentFriendPk = Storage.getLastChatPk(); 
let nostr = new NostrManager('wss://nos.lol');

// 用來完全切斷異步打架的狀態鎖
let isPeerConnecting = false;

if (!myKeyPair.sk || !myKeyPair.pk) {
    const sk = window.NostrTools.generatePrivateKey();
    const pk = window.NostrTools.getPublicKey(sk);
    Storage.saveKeyPair(sk, pk);
    myKeyPair = { sk, pk };
}

nostr.connect().then(() => {
    const friends = Storage.getFriends();
    Object.keys(friends).forEach(friendPk => {
        listenForMessages(friendPk);
    });

    if (currentFriendPk) {
        showChatInterface();
        restoreChatLogs();
        updateOnlineStatus(false);
        
        // 重新整理時，延遲發動背景重連
        setTimeout(() => {
            console.log("⚡ 啟動安全背景重連機制...");
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

// 核心修正：將 Peer 的銷毀完全物理隔離，不帶任何髒包
function 強制銷毀舊連線實體() {
    if (p2pPeer) {
        try {
            // 拔掉所有外掛事件
            p2pPeer.removeAllListeners();
            // 如果它本來就已經連上了，主動通知關閉
            if (p2pPeer.connected) {
                p2pPeer.destroy();
            }
        } catch(e) {
            console.log("忽略 Peer 記憶體釋放異常");
        }
        p2pPeer = null;
    }
    isPeerConnecting = false;
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
                console.log("📥 收到對方的重連請求 offer，建立全新響應端...");
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
                console.log("📥 收到對方的重連回應 answer，正式打通！");
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
        appendMessage("⚠️ 目前處於離線狀態，正在等待對方上線通道建立...", "system");
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
        isPeerConnecting = false; // 連線成功，解開狀態鎖
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

// 核心重構：改用非阻塞、無遞迴的安全重連發射器
async function triggerNostrReconnect() {
    if (!currentFriendPk || isPeerConnecting) return;
    
    // 如果現在已經成功直連了，不需要重連
    if (p2pPeer && p2pPeer.connected) {
        updateOnlineStatus(true);
        return;
    }

    isPeerConnecting = true;
    updateOnlineStatus(false);
    強制銷毀舊連線實體();

    // 重新標記為發起中狀態
    isPeerConnecting = true; 

    p2pPeer = new window.SimplePeer({ initiator: true, trickle: false, config: undefined });
    p2pPeer.on('signal', async (newWebrtcData) => {
        const reconnectOffer = { type: 'reconnect-offer', sdp: newWebrtcData };
        const encryptedMessage = await Crypto.encryptData(myKeyPair.sk, currentFriendPk, JSON.stringify(reconnectOffer));
        await nostr.sendEvent(myKeyPair.sk, currentFriendPk, encryptedMessage);
    });
    
    // 注意：這裡完全移除了 p2pPeer.on('close') 和 on('error') 的自動重連監聽！
    // 徹底將事件和重連拆分，避免死循環
    p2pPeer.on('connect', () => updateOnlineStatus(true));
    p2pPeer.on('data', (data) => {
        const text = data.toString();
        Storage.saveMessageLog(currentFriendPk, text, 'friend');
        appendMessage(text, 'friend');
    });
}

// 💡 替代 close 機制的黃金方案：建立一個主動「定時心跳監聽器（Heartbeat Check）」
// 每隔 5 秒鐘檢查一次連線，如果斷開了才被動呼叫重連，這在移動端排版中是最高效穩定的作法！
setInterval(() => {
    if (currentFriendPk && (!p2pPeer || !p2pPeer.connected) && !isPeerConnecting) {
        console.log("🔍 心跳偵測：目前處於離線，啟動安全被動重連管線...");
        triggerNostrReconnect();
    }
}, 5000);

function setupPeerEvents() {
    // 保留這個空函式，防止 start 流程呼叫報錯
    p2pPeer.on('connect', () => updateOnlineStatus(true));
    p2pPeer.on('data', (data) => {
        const text = data.toString();
        Storage.saveMessageLog(currentFriendPk, text, 'friend');
        appendMessage(text, 'friend');
    });
}
