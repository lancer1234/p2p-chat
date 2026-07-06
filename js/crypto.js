// 引入 nostr-tools 的瀏覽器打包版
import { windowNostrTools } from 'https://unpkg.com/nostr-tools/lib/nostr.bundle.js';

export const Crypto = {
  // 1. 利用自己的私鑰與對方的公鑰，經由 ECDH 演算法算出共享金鑰 K
  async getSharedSecret(myPrivateKey, friendPublicKey) {
    try {
      return await windowNostrTools.nip04.getSharedSecret(myPrivateKey, friendPublicKey);
    } catch (e) {
      console.error("生成共享金鑰失敗:", e);
      return null;
    }
  },

  // 2. 用共享金鑰加密文字（例如加密 WebRTC 的 Offer/Answer）
  async encryptData(myPrivateKey, friendPublicKey, plainText) {
    // NIP-04 是 Nostr 的傳統私訊加密標準
    return await windowNostrTools.nip04.encrypt(myPrivateKey, friendPublicKey, plainText);
  },

  // 3. 用共享金鑰解密文字
  async decryptData(myPrivateKey, friendPublicKey, cipherText) {
    return await windowNostrTools.nip04.decrypt(myPrivateKey, friendPublicKey, cipherText);
  }
};
