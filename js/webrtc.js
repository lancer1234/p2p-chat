// 使用 simple-peer 庫
export function createP2PConnection(isInitiator, onSignal, onConnect, onData) {
  const p = new SimplePeer({
    initiator: isInitiator, // A 是 true, B 是 false
    trickle: false,         // 關閉 trickle 以便將所有 ICE 候選整合進單一 SDP，方便做成 QR Code
    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] } // 使用 Google 免費 STUN
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
