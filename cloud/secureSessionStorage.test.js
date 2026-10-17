import assert from 'node:assert/strict';
import test from 'node:test';
import { createSecureSessionStorage } from './secureSessionStorage.js';

function createMockSecureStore() {
  const values = new Map();
  return {
    values,
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
}

test('persists, reads, and removes session values using the SecureStore namespace', async () => {
  const secureStore = createMockSecureStore();
  const storage = createSecureSessionStorage(secureStore);

  await storage.setItem('auth-token', '{"access_token":"test"}');
  assert.equal(await storage.getItem('auth-token'), '{"access_token":"test"}');
  assert.equal(
    secureStore.values.has('pocketfiles.supabase.session.auth-token'),
    true
  );

  await storage.removeItem('auth-token');
  assert.equal(await storage.getItem('auth-token'), null);
});

test('reports SecureStore read, write, and delete failures without falling back', async () => {
  const secureStore = {
    async getItemAsync() {
      throw new Error('native read failure');
    },
    async setItemAsync() {
      throw new Error('native write failure');
    },
    async deleteItemAsync() {
      throw new Error('native delete failure');
    },
  };
  const storage = createSecureSessionStorage(secureStore);

  await assert.rejects(storage.getItem('auth-token'), (error) => {
    assert.match(error.message, /SecureStore failed to read/);
    assert.match(error.cause.message, /native read failure/);
    return true;
  });
  await assert.rejects(
    storage.setItem('auth-token', 'session-value'),
    (error) => {
      assert.match(error.message, /SecureStore failed to write/);
      assert.match(error.cause.message, /native write failure/);
      return true;
    }
  );
  await assert.rejects(
    storage.removeItem('auth-token'),
    (error) => {
      assert.match(error.message, /SecureStore failed to delete/);
      assert.match(error.cause.message, /native delete failure/);
      return true;
    }
  );
});

test('rejects an invalid SecureStore implementation', () => {
  assert.throws(
    () => createSecureSessionStorage({}),
    /required asynchronous storage methods/
  );
});
