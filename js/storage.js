export const Storage = {
  // 保存自己的 Nostr 私鑰與公鑰
  saveKeyPair(sk, pk) {
    // 確保存入的絕對是純字串，如果傳進來的是 Uint8Array 則進行轉換
    let skStr = sk;
    if (sk instanceof Uint8Array || typeof sk === 'object') {
      skStr = Array.from(sk).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    localStorage.setItem('my_sk', skStr);
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
    
    // 確保轉成純 Hex 字串存檔
    let secretStr = sharedSecret;
    if (sharedSecret instanceof Uint8Array || typeof sharedSecret === 'object') {
      secretStr = Array.from(sharedSecret).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    
    friends[friendPk] = { name, sharedSecret: secretStr, status: 'offline' };
    localStorage.setItem('friends', JSON.stringify(friends));
  },
  
  getFriends() {
    return JSON.parse(localStorage.getItem('friends') || '{}');
  }
};
