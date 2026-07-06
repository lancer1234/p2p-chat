export const Crypto = {
  async getSharedSecret(myPrivateKey, friendPublicKey) {
    try {
      // 統一改用全域的 window.NostrTools
      return await window.NostrTools.nip04.getSharedSecret(myPrivateKey, friendPublicKey);
    } catch (e) {
      console.error("生成共享金鑰失敗:", e);
      return null;
    }
  },

  async encryptData(myPrivateKey, friendPublicKey, plainText) {
    return await window.NostrTools.nip04.encrypt(myPrivateKey, friendPublicKey, plainText);
  },

  async decryptData(myPrivateKey, friendPublicKey, cipherText) {
    return await window.NostrTools.nip04.decrypt(myPrivateKey, friendPublicKey, cipherText);
  }
};
