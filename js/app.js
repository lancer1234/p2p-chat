import { Storage } from './storage.js';
import { Crypto } from './crypto.js';
import { NostrManager } from './nostr.js';

let myKeyPair = Storage.getMyKeys();
let p2pPeer = null;
let currentFriendPk = localStorage.getItem('last_chat_pk'); 
let nostr = new NostrManager(); 

let isNostrReady = false;
let isReconnecting = false;
let isInChatMode = false; 

// 建議保留 STUN 伺服器以確保跨網路（如 Wi-Fi 與 5G）時的穿透率；若要追求完全本地零伺服器，可將 iceServers 設為 []
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

if (!myKeyPair.sk || !myKeyPair.pk) {
    const sk = window.NostrTools.generatePrivateKey();
    const pk = window.NostrTools.getPublicKey(sk);
    Storage.saveKeyPair(sk, pk);
    myKeyPair = { sk, pk };
}

nostr.connect().then(() => {
    console.log("🌐 Nostr 網路骨幹已成功通電");
    isNostrReady = true;

    const friends = Storage.getFriends();
    Object.keys(friends).forEach(friendPk => {
        listenForMessages(friendPk);
    });

    if (currentFriendPk) {
        isInChatMode = true; 
        showChatInterface();
        restoreChatLogs();
        updateOnlineStatus(false);
        
        setTimeout(() => {
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

    const initSub = () => {
        if (isInChatMode || (p2pPeer && p2pPeer.connected)) return;
        nostr.subscribeToFriend(myKeyPair.pk, 'any', async (rawContent, authorPk) => {
            try {
                if (isInChatMode || (p2pPeer && p2pPeer.connected)) return;
                if (!authorPk) return;
                
                let data = null;

                try {
                    data = JSON.parse(rawContent);
                } catch (jsonErr) {
                    try {
                        const decryptedText = await Crypto.decryptData(myKeyPair.sk, authorPk, rawContent);
                        if (decryptedText) data = JSON.parse(decryptedText);
                    } catch (cryptoErr) {
                        return; 
                    }
                }

                if (data && data.type === 'init-offer') {
                    clearInterval(initTimer);
                    currentFriendPk = authorPk;
                    localStorage.setItem('last_chat_pk', currentFriendPk);
                    
                    強制銷毀舊連線實體();
                    
                    p2pPeer = new window.SimplePeer({ initiator: false, trickle: false, config: rtcConfig });
                    setupPeerEvents(); 
                    p2pPeer.signal(data.sdp);

                    p2pPeer.on('signal', async (webrtcAnswer) => {
                        const answerPackage = { type: 'init-answer', sdp: webrtcAnswer };
                        await nostr.sendEvent(myKeyPair.sk, currentFriendPk, JSON.stringify(answerPackage));
                    });

                    Storage.saveFriend(currentFriendPk);
                    
                    isInChatMode = true;
                    showChatInterface();
                    restoreChatLogs();
                }
            } catch (e) {}
        });
    };

    initSub();
    const initTimer = setInterval(() => {
        if (!isInChatMode && (!p2pPeer || !p2pPeer.connected)) {
            initSub();
        } else {
            clearInterval(initTimer);
        }
    }, 3000);
}

function startCameraScan() {
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
                await nostr.sendEvent(myKeyPair.sk, currentFriendPk, JSON.stringify(offerPackage));
            });

            Storage.saveFriend(currentFriendPk);
            listenForMessages(currentFriendPk);
        },
        () => {}
    ).catch(() => location.reload());
}

function listenForMessages(friendPk) {
    if (!friendPk) return;
    nostr.subscribeToFriend(myKeyPair.pk, friendPk, async (rawContent, authorPk) => {
        try {
            const senderPk = authorPk || friendPk;
            let data = null;
            
            try {
                data = JSON.parse(rawContent);
            } catch (jsonErr) {
                try {
                    const decryptedText = await Crypto.decryptData(myKeyPair.sk, senderPk, rawContent);
                    if (decryptedText) data = JSON.parse(decryptedText);
                } catch (cryptoErr) {
                    return;
                }
            }
            
            if (!data) return;

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
                console.log("📥 收到重連提議 (Offer)，轉為接收端應答...");
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
                console.log("📥 收到重連應答 (Answer)，直連管道建立中...");
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
        text.innerText = isReconnecting ? 'OFFLINE (RECONNECTING)' : 'OFFLINE';
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

    // 💡 【核心防碰撞鎖定】：比對公鑰字典序
    const amIInitiator = myKeyPair.pk > currentFriendPk;

    if (amIInitiator) {
        console.log("🔄 [主導端] 正在發射主動重連協議 Offer...");
        p2pPeer = new window.SimplePeer({ initiator: true, trickle: false, config: rtcConfig });
        setupPeerEvents(); 

        p2pPeer.on('signal', async (newWebrtcData) => {
            if (!currentFriendPk || !isInChatMode) return;
            
            const reconnectOffer = { type: 'reconnect-offer', sdp: newWebrtcData };
            const encryptedMessage = await Crypto.encryptData(myKeyPair.sk, currentFriendPk, JSON.stringify(reconnectOffer));
            await nostr.sendEvent(myKeyPair.sk, currentFriendPk, encryptedMessage);
        });
    } else {
        console.log("⏳ [接收端] 靜態轉入被動模式，等待主導端重連信號...");
        p2pPeer = new window.SimplePeer({ initiator: false, trickle: false, config: rtcConfig });
        setupPeerEvents();
        // 允許 8 秒後若仍未連線成功，解除重連鎖定以防單向死結
        setTimeout(() => { isReconnecting = false; }, 8000);
    }
}

setInterval(() => {
    if (isInChatMode && currentFriendPk && isNostrReady && (!p2pPeer || !p2pPeer.connected) && !isReconnecting) {
        console.log("🔍 心跳排查：直連中斷，雙向主動提議發動中...");
        triggerNostrReconnect();
    }
}, 5000);
