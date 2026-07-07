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
    localStorage.setItem('last_chat_pk', friendPk); // 紀錄最後通話的好友 PK
  },
  getFriends() {
    return JSON.parse(localStorage.getItem('friends') || '{}');
  },
  getLastChatPk() {
    return localStorage.getItem('last_chat_pk');
  },
  // 新增：儲存單條聊天紀錄到本地庫
  saveMessageLog(friendPk, text, sender) {
    const logs = JSON.parse(localStorage.getItem(`logs_${friendPk}`) || '[]');
    logs.push({ text, sender, timestamp: Date.now() });
    localStorage.setItem(`logs_${friendPk}`, JSON.stringify(logs));
  },
  // 新增：讀取歷史對話紀錄
  getMessageLogs(friendPk) {
    return JSON.parse(localStorage.getItem(`logs_${friendPk}`) || '[]');
  }
};
