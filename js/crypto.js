export const Crypto = {
  // 💡 優化：動態衍生 Key 機制，支援傳入自訂隨機鹽值，並將疊代提升至 500,000 次以抗衡 2026 算力標準
  async deriveKeyFromPin(pin, saltBytes) {
    const encoder = new TextEncoder();
    const pinBytes = encoder.encode(pin);
    
    const baseKey = await crypto.subtle.importKey(
      "raw", pinBytes, { name: "PBKDF2" }, false, ["deriveKey"]
    );
    
    return await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: saltBytes,
        iterations: 500000, // 💡 提升至 50 萬次防禦
        hash: "SHA-256"
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  },

  // 💡 升級：隨機 Salt + 隨機 IV 的完整密碼學防禦封包
  async encryptSecret(plainText, pin) {
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16)); // 💡 16 節節隨機鹽值
    const iv = crypto.getRandomValues(new Uint8Array(12));   // 12 節節隨機隨機 IV
    
    const cryptoKey = await this.deriveKeyFromPin(pin, salt);
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv },
      cryptoKey,
      encoder.encode(plainText)
    );
    
    // 包裝結構: [16 bytes Salt] + [12 bytes IV] + [Ciphertext]
    const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
    combined.set(salt, 0);
    combined.set(iv, salt.length);
    combined.set(new Uint8Array(encrypted), salt.length + iv.length);
    
    return window.NostrTools.bytesToHex(combined);
  },

  async decryptSecret(cipherTextHex, pin) {
    const combined = window.NostrTools.hexToBytes(cipherTextHex);
    if (combined.length < 29) throw new Error("數據包長度受損");
    
    const salt = combined.slice(0, 16);
    const iv = combined.slice(16, 28);
    const encryptedData = combined.slice(28);
    
    const cryptoKey = await this.deriveKeyFromPin(pin, salt);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv },
      cryptoKey,
      encryptedData
    );
    return new TextDecoder().decode(decrypted);
  },

  async encryptData(myPrivateKey, friendPublicKey, plainText) {
    return await window.NostrTools.nip04.encrypt(myPrivateKey, friendPublicKey, plainText);
  },

  async decryptData(myPrivateKey, friendPublicKey, cipherText) {
    return await window.NostrTools.nip04.decrypt(myPrivateKey, friendPublicKey, cipherText);
  }
};
