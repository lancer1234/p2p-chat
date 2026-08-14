// WebRTC 輔助工具。
// 主連線生命週期仍由 app.js 控制，這裡集中放 diagnostics / candidate 判讀。

export function createP2PConnection(isInitiator, onSignal, onConnect, onData, config) {
  const peer = new window.SimplePeer({
    initiator: isInitiator,
    trickle: false,
    config: config || undefined
  });

  peer.on('signal', data => onSignal(data));
  peer.on('connect', () => onConnect());
  peer.on('data', data => onData(data.toString()));

  return peer;
}

export function getPeerConnection(peer) {
  return peer && peer._pc ? peer._pc : null;
}

export function parseCandidateType(candidateLine) {
  if (!candidateLine || typeof candidateLine !== 'string') return 'unknown';
  const match = candidateLine.match(/\btyp\s+(host|srflx|prflx|relay)\b/i);
  return match ? match[1].toLowerCase() : 'unknown';
}

export async function getSelectedCandidateInfo(peer) {
  const pc = getPeerConnection(peer);
  if (!pc || typeof pc.getStats !== 'function') return null;

  try {
    const stats = await pc.getStats();
    let selectedPair = null;

    stats.forEach(report => {
      if (report.type === 'transport' && report.selectedCandidatePairId) {
        selectedPair = stats.get(report.selectedCandidatePairId) || selectedPair;
      }
      if (report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded') {
        selectedPair = selectedPair || report;
      }
    });

    if (!selectedPair) return null;

    const local = stats.get(selectedPair.localCandidateId);
    const remote = stats.get(selectedPair.remoteCandidateId);

    return {
      localType: local && local.candidateType ? local.candidateType : 'unknown',
      remoteType: remote && remote.candidateType ? remote.candidateType : 'unknown',
      protocol: (local && local.protocol) || (remote && remote.protocol) || 'unknown',
      relayProtocol: (local && local.relayProtocol) || (remote && remote.relayProtocol) || '',
      usingTurn: !!((local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay'))
    };
  } catch (error) {
    return null;
  }
}
