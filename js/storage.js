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

  saveFriend(friendPk, name) {
    if (!friendPk) return;
    const friends = this.safeParse(localStorage.getItem('friends'), {});
    const previous = friends[friendPk] || {};
    friends[friendPk] = {
      ...previous,
      name: name || previous.name || `聯絡人 ${friendPk.slice(0, 8)}`,
      createdAt: previous.createdAt || Date.now(),
      updatedAt: Date.now()
    };
    localStorage.setItem('friends', JSON.stringify(friends));
    localStorage.setItem('last_chat_pk', friendPk);
  },

  touchFriend(friendPk) {
    if (!friendPk) return;
    const friends = this.safeParse(localStorage.getItem('friends'), {});
    const previous = friends[friendPk] || {};
    friends[friendPk] = {
      ...previous,
      name: previous.name || `聯絡人 ${friendPk.slice(0, 8)}`,
      createdAt: previous.createdAt || Date.now(),
      updatedAt: Date.now()
    };
    localStorage.setItem('friends', JSON.stringify(friends));
    localStorage.setItem('last_chat_pk', friendPk);
  },

  getFriends() {
    return this.safeParse(localStorage.getItem('friends'), {});
  },

  getChatList() {
    const friends = this.getFriends();
    return Object.entries(friends).map(([pk, friend]) => {
      const logs = this.getMessageLogs(pk);
      const last = logs.length ? logs[logs.length - 1] : null;
      return {
        pk,
        name: friend.name || `聯絡人 ${pk.slice(0, 8)}`,
        createdAt: friend.createdAt || 0,
        updatedAt: last?.timestamp || friend.updatedAt || friend.createdAt || 0,
        lastMessage: last?.text || '',
        lastSender: last?.sender || null
      };
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  },

  getLastChatPk() {
    return localStorage.getItem('last_chat_pk');
  },

  saveMessageLog(friendPk, text, sender) {
    const logs = this.safeParse(localStorage.getItem(`logs_${friendPk}`), []);
    const timestamp = Date.now();
    logs.push({ text, sender, timestamp });
    if (logs.length > 500) logs.shift();
    localStorage.setItem(`logs_${friendPk}`, JSON.stringify(logs));
    this.touchFriend(friendPk);
  },

  getMessageLogs(friendPk) {
    return this.safeParse(localStorage.getItem(`logs_${friendPk}`), []);
  },

  clearSession(friendPk) {
    if (!friendPk) return;
    localStorage.removeItem(`logs_${friendPk}`);
    const friends = this.safeParse(localStorage.getItem('friends'), {});
    delete friends[friendPk];
    localStorage.setItem('friends', JSON.stringify(friends));
    if (localStorage.getItem('last_chat_pk') === friendPk) {
      const remaining = Object.keys(friends);
      if (remaining.length) localStorage.setItem('last_chat_pk', remaining[0]);
      else localStorage.removeItem('last_chat_pk');
    }
  },

  resetIdentity() {
    const friends = this.safeParse(localStorage.getItem('friends'), {});
    Object.keys(friends).forEach(function(friendPk) {
      localStorage.removeItem(`logs_${friendPk}`);
    });
    localStorage.removeItem('my_esk');
    localStorage.removeItem('my_pk');
    localStorage.removeItem('last_chat_pk');
    localStorage.removeItem('friends');
  }
};
