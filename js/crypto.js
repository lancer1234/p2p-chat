export const Crypto = {
  // 🟢 徹底平鋪引數物件宣告，解決 Safari 的 Unexpected token '{' 解析臭蟲
  async deriveKeyFromPin(pin, saltBytes) {
    const encoder = new TextEncoder();
    const pinBytes = encoder.encode(pin);
    
    // 1. 將 importKey 的配置抽離成靜態常數變數
    const importFormat = "raw";
    const importAlgorithm = { name: "PBKDF2" };
    const extractable = false;
    const keyUsagesForDerive = ["deriveKey"];

    const baseKey = await crypto.subtle.importKey(
      importFormat,
      pinBytes,
      importAlgorithm,
      extractable,
      keyUsagesForDerive
    );
    
    // 2. 將 deriveKey 的配置完全打散抽離
    const deriveAlgorithm = {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: 500000,
      hash: "SHA-256"
    };
    const targetKeyAlgorithm = { name: "AES-GCM", length: 256 };
    const targetKeyUsages = ["encrypt", "decrypt"];

    return await crypto.subtle.deriveKey(
      deriveAlgorithm,
      baseKey,
      targetKeyAlgorithm,
      extractable,
      targetKeyUsages
    );
  },

  async encryptSecret(plainText, pin) {
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16)); 
    const iv = crypto.getRandomValues(new Uint8Array(12));   
    
    const cryptoKey = await this.deriveKeyFromPin(pin, salt);
    
    // 抽離 AES-GCM 配置引數物件
    const encryptAlgorithm = { name: "AES-GCM", iv: iv };
    const plainBytes = encoder.encode(plainText);

    const encrypted = await crypto.subtle.encrypt(
      encryptAlgorithm,
      cryptoKey,
      plainBytes
    );
    
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
    
    // 抽離 AES-GCM 配置引數物件
    const decryptAlgorithm = { name: "AES-GCM", iv: iv };

    const decrypted = await crypto.subtle.decrypt(
      decryptAlgorithm,
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
