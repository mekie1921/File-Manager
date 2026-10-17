
import 'react-native-url-polyfill/auto.js';
import { createClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { createSecureSessionStorage } from './secureSessionStorage.js';
import {
  initializeConfiguredSupabase,
  resolveSupabaseConfiguration,
} from './supabaseConfiguration.js';

const configuration = resolveSupabaseConfiguration({
  url: process.env.EXPO_PUBLIC_SUPABASE_URL,
  publishableKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  anonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
});

const sessionStorage = createSecureSessionStorage(SecureStore);

const initialized = initializeConfiguredSupabase(
  configuration,
  createClient,
  sessionStorage
);

export const supabase = initialized.client;
export const supabaseConfigurationError = initialized.error;
