export const APP_SECURITY_STORAGE_KEY = 'pocketfiles.security.settings.v1';
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 64;
export const MIN_PATTERN_LENGTH = 4;

const LOCKOUT_THRESHOLD = 5;
const FIRST_LOCKOUT_MS = 30_000;
const MAX_LOCKOUT_MS = 5 * 60_000;
const WEB_PBKDF2_ITERATIONS = 310_000;
const CREDENTIAL_TYPES = new Set(['password', 'pattern']);

function publicSettings(record) {
  const credentialType = record?.credentialType || null;
  const biometricEnabled = record?.biometricEnabled === true;
  return {
    enabled: Boolean(credentialType || biometricEnabled),
    biometricEnabled,
    credentialType,
  };
}

function isValidCredentialRecord(record) {
  const hasCredential = CREDENTIAL_TYPES.has(record?.credentialType);
  return (
    record?.version === 3 &&
    (record.credentialType === null || hasCredential) &&
    (hasCredential
      ? /^[\da-f]{32}$/i.test(record.salt) && /^[\da-f]{64}$/i.test(record.credentialHash)
      : record.salt === null && record.credentialHash === null) &&
    typeof record.biometricEnabled === 'boolean' &&
    Number.isInteger(record.failedAttempts) &&
    record.failedAttempts >= 0 &&
    Number.isFinite(record.lockedUntil) &&
    record.lockedUntil >= 0
  );
}

function validateLegacyRecord(record) {
  return (
    record?.version === 1 &&
    /^[\da-f]{32}$/i.test(record.salt) &&
    /^[\da-f]{64}$/i.test(record.passcodeHash) &&
    Number.isInteger(record.failedAttempts) &&
    record.failedAttempts >= 0 &&
    Number.isFinite(record.lockedUntil) &&
    record.lockedUntil >= 0 &&
    typeof record.biometricEnabled === 'boolean' &&
    (record.credentialType === undefined ||
      ['passcode', 'password', 'pattern'].includes(record.credentialType))
  );
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isValidPassword(password) {
  return (
    typeof password === 'string' &&
    password.length >= MIN_PASSWORD_LENGTH &&
    password.length <= MAX_PASSWORD_LENGTH &&
    password.trim().length >= MIN_PASSWORD_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(password)
  );
}

export function isValidPattern(pattern) {
  return (
    typeof pattern === 'string' &&
    /^[1-9]+$/.test(pattern) &&
    pattern.length >= MIN_PATTERN_LENGTH &&
    pattern.length <= 9 &&
    new Set(pattern).size === pattern.length
  );
}

export function isValidCredential(type, credential) {
  if (type === 'password') return isValidPassword(credential);
  if (type === 'pattern') return isValidPattern(credential);
  return false;
}

export function createAppSecurity({
  platform,
  secureStore,
  crypto,
  webStorage,
  webCrypto = globalThis.crypto,
  now = Date.now,
}) {
  function getWebStorage() {
    try {
      const storage = webStorage || globalThis.localStorage;
      if (!storage) throw new Error('App security storage is unavailable.');
      return storage;
    } catch (error) {
      throw new Error('App security storage is unavailable.', { cause: error });
    }
  }

  async function readRaw() {
    if (platform === 'web') {
      const storage = getWebStorage();
      if (typeof storage.getItem !== 'function') {
        throw new Error('App security storage is unavailable.');
      }
      return storage.getItem(APP_SECURITY_STORAGE_KEY);
    }
    if (typeof secureStore?.getItemAsync !== 'function') {
      throw new Error('SecureStore is unavailable on this device.');
    }
    return secureStore.getItemAsync(APP_SECURITY_STORAGE_KEY);
  }

  async function writeRaw(value) {
    if (platform === 'web') {
      const storage = getWebStorage();
      if (typeof storage.setItem !== 'function') {
        throw new Error('App security storage is unavailable.');
      }
      storage.setItem(APP_SECURITY_STORAGE_KEY, value);
      return;
    }
    if (typeof secureStore?.setItemAsync !== 'function') {
      throw new Error('SecureStore is unavailable on this device.');
    }
    await secureStore.setItemAsync(APP_SECURITY_STORAGE_KEY, value);
  }

  async function deleteRaw() {
    if (platform === 'web') {
      const storage = getWebStorage();
      if (typeof storage.removeItem !== 'function') {
        throw new Error('App security storage is unavailable.');
      }
      storage.removeItem(APP_SECURITY_STORAGE_KEY);
      return;
    }
    if (typeof secureStore?.deleteItemAsync !== 'function') {
      throw new Error('SecureStore is unavailable on this device.');
    }
    await secureStore.deleteItemAsync(APP_SECURITY_STORAGE_KEY);
  }

  async function readRecord() {
    const raw = await readRaw();
    if (raw === null) return null;
    if (typeof raw !== 'string' || !raw.length) {
      throw new Error('Saved app security settings are invalid.');
    }
    let record;
    try {
      record = JSON.parse(raw);
    } catch (error) {
      throw new Error('Saved app security settings are corrupted.', { cause: error });
    }

    if (record?.version === 1) {
      if (!validateLegacyRecord(record)) {
        throw new Error('Saved app security settings are invalid.');
      }
      const migrated = {
        version: 3,
        credentialType: null,
        salt: null,
        credentialHash: null,
        biometricEnabled: platform !== 'web' && record.biometricEnabled === true,
        failedAttempts: 0,
        lockedUntil: 0,
      };
      await writeRaw(JSON.stringify(migrated));
      return migrated;
    }

    if (record?.version === 2 && typeof record.enabled === 'boolean') {
      const migrated = {
        version: 3,
        credentialType: null,
        salt: null,
        credentialHash: null,
        biometricEnabled: platform !== 'web' && record.enabled,
        failedAttempts: 0,
        lockedUntil: 0,
      };
      await writeRaw(JSON.stringify(migrated));
      return migrated;
    }

    if (!isValidCredentialRecord(record)) {
      throw new Error('Saved app security settings are invalid.');
    }
    if (platform === 'web' && record.biometricEnabled) {
      record.biometricEnabled = false;
      await writeRaw(JSON.stringify(record));
    }
    return record;
  }

  async function makeSalt() {
    let bytes;
    if (platform === 'web') {
      if (typeof webCrypto?.getRandomValues !== 'function') {
        throw new Error('Secure random number generation is unavailable in this browser.');
      }
      bytes = webCrypto.getRandomValues(new Uint8Array(16));
    } else {
      if (typeof crypto?.getRandomBytesAsync !== 'function') {
        throw new Error('Secure random number generation is unavailable on this device.');
      }
      bytes = await crypto.getRandomBytesAsync(16);
    }
    return bytesToHex(bytes);
  }

  async function hashCredential(salt, credential) {
    if (platform === 'web') {
      if (typeof webCrypto?.subtle?.importKey !== 'function') {
        throw new Error('Secure credential hashing is unavailable in this browser.');
      }
      const key = await webCrypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(credential),
        'PBKDF2',
        false,
        ['deriveBits']
      );
      const digest = await webCrypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          hash: 'SHA-256',
          salt: Uint8Array.from(salt.match(/.{2}/g), (byte) => Number.parseInt(byte, 16)),
          iterations: WEB_PBKDF2_ITERATIONS,
        },
        key,
        256
      );
      return bytesToHex(new Uint8Array(digest));
    }
    if (typeof crypto?.digestStringAsync !== 'function') {
      throw new Error('Secure credential hashing is unavailable on this device.');
    }
    return crypto.digestStringAsync(
      crypto.CryptoDigestAlgorithm.SHA256,
      `${salt}:${credential}`
    );
  }

  async function saveRecord(record) {
    await writeRaw(JSON.stringify(record));
    return publicSettings(record);
  }

  async function verifyCredential(credential) {
    const record = await readRecord();
    if (!record?.credentialType) {
      throw new Error('A password or pattern has not been set.');
    }
    const currentTime = now();
    if (record.lockedUntil > currentTime) {
      return { success: false, retryAfterMs: record.lockedUntil - currentTime };
    }

    const candidateHash = await hashCredential(record.salt, credential);
    if (constantTimeEqual(record.credentialHash, candidateHash)) {
      record.failedAttempts = 0;
      record.lockedUntil = 0;
      await saveRecord(record);
      return { success: true, retryAfterMs: 0 };
    }

    record.failedAttempts += 1;
    if (record.failedAttempts >= LOCKOUT_THRESHOLD) {
      const lockoutMultiplier = 2 ** Math.min(record.failedAttempts - LOCKOUT_THRESHOLD, 4);
      record.lockedUntil = currentTime + Math.min(
        FIRST_LOCKOUT_MS * lockoutMultiplier,
        MAX_LOCKOUT_MS
      );
    }
    await saveRecord(record);
    return {
      success: false,
      retryAfterMs: Math.max(0, record.lockedUntil - currentTime),
    };
  }

  return {
    async load() {
      return publicSettings(await readRecord());
    },
    async setCredential(type, credential) {
      if (!CREDENTIAL_TYPES.has(type)) {
        throw new Error('Choose a password or pattern.');
      }
      if (!isValidCredential(type, credential)) {
        throw new Error(
          type === 'password'
            ? `Use a password with ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`
            : `Choose a pattern using at least ${MIN_PATTERN_LENGTH} different dots.`
        );
      }
      const current = await readRecord();
      const salt = await makeSalt();
      return saveRecord({
        version: 3,
        credentialType: type,
        salt,
        credentialHash: await hashCredential(salt, credential),
        biometricEnabled: current?.biometricEnabled === true,
        failedAttempts: 0,
        lockedUntil: 0,
      });
    },
    verifyCredential,
    async setBiometricEnabled(enabled) {
      if (enabled && platform === 'web') {
        throw new Error('Biometric app lock is available in the Android and iOS apps only.');
      }
      const current = await readRecord();
      const record = current || {
        version: 3,
        credentialType: null,
        salt: null,
        credentialHash: null,
        biometricEnabled: false,
        failedAttempts: 0,
        lockedUntil: 0,
      };
      record.biometricEnabled = enabled === true;
      if (!record.biometricEnabled && !record.credentialType) {
        await deleteRaw();
        return publicSettings(null);
      }
      return saveRecord(record);
    },
    async removeCredential() {
      const current = await readRecord();
      if (!current) return publicSettings(null);
      current.credentialType = null;
      current.salt = null;
      current.credentialHash = null;
      current.failedAttempts = 0;
      current.lockedUntil = 0;
      if (!current.biometricEnabled) {
        await deleteRaw();
        return publicSettings(null);
      }
      return saveRecord(current);
    },
    async disable() {
      await deleteRaw();
      return publicSettings(null);
    },
  };
}
