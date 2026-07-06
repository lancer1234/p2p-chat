// 使用 CDN 載入的全域 simple-peer 庫
export function createP2PConnection(isInitiator, onSignal, onConnect, onData) {
  // 修正點：改用 window.SimplePeer，並將 config 設為 undefined 實現真正零伺服器本地秒出碼
  const p = new window.SimplePeer({
    initiator: isInitiator, // A 是 true, B 是 false
    trickle: false,         // 關閉 trickle 以便將所有 ICE 候選整合進單一 SDP
    config: undefined       // 當面掃碼不依賴 STUN 伺服器，速度最快
  });

  p.on('signal', data => {
    // 當產生 Offer 或 Answer 時觸發，將此 data 轉成 QR Code 
    onSignal(data);
  });

  p.on('connect', () => {
    console.log('P2P 連線成功！流量不再經過任何網路節點');
    onConnect();
  });

  p.on('data', data => {
    // 收到訊息或檔案
    onData(data.toString());
  });

  return p;
}
