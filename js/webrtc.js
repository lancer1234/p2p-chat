// 已將連線核心邏輯移至 app.js 以實現主從式防碰撞重連。
// 本檔案保留作為備用封裝參考。
export function createP2PConnection(isInitiator, onSignal, onConnect, onData, config) {
  const p = new window.SimplePeer({
    initiator: isInitiator,
    trickle: false,
    config: config || undefined
  });

  p.on('signal', data => onSignal(data));
  p.on('connect', () => onConnect());
  p.on('data', data => onData(data.toString()));

  return p;
}
