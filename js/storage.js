export const Storage = {
  // 💡 容錯機制：杜絕損壞快取導致白畫面
  safeParse(jsonStr, fallback = {}) {
    try {
      return jsonStr ? JSON.parse(jsonStr) : fallback;
    } catch(e) {
      console.warn("🛡️ 發現損壞的快取數據，已自動啟動容錯回滾。");
      return fallback;
    }
  },

  saveEncryptedKeyPair(encryptedSkHex, pk) {
    localStorage.setItem('my_esk', encryptedSkHex);
    localStorage.setItem('my_pk', pk);
  },

  getEncryptedKeyPair() {
    return { 
      esk: localStorage.getItem('my_esk'), 
      pk: localStorage.getItem('my_pk') 
    };
  },

  saveFriend(friendPk, name = 'P2P信任聯絡人') {
    const friends = this.safeParse(localStorage.getItem('friends'), {});
    friends[friendPk] = { name };
    localStorage.setItem('friends', JSON.stringify(friends));
    localStorage.setItem('last_chat_pk', friendPk);
  },

  getFriends() {
    return this.safeParse(localStorage.getItem('friends'), {});
  },

  getLastChatPk() {
    return localStorage.getItem('last_chat_pk');
  },

  // 💡 容量控制：滾動式快取控制（最多 500 筆），避免爆滿
  saveMessageLog(friendPk, text, sender) {
    const logs = this.safeParse(localStorage.getItem(`logs_${friendPk}`), []);
    logs.push({ text, sender, timestamp: Date.now() });
    
    if (logs.length > 500) {
      logs.shift(); // 移除最舊的對話
    }
    localStorage.setItem(`logs_${friendPk}`, JSON.stringify(logs));
  },

  getMessageLogs(friendPk) {
    return this.safeParse(localStorage.getItem(`logs_${friendPk}`), []);
  },

  clearSession(friendPk) {
    localStorage.removeItem(`logs_${friendPk}`);
    localStorage.removeItem('last_chat_pk');
    const friends = this.safeParse(localStorage.getItem('friends'), {});
    delete friends[friendPk];
    localStorage.setItem('friends', JSON.stringify(friends));
  }
};
