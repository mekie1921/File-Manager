
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ensureAnonymousSession,
} from './anonymousSession.js';

function createMockSupabase({
  session = null,
  signInResult = null,
  sessionError = null,
  signInError = null,
} = {}) {
  let signInCalls = 0;

  const supabase = {
    auth: {
      async getSession() {
        return {
          data: { session },
          error: sessionError,
        };
      },

      async signInAnonymously() {
        signInCalls++;

        return signInResult ?? {
          data: {
            user: { id: 'test-user' },
            session: { access_token: 'test-token' },
          },
          error: signInError,
        };
      },
    },
  };

  return {
    supabase,
    getSignInCalls: () => signInCalls,
  };
}

test('reuses an existing session without signing in again', async () => {
  const existingUser = { id: 'existing-user' };
  const mock = createMockSupabase({
    session: { user: existingUser },
  });

  const result = await ensureAnonymousSession(mock.supabase);

  assert.equal(result.user, existingUser);
  assert.equal(result.created, false);
  assert.equal(mock.getSignInCalls(), 0);
});

test('creates an anonymous session when no session exists', async () => {
  const mock = createMockSupabase();

  const result = await ensureAnonymousSession(mock.supabase);

  assert.equal(result.user.id, 'test-user');
  assert.equal(result.created, true);
  assert.equal(mock.getSignInCalls(), 1);
});

test('reports session lookup errors', async () => {
  const expectedError = new Error('Session lookup failed');
  const mock = createMockSupabase({
    sessionError: expectedError,
  });

  await assert.rejects(
    ensureAnonymousSession(mock.supabase),
    /Session lookup failed/
  );

  assert.equal(mock.getSignInCalls(), 0);
});

test('reports anonymous sign-in errors', async () => {
  const mock = createMockSupabase({
    signInResult: {
      data: { user: null, session: null },
      error: new Error('Anonymous sign-in failed'),
    },
  });

  await assert.rejects(
    ensureAnonymousSession(mock.supabase),
    /Anonymous sign-in failed/
  );
});

test('rejects a missing Supabase client', async () => {
  await assert.rejects(
    ensureAnonymousSession(null),
    /Supabase authentication is not configured/
  );
});

test('rejects a sign-in response without a session', async () => {
  const mock = createMockSupabase({
    signInResult: {
      data: { user: { id: 'test-user' }, session: null },
      error: null,
    },
  });

  await assert.rejects(
    ensureAnonymousSession(mock.supabase),
    /did not return an anonymous user session/
  );
});
