import 'react-native-url-polyfill/auto.js';
import { createClient } from '@supabase/supabase-js';
import { createWebSecureStore } from '../platform/webSecureStore.js';
import { createSecureSessionStorage } from './secureSessionStorage.js';
import {
  initializeConfiguredSupabase,
  resolveSupabaseConfiguration,
} from './supabaseConfiguration.js';

const browserStorage = {
  getItem(key) {
    if (!globalThis.localStorage) throw new Error('Browser storage is unavailable.');
    return globalThis.localStorage.getItem(key);
  },
  setItem(key, value) {
    if (!globalThis.localStorage) throw new Error('Browser storage is unavailable.');
    globalThis.localStorage.setItem(key, value);
  },
  removeItem(key) {
    if (!globalThis.localStorage) throw new Error('Browser storage is unavailable.');
    globalThis.localStorage.removeItem(key);
  },
};

const secureStore = createWebSecureStore(browserStorage);
const configuration = resolveSupabaseConfiguration({
  url: process.env.EXPO_PUBLIC_SUPABASE_URL,
  publishableKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  anonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
});

const initialized =
  typeof window === 'undefined'
    ? { client: null, error: configuration.error }
    : initializeConfiguredSupabase(
        configuration,
        createClient,
        createSecureSessionStorage(secureStore)
      );

export const supabase = initialized.client;
export const supabaseConfigurationError = initialized.error;
