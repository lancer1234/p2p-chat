export const Storage = {
  safeParse(jsonStr, fallback = {}) {
    try {
      return jsonStr ? JSON.parse(jsonStr) : fallback;
    } catch(e) {
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

  saveMessageLog(friendPk, text, sender) {
    const logs = this.safeParse(localStorage.getItem(`logs_${friendPk}`), []);
    logs.push({ text, sender, timestamp: Date.now() });
    if (logs.length > 500) logs.shift();
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
  },

  // 💡 【精準重置身分】：僅物理銷毀密碼學核心、對話紀錄與好友，保留未來 UI 設定值
  resetIdentity() {
    const friends = this.safeParse(localStorage.getItem('friends'), {});
    Object.keys(friends).forEach(function(friendPk) {
        localStorage.removeItem(`logs_${friendPk}`);
    });
    localStorage.removeItem('my_esk');
    localStorage.removeItem('my_pk');
    localStorage.removeItem('last_chat_pk');
    localStorage.removeItem('friends');
    console.log("🧹 密碼學身分與通訊紀錄已安全抹除。");
  }
};
