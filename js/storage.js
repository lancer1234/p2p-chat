// 使用瀏覽器自帶的 IndexedDB 或最簡單的 LocalStorage
export const Storage = {
  // 保存自己的 Nostr 私鑰與公鑰
  saveKeyPair(sk, pk) {
    localStorage.setItem('my_sk', sk);
    localStorage.setItem('my_pk', pk);
  },
  getMyKeys() {
    return { sk: localStorage.getItem('my_sk'), pk: localStorage.getItem('my_pk') };
  },
  // 保存好友資料
  saveFriend(friendPk, sharedSecret, name = '神祕好友') {
    const friends = JSON.parse(localStorage.getItem('friends') || '{}');
    friends[friendPk] = { name, sharedSecret, status: 'offline' };
    localStorage.setItem('friends', JSON.stringify(friends));
  },
  getFriends() {
    return JSON.parse(localStorage.getItem('friends') || '{}');
  }
};
