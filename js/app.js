import { Storage } from './storage.js';
import { Crypto } from './crypto.js';
import { NostrManager } from './nostr.js';

let myKeyPair = Storage.getMyKeys();
let p2pPeer = null;
let currentFriendPk = null;
let nostr = new NostrManager('wss://relay.damus.io');

// 初始化或生成 Nostr 金鑰
if (!myKeyPair.sk || !myKeyPair.pk) {
    // 修正為新版 nostr-tools 的正確全域 API
    const sk = window.NostrTools.generatePrivateKey();
    const pk = window.NostrTools.getPublicKey(sk);
    Storage.saveKeyPair(sk, pk);
    myKeyPair = { sk, pk };
    console.log("為您生成全新的 Nostr 身份:", pk);
}

nostr.connect().then(() => {
    const friends = Storage.getFriends();
    Object.keys(friends).forEach(friendPk => {
        listenForReconnect(friendPk);
    });
});

document.getElementById('btn-create').addEventListener('click', startAsInitiator);
document.getElementById('btn-scan').addEventListener('click', startCameraScan);

function startAsInitiator() {
    alert("正在建立 WebRTC 連線，請稍候...");
    
    // 修正點：使用 window.SimplePeer
    p2pPeer = new window.SimplePeer({
        initiator: true,
        trickle: false,
        config: undefined
    });

    p2pPeer.on('signal', async (webrtcData) => {
        const connectionPackage = {
            type: 'offer',
            sdp: webrtcData,
            pubkey: myKeyPair.pk
        };
        
        const qrContent = JSON.stringify(connectionPackage);
        const container = document.getElementById('qrcode-container');
        container.innerHTML = '<h3>請對方掃描此 QR Code：</h3>';
        const canvas = document.createElement('canvas');
        container.appendChild(canvas);
        
        window.QRCode.toCanvas(canvas, qrContent, { width: 256 }, (err) => {
            if (err) console.error(err);
        });

        startCameraScanForAnswer();
    });

    setupPeerEvents();
}

function startCameraScan() {
    document.getElementById('reader').style.display = 'block';

    // 修正點：使用 window.Html5Qrcode
    const html5QrcodeScanner = new window.Html5Qrcode("reader");
    html5QrcodeScanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: 250 },
        async (decodedText) => {
            await html5QrcodeScanner.stop();
            document.getElementById('reader').style.display = 'none';
            
            try {
                const incomingData = JSON.parse(decodedText);
                if (incomingData.type === 'offer') {
                    handleIncomingOffer(incomingData);
                }
            } catch (e) {
                alert("無效的 QR Code 格式！");
            }
        },
        () => {}
    ).catch(() => alert("相機啟動失敗，請確認是否為 HTTPS 環境並允許權限"));
}

function handleIncomingOffer(offerPackage) {
    currentFriendPk = offerPackage.pubkey;

    // 修正點：使用 window.SimplePeer
    p2pPeer = new window.SimplePeer({
        initiator: false,
        trickle: false,
        config: undefined
    });

    p2pPeer.signal(offerPackage.sdp);

    p2pPeer.on('signal', async (webrtcData) => {
        const answerPackage = {
            type: 'answer',
            sdp: webrtcData,
            pubkey: myKeyPair.pk
        };

        const sharedSecret = await Crypto.getSharedSecret(myKeyPair.sk, currentFriendPk);
        Storage.saveFriend(currentFriendPk, sharedSecret, "當面加的好友");

        const container = document.getElementById('qrcode-container');
        container.innerHTML = '<h3>請發起方掃描此回應 QR Code：</h3>';
        const canvas = document.createElement('canvas');
        container.appendChild(canvas);
        window.QRCode.toCanvas(canvas, JSON.stringify(answerPackage), { width: 256 });
    });

    setupPeerEvents();
}

function startCameraScanForAnswer() {
    const html5QrcodeScanner = new window.Html5Qrcode("reader");
    document.getElementById('reader').style.display = 'block';
    
    html5QrcodeScanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: 250 },
        async (decodedText) => {
            try {
                const incomingData = JSON.parse(decodedText);
                if (incomingData.type === 'answer') {
                    await html5QrcodeScanner.stop();
                    document.getElementById('reader').style.display = 'none';
                    document.getElementById('qrcode-container').innerHTML = '';

                    currentFriendPk = incomingData.pubkey;
                    const sharedSecret = await Crypto.getSharedSecret(myKeyPair.sk, currentFriendPk);
                    Storage.saveFriend(currentFriendPk, sharedSecret, "當面加的好友");

                    p2pPeer.signal(incomingData.sdp);
                }
            } catch (e) { console.error(e); }
        },
        () => {}
    );
}

async function triggerNostrReconnect() {
    if (!currentFriendPk) return;
    const friends = Storage.getFriends();
    const friendData = friends[currentFriendPk];
    if (!friendData) return;

    p2pPeer = new window.SimplePeer({
        initiator: true,
        trickle: false,
        config: undefined
    });

    p2pPeer.on('signal', async (newWebrtcData) => {
        const reconnectOffer = { type: 'reconnect-offer', sdp: newWebrtcData, pubkey: myKeyPair.pk };
        const encryptedMessage = await Crypto.encryptData(myKeyPair.sk, currentFriendPk, JSON.stringify(reconnectOffer));
        await nostr.sendEvent(myKeyPair.sk, currentFriendPk, encryptedMessage);
    });

    setupPeerEvents();
}

function listenForReconnect(friendPk) {
    nostr.subscribeToFriend(myKeyPair.pk, friendPk, async (encryptedContent) => {
        try {
            const decryptedText = await Crypto.decryptData(myKeyPair.sk, friendPk, encryptedContent);
            const data = JSON.parse(decryptedText);

            if (data.type === 'reconnect-offer') {
                p2pPeer = new window.SimplePeer({
                    initiator: false,
                    trickle: false,
                    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
                });

                p2pPeer.on('signal', async (myNewAnswer) => {
                    const reconnectAnswer = { type: 'reconnect-answer', sdp: myNewAnswer, pubkey: myKeyPair.pk };
                    const encAnswer = await Crypto.encryptData(myKeyPair.sk, friendPk, JSON.stringify(reconnectAnswer));
                    await nostr.sendEvent(myKeyPair.sk, friendPk, encAnswer);
                });

                setupPeerEvents();
                p2pPeer.signal(data.sdp);
            } else if (data.type === 'reconnect-answer') {
                p2pPeer.signal(data.sdp);
            }
        } catch (e) {}
    });
}

function setupPeerEvents() {
    p2pPeer.on('connect', () => {
        alert("🎉 P2P 通道建立成功！");
        document.getElementById('qrcode-container').innerHTML = "";
        p2pPeer.send(`哈囉！這是一條不經伺服器的加密私訊。`);
    });

    p2pPeer.on('data', (data) => {
        alert(`【收到端對端訊息】：\n${data.toString()}`);
    });

    p2pPeer.on('close', () => triggerNostrReconnect());
    p2pPeer.on('error', () => triggerNostrReconnect());
}
