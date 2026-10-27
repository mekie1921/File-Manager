import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebSecureStore,
  getMediaLibraryModule,
  getSecureStoreModule,
  getLocalAuthenticationModule,
} from './nativeModules.js';

test('web secure storage falls back to browser storage and does not require native access', async () => {
  const storage = new Map();
  const secureStore = createWebSecureStore({
    getItem(key) { return storage.get(key) ?? null; },
    setItem(key, value) { storage.set(key, value); },
    removeItem(key) { storage.delete(key); },
  });

  await secureStore.setItemAsync('demo', 'value');
  assert.equal(await secureStore.getItemAsync('demo'), 'value');
  await secureStore.deleteItemAsync('demo');
  assert.equal(await secureStore.getItemAsync('demo'), null);
});

test('web does not load native modules', () => {
  const nativeLoader = () => {
    throw new Error('native module should not be loaded on web');
  };
  assert.equal(getMediaLibraryModule('web'), null);
  assert.equal(getLocalAuthenticationModule('web'), null);
  const webSecure = getSecureStoreModule('web', {
    getItem() { return 'demo'; },
    setItem() {},
    removeItem() {},
  }, nativeLoader);
  assert.ok(webSecure);
  assert.equal(typeof webSecure.getItemAsync, 'function');
});

test('Android media-library loading returns the Expo native module for discovery', () => {
  const query = class Query {};
  const asset = class Asset {};
  const androidMediaLibrary = {
    AssetField: { MEDIA_TYPE: 'mediaType', CREATION_TIME: 'creationTime' },
    MediaType: { IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio' },
    Query: query,
    Asset: asset,
  };
  let loads = 0;

  const mediaLibrary = getMediaLibraryModule('android', () => {
    loads += 1;
    return androidMediaLibrary;
  });

  assert.equal(loads, 1);
  assert.equal(mediaLibrary, androidMediaLibrary);
  assert.equal(mediaLibrary.Query, query);
  assert.equal(mediaLibrary.Asset, asset);
});

test('native module loading errors are surfaced instead of silently falling back', () => {
  const loadFailure = new Error('native module is missing');
  assert.throws(
    () => getMediaLibraryModule('android', () => { throw loadFailure; }),
    (error) => error === loadFailure
  );
  assert.throws(
    () => getSecureStoreModule('android', undefined, () => { throw loadFailure; }),
    (error) => error === loadFailure
  );
});

test('browser secure storage fails explicitly when browser storage is unavailable', () => {
  assert.throws(() => createWebSecureStore(null), /Browser storage is unavailable/);
});
