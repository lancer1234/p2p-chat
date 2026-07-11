export const Crypto = {
  // 💡 高級防禦：利用 PBKDF2 + AES-GCM-256 加密快取私鑰，防範明文 XSS 提款
  async deriveKeyFromPin(pin) {
    const encoder = new TextEncoder();
    const pinBytes = encoder.encode(pin);
    const salt = encoder.encode("P2PChat_Salt_2026"); // 固定的密碼學鹽值
    
    const baseKey = await crypto.subtle.importKey(
      "raw", pinBytes, { name: "PBKDF2" }, false, ["deriveKey"]
    );
    
    return await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: 100000, // 10 萬次雜湊硬化防禦爆破
        hash: "SHA-256"
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  },

  async encryptSecret(plainText, pin) {
    try {
      const cryptoKey = await this.deriveKeyFromPin(pin);
      const encoder = new TextEncoder();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        cryptoKey,
        encoder.encode(plainText)
      );
      
      // 合併成可儲存的十六進位字串
      const combined = new Uint8Array(iv.length + encrypted.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(encrypted), iv.length);
      return window.NostrTools.bytesToHex(combined);
    } catch(e) {
      throw new Error("身分金鑰加密失敗，請確認加密套件。");
    }
  },

  async decryptSecret(cipherTextHex, pin) {
    try {
      const cryptoKey = await this.deriveKeyFromPin(pin);
      const combined = window.NostrTools.hexToBytes(cipherTextHex);
      const iv = combined.slice(0, 12);
      const encryptedData = combined.slice(12);
      
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv },
        cryptoKey,
        encryptedData
      );
      return new TextDecoder().decode(decrypted);
    } catch(e) {
      throw new Error("PIN 碼錯誤或金鑰受損，解密失敗。");
    }
  },

  // Nostr 信令端對端標準 NIP-04 加解密方法
  async encryptData(myPrivateKey, friendPublicKey, plainText) {
    try {
      return await window.NostrTools.nip04.encrypt(myPrivateKey, friendPublicKey, plainText);
    } catch (e) {
      throw new Error("NIP-04 加密失敗");
    }
  },

  async decryptData(myPrivateKey, friendPublicKey, cipherText) {
    try {
      return await window.NostrTools.nip04.decrypt(myPrivateKey, friendPublicKey, cipherText);
    } catch (e) {
      throw new Error("NIP-04 解密失敗");
    }
  }
};
