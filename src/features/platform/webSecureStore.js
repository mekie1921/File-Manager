export function createWebSecureStore(storage = globalThis.localStorage) {
  if (
    !storage ||
    typeof storage.getItem !== 'function' ||
    typeof storage.setItem !== 'function' ||
    typeof storage.removeItem !== 'function'
  ) {
    throw new Error('Browser storage is unavailable.');
  }

  return {
    async getItemAsync(key) {
      return storage.getItem(key);
    },
    async setItemAsync(key, value) {
      storage.setItem(key, value);
    },
    async deleteItemAsync(key) {
      storage.removeItem(key);
    },
  };
}
