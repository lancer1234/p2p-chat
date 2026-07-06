import { Storage } from './storage.js';
import { Crypto } from './crypto.js';
import { NostrManager } from './nostr.js';

// --- 1. 全域變數與初始化狀態 ---
let myKeyPair = Storage.getMyKeys();
let p2pPeer = null;
let currentFriendPk = null;
let nostr = new NostrManager('wss://relay.damus.io'); // 可更換為任何公開 Relay

// 如果是第一次打開網頁，自動生成一組 Nostr 公私鑰
if (!myKeyPair.sk || !myKeyPair.pk) {
    // 使用 windowNostrTools 生成隨機私鑰
    const sk = window.windowNostrTools.generateSecretKey();
    const pk = window.windowNostrTools.getPublicKey(sk);
    Storage.saveKeyPair(sk, pk);
    myKeyPair = { sk, pk };
    console.log("已為您生成全新的 Nostr 身份:", pk);
}

// 初始化啟動 Nostr 連線（為隨時重連做準備）
nostr.connect().then(() => {
    // 如果本地已經有存好的好友，自動啟動背景監聽，等待重連
    const friends = Storage.getFriends();
    Object.keys(friends).forEach(friendPk => {
        listenForReconnect(friendPk);
    });
});

// --- 2. 介面按鈕事件綁定 ---
document.getElementById('btn-create').addEventListener('click', startAsInitiator);
document.getElementById('btn-scan').addEventListener('click', startCameraScan);

// --- 3. 核心邏輯 A：當面掃碼綁定流程（首次連線） ---

// A-1: 我是發起方（秀出第一個 QR Code）
function startAsInitiator() {
    updateUIStatus("正在初始化 WebRTC Offer...");
    
    // 建立一個 WebRTC 發起端 (initiator: true)
    p2pPeer = new SimplePeer({
        initiator: true,
        trickle: false, // 必須為 false，把所有網路節點包進單一 SDP，才能做成 QR Code
        config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
    });

    p2pPeer.on('signal', async (webrtcData) => {
        // 將 WebRTC Offer 加上我的 Nostr 公鑰，打包成一個連線包裹
        const connectionPackage = {
            type: 'offer',
            sdp: webrtcData,
            pubkey: myKeyPair.pk
        };
        
        // 轉成 JSON 並用 lz-string 壓縮（此處簡化為直接轉字串，建議正式版加上壓縮）
        const qrContent = JSON.stringify(connectionPackage);
        
        // 渲染成 QR Code
        const container = document.getElementById('qrcode-container');
        container.innerHTML = '<h3>請對方掃描此 QR Code：</h3>';
        const canvas = document.createElement('canvas');
        container.appendChild(canvas);
        QRCode.toCanvas(canvas, qrContent, { width: 256 }, (err) => {
            if (err) console.error(err);
            updateUIStatus("等待對方掃描並回傳 Answer QR Code...");
        });

        // 開啟相機，準備掃描對方等一下產生出來的回應 QR Code
        startCameraScanForAnswer();
    });

    setupPeerEvents();
}

// A-2: 我是接收方（開啟相機掃描 Offer）
function startCameraScan() {
    document.getElementById('reader').style.display = 'block';
    updateUIStatus("相機啟動中，請對準對方的「邀請 QR Code」...");

    const html5QrcodeScanner = new Html5Qrcode("reader");
    html5QrcodeScanner.start(
        { facingMode: "environment" }, // 使用後鏡頭
        { fps: 10, qrbox: 250 },
        async (decodedText) => {
            // 掃描成功，停止相機
            await html5QrcodeScanner.stop();
            document.getElementById('reader').style.display = 'none';
            
            try {
                const incomingData = JSON.parse(decodedText);
                if (incomingData.type === 'offer') {
                    // 處理對方的 Offer 並產生 Answer
                    handleIncomingOffer(incomingData);
                }
            } catch (e) {
                alert("無效的 QR Code 格式！");
            }
        },
        (errorMessage) => { /* 忽略掃描中的雜訊 */ }
    ).catch(err => alert("相機啟動失敗，請確認是否為 HTTPS 環境並允許權限"));
}

// A-3: 接收方處理 Offer，並秀出 Answer QR Code
function handleIncomingOffer(offerPackage) {
    currentFriendPk = offerPackage.pubkey;
    updateUIStatus("已讀取對方身份，正在計算回應信令...");

    // 建立一個 WebRTC 接收端 (initiator: false)
    p2pPeer = new SimplePeer({
        initiator: false,
        trickle: false,
        config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
    });

    // 把對方的 SDP 餵給我的 WebRTC
    p2pPeer.signal(offerPackage.sdp);

    p2pPeer.on('signal', async (webrtcData) => {
        // 打包我的 Answer 與我的公鑰
        const answerPackage = {
            type: 'answer',
            sdp: webrtcData,
            pubkey: myKeyPair.pk
        };

        // 算出共享金鑰並存檔好友
        const sharedSecret = await Crypto.getSharedSecret(myKeyPair.sk, currentFriendPk);
        Storage.saveFriend(currentFriendPk, sharedSecret, "當面加的好友");

        // 秀出 Answer QR Code 讓發起方掃回去
        const container = document.getElementById('qrcode-container');
        container.innerHTML = '<h3>請發起方掃描此回應 QR Code：</h3>';
        const canvas = document.createElement('canvas');
        container.appendChild(canvas);
        QRCode.toCanvas(canvas, JSON.stringify(answerPackage), { width: 256 });
        updateUIStatus("對話建立中，請讓對方掃描此畫面...");
    });

    setupPeerEvents();
}

// A-4: 發起方專用：相機掃描回傳的 Answer
function startCameraScanForAnswer() {
    const html5QrcodeScanner = new Html5Qrcode("reader");
    document.getElementById('reader').style.display = 'block';
    
    // 輪詢監聽相機
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
                    // 發起方計算共享金鑰並存檔好友
                    const sharedSecret = await Crypto.getSharedSecret(myKeyPair.sk, currentFriendPk);
                    Storage.saveFriend(currentFriendPk, sharedSecret, "當面加的好友");

                    // 餵入 Answer，正式打通 P2P 通道！
                    p2pPeer.signal(incomingData.sdp);
                }
            } catch (e) { console.error("解析 Answer 失敗", e); }
        },
        () => {}
    );
}

// --- 4. 核心邏輯 B：Nostr 背景自動尋址重連流程（回家或切換網路時） ---

// 當 WebRTC 意外中斷時，觸發此處自動背對背重連
async function triggerNostrReconnect() {
    if (!currentFriendPk) return;
    updateUIStatus("網路中斷！正在嘗試透過 Nostr 尋求重新連線...");

    const friends = Storage.getFriends();
    const friendData = friends[currentFriendPk];
    if (!friendData) return;

    // 重新建立一個新的 WebRTC 發起連線
    p2pPeer = new SimplePeer({
        initiator: true,
        trickle: false,
        config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
    });

    p2pPeer.on('signal', async (newWebrtcData) => {
        const reconnectOffer = {
            type: 'reconnect-offer',
            sdp: newWebrtcData,
            pubkey: myKeyPair.pk
        };

        // 關鍵安全步驟：用共享金鑰加密這份新的 Offer
        const encryptedMessage = await Crypto.encryptData(myKeyPair.sk, currentFriendPk, JSON.stringify(reconnectOffer));
        
        // 透過 Nostr 公共中繼站射到網路上
        await nostr.sendEvent(myKeyPair.sk, currentFriendPk, encryptedMessage);
        console.log("重連 Offer 已安全加密並送上 Nostr 網路");
    });

    setupPeerEvents();
}

// 監聽有沒有好友在 Nostr 網路上大喊「我想重連」
function listenForReconnect(friendPk) {
    nostr.subscribeToFriend(myKeyPair.pk, friendPk, async (encryptedContent) => {
        try {
            // 用彼此才知道的密碼解密
            const decryptedText = await Crypto.decryptData(myKeyPair.sk, friendPk, encryptedContent);
            const data = JSON.parse(decryptedText);

            // 情況一：收到好友發出的重連請求 (Offer)
            if (data.type === 'reconnect-offer') {
                console.log("收到好友的重連請求，正在回應...");
                p2pPeer = new SimplePeer({
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
            } 
            // 情況二：我是發起重連的人，收到了好友回傳的 Answer
            else if (data.type === 'reconnect-answer') {
                console.log("收到好友的重連回應，打通管道！");
                p2pPeer.signal(data.sdp);
            }
        } catch (e) {
            // 解密失敗代表這不是發給我的信令，或者對方不是我儲存的好友，直接忽略
        }
    });
}

// --- 5. 通用基礎 WebRTC 事件綁定 ---
function setupPeerEvents() {
    p2pPeer.on('connect', () => {
        updateUIStatus("🎉 連線成功！您現在可以安全通訊了（純端對端）。");
        document.getElementById('qrcode-container').innerHTML = "";
        
        // 測試：連線成功後丟一記直球過去
        p2pPeer.send(`您好！這是一條不經過伺服器的神祕訊息。發送時間：${new Date().toLocaleTimeString()}`);
    });

    p2pPeer.on('data', (data) => {
        // 這裡處理收到訊息的行為（例如渲染到畫面上）
        alert(`【收到端對端訊息】：\n${data.toString()}`);
    });

    p2pPeer.on('close', () => {
        console.log("WebRTC 連線關閉");
        // 啟動斷線重連機制
        triggerNostrReconnect();
    });

    p2pPeer.on('error', (err) => {
        console.error("WebRTC 發生錯誤:", err);
        triggerNostrReconnect();
    });
}

// 輔助 UI 狀態更新
function updateUIStatus(msg) {
    console.log(msg);
    // 可在網頁建立一個 <div id="status"> 來承接這行字
}
