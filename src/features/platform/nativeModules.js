import { createWebSecureStore } from './webSecureStore.js';

export { createWebSecureStore };

export function getSecureStoreModule(
  platform = 'native',
  storageOverride,
  loadNativeModule = () => require('expo-secure-store')
) {
  if (platform === 'web') {
    return createWebSecureStore(storageOverride);
  }
  return loadNativeModule();
}

export function getMediaLibraryModule(
  platform = 'native',
  loadNativeModule = () => require('expo-media-library')
) {
  if (platform === 'web') {
    return null;
  }
  return loadNativeModule();
}

export function getLocalAuthenticationModule(
  platform = 'native',
  loadNativeModule = () => require('expo-local-authentication')
) {
  if (platform === 'web') {
    return null;
  }
  return loadNativeModule();
}

export function isReactNativeWeb() {
  return typeof navigator !== 'undefined' && navigator.product !== 'ReactNative';
}
