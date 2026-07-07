export const Crypto = {
  async getSharedSecret(myPrivateKeyHex, friendPublicKeyHex) {
    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(myPrivateKeyHex + friendPublicKeyHex);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      console.error("生成共享金鑰失敗:", e);
      return null;
    }
  },

  // 使用標準 NIP-04 全域加解密方法
  async encryptData(myPrivateKey, friendPublicKey, plainText) {
    try {
      return await window.NostrTools.nip04.encrypt(myPrivateKey, friendPublicKey, plainText);
    } catch (e) {
      console.error("加密失敗:", e);
      return null;
    }
  },

  // 標準 NIP-04 全域解密方法
  async decryptData(myPrivateKey, friendPublicKey, cipherText) {
    try {
      return await window.NostrTools.nip04.decrypt(myPrivateKey, friendPublicKey, cipherText);
    } catch (e) {
      console.error("解密失敗:", e);
      return null;
    }
  }
};
