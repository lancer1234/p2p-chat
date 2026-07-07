import { Storage } from './storage.js';
import { Crypto } from './crypto.js';
import { NostrManager } from './nostr.js';

let myKeyPair = Storage.getMyKeys();
let p2pPeer = null;
let currentFriendPk = Storage.getLastChatPk(); // 優化點：重新整理時自動繼承上次聊天的好友 PK
let nostr = new NostrManager('wss://nos.lol');

if (!myKeyPair.sk || !myKeyPair.pk) {
    const sk = window.NostrTools.generatePrivateKey();
    const pk = window.NostrTools.getPublicKey(sk);
    Storage.saveKeyPair(sk, pk);
    myKeyPair = { sk, pk };
}

// 核心重構：重新整理網頁時的生命週期判斷
nostr.connect().then(() => {
    if (currentFriendPk) {
        // 如果本地本來就有好友紀錄，直接免掃碼跳轉進聊天室，並還原紀錄
        showChatInterface();
        restoreChatLogs();
        // 背景自動啟動 Nostr 二次握手重連
        triggerNostrReconnect();
    }
    
    // 同步訂閱所有已知好友的重連通道
    const friends = Storage.getFriends();
    Object.keys(friends).forEach(friendPk => {
        listenForReconnect(friendPk);
    });
});

document.getElementById('btn-create').addEventListener('click', startAsInitiator);
document.getElementById('btn-scan').addEventListener('click', startCameraScan);
document.getElementById('btn-send').addEventListener('click', sendMessage);
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
        container.innerHTML = '<h3>請對方掃描 QR Code</h3>' + qr.createImgTag(6); // 稍微加粗一點圖案顆粒

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
    );
}

function sendMessage() {
    const input = document.getElementById('input-msg');
    const text = input.value.trim();
    if (!text) return;

    if (p2pPeer && p2pPeer.connected) {
        p2pPeer.send(text);
    }
    // 無論 WebRTC 是否直連成功，只要發送，就先存入本地庫並渲染
    Storage.saveMessageLog(currentFriendPk, text, 'me');
    appendMessage(text, 'me');
    input.value = '';
}

function appendMessage(text, sender) {
    const box = document.getElementById('chat-messages');
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('msg', sender);
    msgDiv.innerText = text;
    box.appendChild(msgDiv);
    box.scrollTop = box.scrollHeight;
}

// 還原聊天紀錄
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
    document.getElementById('chat-interface').style.display = 'flex';
}

async function triggerNostrReconnect() {
    if (!currentFriendPk) return;
    document.getElementById('status-dot').style.background = '#52525B';
    
    // 如果目前完全沒有 Peer 或者是已經斷開的 Peer，則全新建立
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
        document.getElementById('status-dot').style.background = '#00FFCC';
        document.getElementById('status-dot').style.boxShadow = '0 0 8px #00FFCC';
    });

    p2pPeer.on('data', (data) => {
        const text = data.toString();
        Storage.saveMessageLog(currentFriendPk, text, 'friend');
        appendMessage(text, 'friend');
    });

    p2pPeer.on('close', () => triggerNostrReconnect());
    p2pPeer.on('error', () => triggerNostrReconnect());
}
