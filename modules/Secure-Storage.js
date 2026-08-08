class SecureStorageModule {
    constructor() {
        this.salt = window.crypto.getRandomValues(new Uint8Array(16));
    }

    // Dérive une clé cryptographique à partir d'un mot de passe secret
    async _getKey(password) {
        const enc = new TextEncoder();
        const keyMaterial = await window.crypto.subtle.importKey(
            "raw",
            enc.encode(password),
            { name: "PBKDF2" },
            false,
            ["deriveKey"]
        );
        return window.crypto.subtle.deriveKey(
            {
                name: "PBKDF2",
                salt: this.salt,
                iterations: 100000,
                hash: "SHA-256"
            },
            keyMaterial,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
        );
    }

    // Chiffre et sauvegarde une donnée
    async setItem(key, data, password) {
        try {
            const cryptoKey = await this._getKey(password);
            const iv = window.crypto.getRandomValues(new Uint8Array(12));
            const enc = new TextEncoder();
            
            const encrypted = await window.crypto.subtle.encrypt(
                { name: "AES-GCM", iv: iv },
                cryptoKey,
                enc.encode(JSON.stringify(data))
            );

            // On stocke le sel, l'IV et les données chiffrées en Base64
            const bundle = {
                salt: Array.from(this.salt),
                iv: Array.from(iv),
                data: Array.from(new Uint8Array(encrypted))
            };

            localStorage.setItem(`secure_${key}`, JSON.stringify(bundle));
            return true;
        } catch (e) {
            console.error("Erreur de chiffrement :", e);
            return false;
        }
    }

    // Lit et déchiffre une donnée
    async getItem(key, password) {
        try {
            const raw = localStorage.getItem(`secure_${key}`);
            if (!raw) return null;

            const bundle = JSON.parse(raw);
            this.salt = new Uint8Array(bundle.salt);
            const iv = new Uint8Array(bundle.iv);
            const data = new Uint8Array(bundle.data);

            const cryptoKey = await this._getKey(password);

            const decrypted = await window.crypto.subtle.decrypt(
                { name: "AES-GCM", iv: iv },
                cryptoKey,
                data
            );

            const dec = new TextDecoder();
            return JSON.parse(dec.decode(decrypted));
        } catch (e) {
            console.error("Mot de passe incorrect ou données corrompues :", e);
            return null;
        }
    }
}

// Instance globale prête à l'emploi
window.secureStorage = new SecureStorageModule();
