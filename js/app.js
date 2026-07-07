import { Storage } from './storage.js';
import { Crypto } from './crypto.js';
import { NostrManager } from './nostr.js';

let myKeyPair = Storage.getMyKeys();
let p2pPeer = null;
let currentFriendPk = null;
let nostr = new NostrManager('wss://nos.lol');

if (!myKeyPair.sk || !myKeyPair.pk) {
    const sk = window.NostrTools.generatePrivateKey();
    const pk = window.NostrTools.getPublicKey(sk);
    Storage.saveKeyPair(sk, pk);
    myKeyPair = { sk, pk };
    console.log("全新身分已就緒:", pk);
}

nostr.connect().then(() => {
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
        
        // 核心優化：將原本沉重的 JSON 利用 lz-string 進行大幅壓縮，大幅縮小 QR Code 顆粒度
        const compressedData = window.LZString.compressToEncodedURIComponent(JSON.stringify(connectionPackage));
        
        const container = document.getElementById('qrcode-container');
        container.style.display = 'block';
        document.getElementById('setup-container').style.display = 'none'; // 隱藏主選單，優化版面
        
        const qr = window.qrcode(0, 'M');
        qr.addData(compressedData); // 餵入壓縮後的精簡代碼
        qr.make();
        container.innerHTML = '<h3>請對方掃描 QR Code</h3>' + qr.createImgTag(5);

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
        { fps: 15, qrbox: 220 }, // 優化偵測框形
        async (decodedText) => {
            await html5QrcodeScanner.stop();
            document.getElementById('reader').style.display = 'none';
            
            try {
                // 解壓縮還原封包
                const decompressed = window.LZString.decompressFromEncodedURIComponent(decodedText);
                const incomingData = JSON.parse(decompressed);
                if (incomingData.type === 'offer') {
                    handleIncomingOffer(incomingData);
                }
            } catch (e) {
                alert("QR Code 解析失敗或格式不符");
                location.reload();
            }
        },
        () => {}
    ).catch(() => {
        alert("相機異常");
        location.reload();
    });
}

function handleIncomingOffer(offerPackage) {
    currentFriendPk = offerPackage.pubkey;

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

        // 核心優化：對 Response 封包進行二次壓縮
        const compressedAnswer = window.LZString.compressToEncodedURIComponent(JSON.stringify(answerPackage));

        const container = document.getElementById('qrcode-container');
        container.style.display = 'block';
        
        const qr = window.qrcode(0, 'M');
        qr.addData(compressedAnswer);
        qr.make();
        container.innerHTML = '<h3>請發起方反掃此回應 QR Code</h3>' + qr.createImgTag(5);
    });

    setupPeerEvents();
}

function startCameraScanForAnswer() {
    const html5QrcodeScanner = new window.Html5Qrcode("reader");
    document.getElementById('reader').style.display = 'block';
    
    html5QrcodeScanner.start(
        { facingMode: "environment" },
        { fps: 15, qrbox: 220 },
        async (decodedText) => {
            try {
                // 解壓縮還原 Answer 封包
                const decompressed = window.LZString.decompressFromEncodedURIComponent(decodedText);
                const incomingData = JSON.parse(decompressed);
                if (incomingData.type === 'answer') {
                    await html5QrcodeScanner.stop();
                    document.getElementById('reader').style.display = 'none';
                    document.getElementById('qrcode-container').style.display = 'none';

                    currentFriendPk = incomingData.pubkey;
                    const sharedSecret = await Crypto.getSharedSecret(myKeyPair.sk, currentFriendPk);
                    Storage.saveFriend(currentFriendPk, sharedSecret, "當面加的好友");

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
    if (!text || !p2pPeer) return;

    p2pPeer.send(text);
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

async function triggerNostrReconnect() {
    if (!currentFriendPk) return;
    document.getElementById('status-dot').style.background = '#EF4444';
    document.getElementById('status-dot').style.boxShadow = '0 0 8px #EF4444';
    appendMessage("連線中斷，正在透過 Nostr 機制建立二次握手...", "system");

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
                    config: undefined
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
        document.getElementById('setup-container').style.display = 'none';
        document.getElementById('qrcode-container').style.display = 'none';
        document.getElementById('reader').style.display = 'none';
        
        // 展現滿版極簡聊天介面
        const chatUI = document.getElementById('chat-interface');
        chatUI.style.display = 'flex'; 
        document.getElementById('status-dot').style.background = '#00FFCC';
        document.getElementById('status-dot').style.boxShadow = '0 0 8px #00FFCC';
        
        const box = document.getElementById('chat-messages');
        box.innerHTML = `<div class="msg system">SECURE END-TO-END CHANNEL ESTABLISHED</div>`;
    });

    p2pPeer.on('data', (data) => {
        appendMessage(data.toString(), 'friend');
    });

    p2pPeer.on('close', () => triggerNostrReconnect());
    p2pPeer.on('error', () => triggerNostrReconnect());
}
