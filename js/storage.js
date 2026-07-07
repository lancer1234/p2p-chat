export const Storage = {
  saveKeyPair(sk, pk) {
    const skHex = typeof sk === 'string' ? sk : window.NostrTools.bytesToHex(sk);
    localStorage.setItem('my_sk', skHex);
    localStorage.setItem('my_pk', pk);
  },
  getMyKeys() {
    return { sk: localStorage.getItem('my_sk'), pk: localStorage.getItem('my_pk') };
  },
  saveFriend(friendPk, sharedSecret, name = '當面加的好友') {
    const friends = JSON.parse(localStorage.getItem('friends') || '{}');
    let secretStr = sharedSecret;
    if (sharedSecret instanceof Uint8Array || typeof sharedSecret === 'object') {
      secretStr = Array.from(sharedSecret).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    friends[friendPk] = { name, sharedSecret: secretStr };
    localStorage.setItem('friends', JSON.stringify(friends));
    localStorage.setItem('last_chat_pk', friendPk);
  },
  getFriends() {
    return JSON.parse(localStorage.getItem('friends') || '{}');
  },
  getLastChatPk() {
    return localStorage.getItem('last_chat_pk');
  },
  saveMessageLog(friendPk, text, sender) {
    const logs = JSON.parse(localStorage.getItem(`logs_${friendPk}`) || '[]');
    logs.push({ text, sender, timestamp: Date.now() });
    localStorage.setItem(`logs_${friendPk}`, JSON.stringify(logs));
  },
  getMessageLogs(friendPk) {
    return JSON.parse(localStorage.getItem(`logs_${friendPk}`) || '[]');
  },
  // 新增：徹底清除本地與該好友的對話快取，實現無痕離開
  clearSession(friendPk) {
    localStorage.removeItem(`logs_${friendPk}`);
    localStorage.removeItem('last_chat_pk');
    const friends = JSON.parse(localStorage.getItem('friends') || '{}');
    delete friends[friendPk];
    localStorage.setItem('friends', JSON.stringify(friends));
  }
};
