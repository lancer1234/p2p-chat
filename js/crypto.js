export const Crypto = {
  // 使用標準 NIP-04 全域加解密方法（內部會自動處理 secp256k1 的 ECDH 共享金鑰）
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
