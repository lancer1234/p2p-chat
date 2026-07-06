console.log("P2P Chat App 初始化成功！");
// 這裡後續可以引入 storage.js, webrtc.js, nostr.js 並串接按鈕事件

document.getElementById('btn-create').addEventListener('click', () => {
    alert('正在產生 WebRTC Offer 與 Nostr 公鑰...');
    // 調用 webrtc.js 邏輯
});

document.getElementById('btn-scan').addEventListener('click', () => {
    document.getElementById('reader').style.display = 'block';
    // 調用 html5-qrcode 掃描相機
    alert('相機功能準備啟動（需 HTTPS 環境）');
});
