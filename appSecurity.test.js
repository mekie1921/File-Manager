import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import {
  APP_SECURITY_STORAGE_KEY,
  createAppSecurity,
  isValidCredential,
  isValidPassword,
  isValidPattern,
} from './appSecurity.js';

function createTestSecurity(platform = 'android') {
  const values = new Map();
  let time = 1_000;
  let saltSequence = 0;
  const secureStore = {
    async getItemAsync(key) {
      return values.get(key) ?? null;
    },
    async setItemAsync(key, value) {
      values.set(key, value);
    },
    async deleteItemAsync(key) {
      values.delete(key);
    },
  };
  const webStorage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
  const crypto = {
    CryptoDigestAlgorithm: { SHA256: 'sha256' },
    async getRandomBytesAsync(byteCount) {
      saltSequence += 1;
      return Uint8Array.from({ length: byteCount }, (_, index) => (index + saltSequence) % 256);
    },
    async digestStringAsync(algorithm, value) {
      assert.equal(algorithm, 'sha256');
      let hash = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
      }
      return (hash >>> 0).toString(16).padStart(8, '0').repeat(8);
    },
  };
  return {
    values,
    security: createAppSecurity({
      platform,
      secureStore,
      crypto,
      webStorage,
      webCrypto: webcrypto,
      now: () => time,
    }),
    advanceTime(milliseconds) {
      time += milliseconds;
    },
  };
}

function legacyPasscodeRecord(biometricEnabled = false) {
  return JSON.stringify({
    version: 1,
    credentialType: 'passcode',
    salt: 'a'.repeat(32),
    passcodeHash: 'b'.repeat(64),
    biometricEnabled,
    failedAttempts: 3,
    lockedUntil: 0,
  });
}

test('validates passwords and unique 4–9-dot patterns', () => {
  assert.equal(isValidPassword('short'), false);
  assert.equal(isValidPassword('        '), false);
  assert.equal(isValidPassword('long-enough-password'), true);
  assert.equal(isValidPassword(`12345678${'\n'}`), false);
  assert.equal(isValidPassword('a'.repeat(65)), false);
  assert.equal(isValidPattern('123'), false);
  assert.equal(isValidPattern('11234'), false);
  assert.equal(isValidPattern('1234567890'), false);
  assert.equal(isValidPattern('1234'), true);
  assert.equal(isValidPattern('14789'), true);
  assert.equal(isValidCredential('password', 'long-enough-password'), true);
  assert.equal(isValidCredential('pattern', '14789'), true);
  assert.equal(isValidCredential('passcode', '123456'), false);
});

test('starts disabled and securely stores password and pattern credentials', async () => {
  const { security, values } = createTestSecurity();
  assert.deepEqual(await security.load(), {
    enabled: false,
    biometricEnabled: false,
    credentialType: null,
  });

  for (const [type, credential] of [
    ['password', 'a-long-private-password'],
    ['pattern', '14789'],
  ]) {
    assert.deepEqual(await security.setCredential(type, credential), {
      enabled: true,
      biometricEnabled: false,
      credentialType: type,
    });
    const stored = values.get(APP_SECURITY_STORAGE_KEY);
    assert.equal(stored.includes(credential), false);
    assert.equal(JSON.parse(stored).credentialType, type);
    assert.equal((await security.verifyCredential('wrong-credential')).success, false);
    assert.equal((await security.verifyCredential(credential)).success, true);
  }
});

test('adds, preserves, and independently removes biometric unlock', async () => {
  const { security } = createTestSecurity();
  await security.setCredential('password', 'a-long-private-password');

  assert.deepEqual(await security.setBiometricEnabled(true), {
    enabled: true,
    biometricEnabled: true,
    credentialType: 'password',
  });
  assert.deepEqual(await security.setCredential('pattern', '14789'), {
    enabled: true,
    biometricEnabled: true,
    credentialType: 'pattern',
  });
  assert.deepEqual(await security.setBiometricEnabled(false), {
    enabled: true,
    biometricEnabled: false,
    credentialType: 'pattern',
  });
});

test('removes a credential while retaining biometric-only app lock', async () => {
  const { security } = createTestSecurity();
  await security.setCredential('password', 'a-long-private-password');
  await security.setBiometricEnabled(true);

  assert.deepEqual(await security.removeCredential(), {
    enabled: true,
    biometricEnabled: true,
    credentialType: null,
  });
  assert.deepEqual(await security.load(), {
    enabled: true,
    biometricEnabled: true,
    credentialType: null,
  });
});

test('turning off the last lock method clears its saved configuration', async () => {
  const { security, values } = createTestSecurity();
  await security.setCredential('pattern', '14789');
  await security.setBiometricEnabled(true);
  await security.removeCredential();

  assert.deepEqual(await security.setBiometricEnabled(false), {
    enabled: false,
    biometricEnabled: false,
    credentialType: null,
  });
  assert.equal(values.has(APP_SECURITY_STORAGE_KEY), false);
});

test('disabling app lock removes all saved settings', async () => {
  const { security, values } = createTestSecurity();
  await security.setCredential('password', 'a-long-private-password');
  await security.setBiometricEnabled(true);
  assert.deepEqual(await security.disable(), {
    enabled: false,
    biometricEnabled: false,
    credentialType: null,
  });
  assert.equal(values.has(APP_SECURITY_STORAGE_KEY), false);
});

test('migrates previous biometric settings and removes old app passcode verifiers', async () => {
  const { security, values } = createTestSecurity();
  values.set(APP_SECURITY_STORAGE_KEY, legacyPasscodeRecord(true));

  assert.deepEqual(await security.load(), {
    enabled: true,
    biometricEnabled: true,
    credentialType: null,
  });
  const migrated = values.get(APP_SECURITY_STORAGE_KEY);
  assert.equal(JSON.parse(migrated).version, 3);
  assert.equal(migrated.includes('passcodeHash'), false);
});

test('does not leave users locked after migrating an app-passcode-only setting', async () => {
  const { security, values } = createTestSecurity();
  values.set(APP_SECURITY_STORAGE_KEY, legacyPasscodeRecord());

  assert.deepEqual(await security.load(), {
    enabled: false,
    biometricEnabled: false,
    credentialType: null,
  });
  assert.equal(JSON.parse(values.get(APP_SECURITY_STORAGE_KEY)).credentialType, null);
});

test('migrates the previous biometric-only settings format', async () => {
  const { security, values } = createTestSecurity();
  values.set(APP_SECURITY_STORAGE_KEY, '{"version":2,"enabled":true}');

  assert.deepEqual(await security.load(), {
    enabled: true,
    biometricEnabled: true,
    credentialType: null,
  });
});

test('uses PBKDF2 in browser storage and keeps biometrics unavailable on web', async () => {
  const { security, values } = createTestSecurity('web');
  await security.setCredential('password', 'a-long-private-password');
  const stored = values.get(APP_SECURITY_STORAGE_KEY);
  assert.equal(stored.includes('a-long-private-password'), false);
  assert.equal((await security.verifyCredential('wrong-password')).success, false);
  assert.equal((await security.verifyCredential('a-long-private-password')).success, true);
  await assert.rejects(security.setBiometricEnabled(true), /Android and iOS apps only/);
});

test('locks credential verification after repeated failures and resets after success', async () => {
  const { security, advanceTime } = createTestSecurity();
  await security.setCredential('password', 'a-long-private-password');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.deepEqual(await security.verifyCredential('wrong-password'), {
      success: false,
      retryAfterMs: 0,
    });
  }
  assert.deepEqual(await security.verifyCredential('wrong-password'), {
    success: false,
    retryAfterMs: 30_000,
  });
  assert.deepEqual(await security.verifyCredential('a-long-private-password'), {
    success: false,
    retryAfterMs: 30_000,
  });
  advanceTime(30_000);
  assert.deepEqual(await security.verifyCredential('a-long-private-password'), {
    success: true,
    retryAfterMs: 0,
  });
});

test('fails closed when stored security settings are malformed', async () => {
  const { security, values } = createTestSecurity();
  values.set(APP_SECURITY_STORAGE_KEY, '');
  await assert.rejects(security.load(), /settings are invalid/);
  values.set(APP_SECURITY_STORAGE_KEY, '{');
  await assert.rejects(security.load(), /settings are corrupted/);
  values.set(APP_SECURITY_STORAGE_KEY, '{"version":3,"enabled":"yes"}');
  await assert.rejects(security.load(), /settings are invalid/);
});

test('does not enable an unsupported credential type', async () => {
  const { security } = createTestSecurity();
  await assert.rejects(
    security.setCredential('passcode', '123456'),
    /Choose a password or pattern/
  );
});
