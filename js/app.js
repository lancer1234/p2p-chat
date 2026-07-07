import { Storage } from './storage.js';
import { Crypto } from './crypto.js';
import { NostrManager } from './nostr.js';

let myKeyPair = Storage.getMyKeys();
let p2pPeer = null;
let currentFriendPk = Storage.getLastChatPk(); 
let nostr = new NostrManager('wss://nos.lol');

if (!myKeyPair.sk || !myKeyPair.pk) {
    const sk = window.NostrTools.generatePrivateKey();
    const pk = window.NostrTools.getPublicKey(sk);
    Storage.saveKeyPair(sk, pk);
    myKeyPair = { sk, pk };
}

nostr.connect().then(() => {
    if (currentFriendPk) {
        showChatInterface();
        restoreChatLogs();
        updateOnlineStatus(false); // 預設顯示離線，等待背景重連握手
        triggerNostrReconnect();
    }
    
    const friends = Storage.getFriends();
    Object.keys(friends).forEach(friendPk => {
        listenForReconnect(friendPk);
    });
});

document.getElementById('btn-create').addEventListener('click', startAsInitiator);
document.getElementById('btn-scan').addEventListener('click', startCameraScan);
document.getElementById('btn-send').addEventListener('click', sendMessage);
document.getElementById('btn-leave').addEventListener('click', leaveChat); // 綁定離開對話按鈕
document.getElementById('input-msg').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

function startAsInitiator() {
    p2pPeer = new window.SimplePeer({ initiator: true, trickle: false, config: undefined });

    p2pPeer.on('signal', async (webrtcData) => {
        const connectionPackage = { type: 'offer', sdp: webrtcData, pubkey: myKeyPair.pk };
        const compressedData = window.LZString.compressToEncodedURIComponent(JSON.stringify(connectionPackage));
        
        document.getElementById('setup-container').style.display = 'none';
        const container = document.getElementById('qrcode-container');
        container.style.display = 'block';
        
        const qr = window.qrcode(0, 'M');
        qr.addData(compressedData);
        qr.make();
        container.innerHTML = '<h3>請對方掃描 QR Code</h3>' + qr.createImgTag(6);

        startCameraScanForAnswer();
    });
    setupPeerEvents();
}

function startCameraScan() {
    document.getElementById('setup-container').style.display = 'none';
    document.getElementById('reader').style.display = 'block';

    const html5QrcodeScanner = new window.Html5Qrcode("reader");
    html5QrcodeScanner.start(
        { facingMode: "environment" },
        { fps: 15, qrbox: 250 },
        async (decodedText) => {
            await html5QrcodeScanner.stop();
            document.getElementById('reader').style.display = 'none';
            try {
                const decompressed = window.LZString.decompressFromEncodedURIComponent(decodedText);
                const incomingData = JSON.parse(decompressed);
                if (incomingData.type === 'offer') handleIncomingOffer(incomingData);
            } catch (e) {
                alert("QR Code 格式錯誤");
                location.reload();
            }
        },
        () => {}
    ).catch(() => location.reload());
}

function handleIncomingOffer(offerPackage) {
    currentFriendPk = offerPackage.pubkey;
    p2pPeer = new window.SimplePeer({ initiator: false, trickle: false, config: undefined });
    p2pPeer.signal(offerPackage.sdp);

    p2pPeer.on('signal', async (webrtcData) => {
        const answerPackage = { type: 'answer', sdp: webrtcData, pubkey: myKeyPair.pk };
        const sharedSecret = await Crypto.getSharedSecret(myKeyPair.sk, currentFriendPk);
        Storage.saveFriend(currentFriendPk, sharedSecret);

        const compressedAnswer = window.LZString.compressToEncodedURIComponent(JSON.stringify(answerPackage));
        const container = document.getElementById('qrcode-container');
        container.style.display = 'block';
        
        const qr = window.qrcode(0, 'M');
        qr.addData(compressedAnswer);
        qr.make();
        container.innerHTML = '<h3>請發起方反掃回應 QR Code</h3>' + qr.createImgTag(6);
    });
    setupPeerEvents();
}

function startCameraScanForAnswer() {
    const html5QrcodeScanner = new window.Html5Qrcode("reader");
    document.getElementById('reader').style.display = 'block';
    
    html5QrcodeScanner.start(
        { facingMode: "environment" },
        { fps: 15, qrbox: 250 },
        async (decodedText) => {
            try {
                const decompressed = window.LZString.decompressFromEncodedURIComponent(decodedText);
                const incomingData = JSON.parse(decompressed);
                if (incomingData.type === 'answer') {
                    await html5QrcodeScanner.stop();
                    document.getElementById('reader').style.display = 'none';
                    document.getElementById('qrcode-container').style.display = 'none';

                    currentFriendPk = incomingData.pubkey;
                    const sharedSecret = await Crypto.getSharedSecret(myKeyPair.sk, currentFriendPk);
                    Storage.saveFriend(currentFriendPk, sharedSecret);

                    p2pPeer.signal(incomingData.sdp);
                }
            } catch (e) { console.error(e); }
        },
        () => {}
    ).catch(err => console.error(err));
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
        appendMessage("⚠️ 目前處於離線狀態，無法送出訊息。", "system");
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
    logs.forEach(log => {
        appendMessage(log.text, log.sender);
    });
    if (logs.length === 0) {
        box.innerHTML = `<div class="msg system">加密信道已就緒，等待連線...</div>`;
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

// 新增：管理對方是否在線上的 UI 燈號更新
function updateOnlineStatus(isOnline) {
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    if (isOnline) {
        dot.style.background = '#00FFCC';
        dot.style.boxShadow = '0 0 8px #00FFCC';
        text.innerText = 'ONLINE';
        text.style.color = '#00FFCC';
    } else {
        dot.style.background = '#52525B'; // 灰燈代表對方目前不在線上
        dot.style.boxShadow = 'none';
        text.innerText = 'OFFLINE (RECONNECTING)';
        text.style.color = '#52525B';
    }
}

// 新增：離開對話的核心函數
function leaveChat() {
    if (!confirm("確定要終止並離開對話？這將會徹底抹除本地的所有對話紀錄。")) return;
    
    if (p2pPeer) {
        try { p2pPeer.destroy(); } catch(e) {}
    }
    if (currentFriendPk) {
        Storage.clearSession(currentFriendPk);
    }
    location.href = location.pathname; // 重新洗牌，回到乾淨的首頁邀請狀態
}

async function triggerNostrReconnect() {
    if (!currentFriendPk) return;
    updateOnlineStatus(false); // 觸發重連時，立刻切為離線燈號

    const friends = Storage.getFriends();
    const friendData = friends[currentFriendPk];
    if (!friendData) return;

    if (!p2pPeer || p2pPeer.destroyed) {
        p2pPeer = new window.SimplePeer({ initiator: true, trickle: false, config: undefined });
        p2pPeer.on('signal', async (newWebrtcData) => {
            const reconnectOffer = { type: 'reconnect-offer', sdp: newWebrtcData, pubkey: myKeyPair.pk };
            const encryptedMessage = await Crypto.encryptData(myKeyPair.sk, currentFriendPk, JSON.stringify(reconnectOffer));
            await nostr.sendEvent(myKeyPair.sk, currentFriendPk, encryptedMessage);
        });
        setupPeerEvents();
    }
}

function listenForReconnect(friendPk) {
    nostr.subscribeToFriend(myKeyPair.pk, friendPk, async (encryptedContent) => {
        try {
            const decryptedText = await Crypto.decryptData(myKeyPair.sk, friendPk, encryptedContent);
            const data = JSON.parse(decryptedText);

            if (data.type === 'reconnect-offer') {
                p2pPeer = new window.SimplePeer({ initiator: false, trickle: false, config: undefined });
                p2pPeer.on('signal', async (myNewAnswer) => {
                    const reconnectAnswer = { type: 'reconnect-answer', sdp: myNewAnswer, pubkey: myKeyPair.pk };
                    const encAnswer = await Crypto.encryptData(myKeyPair.sk, friendPk, JSON.stringify(reconnectAnswer));
                    await nostr.sendEvent(myKeyPair.sk, friendPk, encAnswer);
                });
                setupPeerEvents();
                p2pPeer.signal(data.sdp);
            } else if (data.type === 'reconnect-answer') {
                if (p2pPeer) p2pPeer.signal(data.sdp);
            }
        } catch (e) {}
    });
}

function setupPeerEvents() {
    p2pPeer.on('connect', () => {
        showChatInterface();
        updateOnlineStatus(true); // 直連成功，秒切為 ONLINE 綠燈！
    });

    p2pPeer.on('data', (data) => {
        const text = data.toString();
        Storage.saveMessageLog(currentFriendPk, text, 'friend');
        appendMessage(text, 'friend');
    });

    p2pPeer.on('close', () => triggerNostrReconnect());
    p2pPeer.on('error', () => triggerNostrReconnect());
}
