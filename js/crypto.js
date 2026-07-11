export function bytesToHex(bytes) {
  return [...bytes].map(function(b) {
    return b.toString(16).padStart(2, "0");
  }).join("");
}

export function hexToBytes(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return arr;
}

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
    
    return bytesToHex(combined);
  },

  async decryptSecret(cipherTextHex, pin) {
    if (!cipherTextHex) {
        throw new Error("找不到任何已存的身分私鑰密文包。");
    }

    const combined = hexToBytes(cipherTextHex);
    if (combined.length < 29) {
        throw new Error("INVALID_FORMAT: 檢測到舊格式明文快取，請執行清除快取指令。");
    }
    
    const salt = combined.slice(0, 16);
    const iv = combined.slice(16, 28);
    const encryptedData = combined.slice(28);
    
    const cryptoKey = await this.deriveKeyFromPin(pin, salt);
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
