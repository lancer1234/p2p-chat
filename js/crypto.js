export const Crypto = {
  async deriveKeyFromPin(pin, saltBytes) {
    const encoder = new TextEncoder();
    const pinBytes = encoder.encode(pin);
    
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
    // 💡 修正點 2：加入防爆機制，避免 hexToBytes 傳入空值直接崩潰
    if (!cipherTextHex) {
        throw new Error("找不到加密私鑰，快取可能已損壞或遺失。");
    }

    const combined = window.NostrTools.hexToBytes(cipherTextHex);
    
    // 💡 修正點 3 的衍生防禦：如果長度不符合隨機 Salt 的新格式(16+12+密文)，直接判定為舊格式快取
    if (combined.length < 29) {
        throw new Error("INVALID_FORMAT: 偵測到舊版加密格式金鑰，請清空快取重新初始化。");
    }
    
    const salt = combined.slice(0, 16);
    const iv = combined.slice(16, 28);
    const encryptedData = combined.slice(28);
    
    const cryptoKey = await this.deriveKeyFromPin(pin, salt);
    const decryptAlgorithm = { name: "AES-GCM", iv: iv };

    // 這裡如果密鑰衍生錯誤，Web Crypto API 會直接拋出 OperationError 或 DataError
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
