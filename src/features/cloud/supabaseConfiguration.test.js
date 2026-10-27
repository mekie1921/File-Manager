import assert from 'node:assert/strict';
import test from 'node:test';
import {
  initializeConfiguredSupabase,
  resolveSupabaseConfiguration,
} from './supabaseConfiguration.js';

function makeLegacyKey(role) {
  const payload = btoa(JSON.stringify({ role }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${payload}.signature`;
}

test('returns an unavailable configuration when public values are missing', () => {
  const result = resolveSupabaseConfiguration({});
  assert.equal(result.configuration, null);
  assert.match(result.error, /valid project URL/);
});

test('accepts a secure project URL and publishable key', () => {
  const result = resolveSupabaseConfiguration({
    url: 'https://project-id.supabase.co/',
    publishableKey: 'sb_publishable_test-placeholder',
  });
  assert.deepEqual(result, {
    configuration: {
      url: 'https://project-id.supabase.co',
      key: 'sb_publishable_test-placeholder',
    },
    error: null,
  });
});

test('accepts a legacy anon JWT but rejects service-role and secret keys', () => {
  assert.equal(
    resolveSupabaseConfiguration({
      url: 'https://project-id.supabase.co',
      anonKey: makeLegacyKey('anon'),
    }).configuration?.key,
    makeLegacyKey('anon')
  );
  for (const key of [makeLegacyKey('service_role'), 'sb_secret_never-accepted', 'sb_service_role_never-accepted']) {
    const result = resolveSupabaseConfiguration({
      url: 'https://project-id.supabase.co',
      publishableKey: key,
    });
    assert.equal(result.configuration, null);
    assert.match(result.error, /Secret keys are not accepted/);
  }
});

test('decodes legacy anon JWT keys when atob is unavailable', () => {
  const originalAtob = globalThis.atob;
  try {
    globalThis.atob = undefined;
    const result = resolveSupabaseConfiguration({
      url: 'https://project-id.supabase.co',
      anonKey: makeLegacyKey('anon'),
    });
    assert.equal(result.configuration?.key, makeLegacyKey('anon'));
  } finally {
    globalThis.atob = originalAtob;
  }
});

test('rejects malformed URLs and insecure non-local endpoints', () => {
  for (const url of ['not-a-url', 'http://example.supabase.co', 'https://user:pass@example.com']) {
    const result = resolveSupabaseConfiguration({
      url,
      publishableKey: 'sb_publishable_test-placeholder',
    });
    assert.equal(result.configuration, null);
  }
});

test('allows local HTTP Supabase development endpoints', () => {
  const result = resolveSupabaseConfiguration({
    url: 'http://10.0.2.2:54321',
    publishableKey: 'sb_publishable_test-placeholder',
  });
  assert.equal(result.configuration?.url, 'http://10.0.2.2:54321');
});

test('does not initialize a Supabase client without valid configuration', () => {
  let clientCreated = false;
  const result = initializeConfiguredSupabase(
    resolveSupabaseConfiguration({}),
    () => {
      clientCreated = true;
    },
    {}
  );
  assert.equal(result.client, null);
  assert.equal(clientCreated, false);
});

test('configures secure session persistence when initializing the client', () => {
  const configuration = resolveSupabaseConfiguration({
    url: 'https://project-id.supabase.co',
    publishableKey: 'sb_publishable_test-placeholder',
  });
  const storage = { getItem() {}, setItem() {}, removeItem() {} };
  let clientArgs;
  const client = {};
  const result = initializeConfiguredSupabase(configuration, (...args) => {
    clientArgs = args;
    return client;
  }, storage);

  assert.equal(result.client, client);
  assert.equal(result.error, null);
  assert.equal(clientArgs[2].auth.persistSession, true);
  assert.equal(clientArgs[2].auth.detectSessionInUrl, false);
  assert.equal(clientArgs[2].auth.storage, storage);
});

test('rejects an invalid client factory before creating a Supabase client', () => {
  const configuration = resolveSupabaseConfiguration({
    url: 'https://project-id.supabase.co',
    publishableKey: 'sb_publishable_test-placeholder',
  });

  const result = initializeConfiguredSupabase(configuration, null, {});

  assert.equal(result.client, null);
  assert.match(result.error, /client factory is unavailable/i);
});
