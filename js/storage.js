export const Storage = {
  // 保存自己的 Nostr 私鑰與公鑰
  saveKeyPair(sk, pk) {
    // 修正點：如果是 Uint8Array，先轉成標準 Hex 字串再存入
    const skHex = typeof sk === 'string' ? sk : window.NostrTools.bytesToHex(sk);
    localStorage.setItem('my_sk', skHex);
    localStorage.setItem('my_pk', pk);
  },
  
  getMyKeys() {
    return { 
      sk: localStorage.getItem('my_sk'), 
      pk: localStorage.getItem('my_pk') 
    };
  },
  
  // 保存好友資料
  saveFriend(friendPk, sharedSecret, name = '當面加的好友') {
    const friends = JSON.parse(localStorage.getItem('friends') || '{}');
    // 修正點：共享金鑰同樣確保轉換為字串保存
    const secretHex = typeof sharedSecret === 'string' ? sharedSecret : window.NostrTools.bytesToHex(sharedSecret);
    
    friends[friendPk] = { name, sharedSecret: secretHex, status: 'offline' };
    localStorage.setItem('friends', JSON.stringify(friends));
  },
  
  getFriends() {
    return JSON.parse(localStorage.getItem('friends') || '{}');
  }
};
