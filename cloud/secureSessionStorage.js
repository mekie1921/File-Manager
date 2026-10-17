const STORAGE_KEY_PREFIX = 'pocketfiles.supabase.session.';

function wrapStorageError(operation, cause) {
  const error = new Error(`SecureStore failed to ${operation} the Supabase session.`);
  error.cause = cause;
  return error;
}

export function createSecureSessionStorage(secureStore) {
  if (
    typeof secureStore?.getItemAsync !== 'function' ||
    typeof secureStore?.setItemAsync !== 'function' ||
    typeof secureStore?.deleteItemAsync !== 'function'
  ) {
    throw new Error('SecureStore does not provide the required asynchronous storage methods.');
  }

  return {
    async getItem(key) {
      try {
        return await secureStore.getItemAsync(`${STORAGE_KEY_PREFIX}${key}`);
      } catch (error) {
        throw wrapStorageError('read', error);
      }
    },
    async setItem(key, value) {
      try {
        await secureStore.setItemAsync(`${STORAGE_KEY_PREFIX}${key}`, value);
      } catch (error) {
        throw wrapStorageError('write', error);
      }
    },
    async removeItem(key) {
      try {
        await secureStore.deleteItemAsync(`${STORAGE_KEY_PREFIX}${key}`);
      } catch (error) {
        throw wrapStorageError('delete', error);
      }
    },
  };
}
