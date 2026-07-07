import { Storage } from './storage.js';
import { Crypto } from './crypto.js';
import { NostrManager } from './nostr.js';

let myKeyPair = Storage.getMyKeys();
let p2pPeer = null;
let currentFriendPk = Storage.getLastChatPk(); // 重新整理時自動繼承上次聊天的好友 PK
let nostr = new NostrManager('wss://nos.lol');

// 初始化或生成 Nostr 金鑰
if (!myKeyPair.sk || !myKeyPair.pk) {
    const sk = window.NostrTools.generatePrivateKey();
    const pk = window.NostrTools.getPublicKey(sk);
    Storage.saveKeyPair(sk, pk);
    myKeyPair = { sk, pk };
}

// 網頁初始化與重新整理的生命週期管理
nostr.connect().then(() => {
    if (currentFriendPk) {
        // 如果本地本來就有配對成功的好友紀錄，直接進入聊天室並還原歷史訊息
        showChatInterface();
        restoreChatLogs();
        // 在背景悄悄發動 Nostr 二次握手重連，不干擾使用者讀取舊訊息
        triggerNostrReconnect();
    }
    
    // 同步訂閱所有已知好友的重連通道
    const friends = Storage.getFriends();
    Object.keys(friends).forEach(friendPk => {
        listenForReconnect(friendPk);
    });
});

// 事件監聽綁定
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
        // 大幅壓縮 SDP 封包，縮小 QR Code 顆粒度以利手機秒掃
        const compressedData = window.LZString.compressToEncodedURIComponent(JSON.stringify(connectionPackage));
        
        document.getElementById('setup-container').style.display = 'none';
        const container = document.getElementById('qrcode-container');
        container.style.display = 'block';
        
        const qr = window.qrcode(0, 'M');
        qr.addData(compressedData);
        qr.make();
        container.innerHTML = '<h3>請對方掃描 QR Code</h3>' + qr.createImgTag(6); // 增粗點陣顆粒，放大至 85% 滿版

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
    }
    // 傳出當下立刻持久化寫入本地庫並渲染
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

// 從儲存庫中抓出歷史紀錄還原至畫面上
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

// 切換為滿版聊天室 UI，並精準解鎖手指點擊穿透限制
function showChatInterface() {
    document.getElementById('setup-container').style.display = 'none';
    document.getElementById('qrcode-container').style.display = 'none';
    document.getElementById('reader').style.display = 'none';
    
    const chatUI = document.getElementById('chat-interface');
    chatUI.style.display = 'flex';
    chatUI.style.pointerEvents = 'auto'; // 解決隱形圖層攔截點擊的關鍵：解除穿透，恢復聊天室點擊！
}

async function triggerNostrReconnect() {
    if (!currentFriendPk) return;
    document.getElementById('status-dot').style.background = '#52525B'; // 顯示灰色：嘗試連線中
    document.getElementById('status-dot').style.boxShadow = 'none';

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
        document.getElementById('status-dot').style.background = '#00FFCC'; // 連線成功：亮綠燈
        document.getElementById('status-dot').style.boxShadow = '0 0 8px #00FFCC';
    });

    p2pPeer.on('data', (data) => {
        const text = data.toString();
        // 接收端收到訊息後寫入本地持久化歷史庫
        Storage.saveMessageLog(currentFriendPk, text, 'friend');
        appendMessage(text, 'friend');
    });

    p2pPeer.on('close', () => triggerNostrReconnect());
    p2pPeer.on('error', () => triggerNostrReconnect());
}
