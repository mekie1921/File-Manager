function decodeBase64(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let accumulator = 0;
  let bits = 0;
  let output = '';

  for (const character of value) {
    if (character === '=') break;
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error('Invalid base64 payload.');
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((accumulator >> bits) & 0xff);
      accumulator &= (1 << bits) - 1;
    }
  }
  return output;
}

function decodeJwtPayload(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const binary =
    typeof atob === 'function'
      ? atob(`${base64}${padding}`)
      : decodeBase64(`${base64}${padding}`);

  return decodeURIComponent(
    Array.from(binary, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')
  );
}

function legacyJwtRole(key) {
  const parts = key.split('.');
  if (parts.length !== 3) return null;

  try {
    const payload = JSON.parse(decodeJwtPayload(parts[1]));
    return typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

function parseProjectUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;

  try {
    const url = new URL(value.trim());
    const isLocalDevelopment =
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '10.0.2.2', '[::1]', '::1'].includes(url.hostname);

    if (
      (url.protocol !== 'https:' && !isLocalDevelopment) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }

    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function parsePublicKey(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();

  if (!key || key.startsWith('sb_secret_') || key.startsWith('sb_service_role_')) return null;
  if (key.startsWith('sb_publishable_')) return key;
  if (legacyJwtRole(key) === 'anon') return key;

  return null;
}

export function resolveSupabaseConfiguration({ url, publishableKey, anonKey }) {
  const projectUrl = parseProjectUrl(url);

  if (!projectUrl) {
    return {
      configuration: null,
      error: 'Supabase is not configured with a valid project URL.',
    };
  }

  const publicKey = parsePublicKey(publishableKey || anonKey);

  if (!publicKey) {
    return {
      configuration: null,
      error: 'Supabase requires a publishable key or a legacy anon key. Secret keys are not accepted.',
    };
  }

  return {
    configuration: { url: projectUrl, key: publicKey },
    error: null,
  };
}

export function initializeConfiguredSupabase({ configuration, error }, createClient, storage) {
  if (!configuration) return { client: null, error };
  if (typeof createClient !== 'function') {
    return {
      client: null,
      error: 'Supabase client factory is unavailable.',
    };
  }

  return {
    client: createClient(configuration.url, configuration.key, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
        storage,
      },
    }),
    error: null,
  };
}
