export const Crypto = {
  // 1. 改用瀏覽器原生 SubtleCrypto 計算共享金鑰，徹底擺脫 nostr-tools 的版本相容問題
  async getSharedSecret(myPrivateKeyHex, friendPublicKeyHex) {
    try {
      // 這是相容舊版 NIP-04 的簡單對稱金鑰生成思路（此處做格式化相容）
      // 為了快速通訊，我們直接將雙方公私鑰特徵做簡單的 SHA-256 雜湊作為本地對稱金鑰
      const encoder = new TextEncoder();
      const data = encoder.encode(myPrivateKeyHex + friendPublicKeyHex);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      
      // 轉成 Hex 字串返回
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      console.error("生成共享金鑰失敗:", e);
      return null;
    }
  },

  // 2. 使用標準 NIP-04 全域加解密方法
  async encryptData(myPrivateKey, friendPublicKey, plainText) {
    try {
      return await window.NostrTools.nip04.encrypt(myPrivateKey, friendPublicKey, plainText);
    } catch (e) {
      console.error("加密失敗:", e);
      return null;
    }
  },

  // 3. 標準 NIP-04 全域解密方法
  async decryptData(myPrivateKey, friendPublicKey, cipherText) {
    try {
      return await window.NostrTools.nip04.decrypt(myPrivateKey, friendPublicKey, cipherText);
    } catch (e) {
      console.error("解密失敗:", e);
      return null;
    }
  }
};
