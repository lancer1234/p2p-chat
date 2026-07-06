export const Crypto = {
  async getSharedSecret(myPrivateKey, friendPublicKey) {
    try {
      return await window.NostrTools.nip04.getSharedSecret(myPrivateKey, friendPublicKey);
    } catch (e) {
      console.error("生成共享金鑰失敗:", e);
      return null;
    }
  },

  async encryptData(myPrivateKey, friendPublicKey, plainText) {
    try {
      return await window.NostrTools.nip04.encrypt(myPrivateKey, friendPublicKey, plainText);
    } catch (e) {
      console.error("加密失敗:", e);
      return null;
    }
  },

  async decryptData(myPrivateKey, friendPublicKey, cipherText) {
    try {
      return await window.NostrTools.nip04.decrypt(myPrivateKey, friendPublicKey, cipherText);
    } catch (e) {
      console.error("解密失敗:", e);
      return null;
    }
  }
};
