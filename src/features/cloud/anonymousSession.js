
/**
 * Ensures PocketFiles has a Supabase user session.
 *
 * Existing sessions are reused. A new anonymous session is created
 * only when no current session exists.
 */
export async function ensureAnonymousSession(supabase) {
  if (!supabase?.auth) {
    throw new Error('Supabase authentication is not configured.');
  }

  const {
    data: sessionData,
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError) {
    throw sessionError;
  }

  if (sessionData?.session?.user) {
    return {
      user: sessionData.session.user,
      created: false,
    };
  }

  const {
    data,
    error,
  } = await supabase.auth.signInAnonymously();

  if (error) {
    throw error;
  }

  if (!data?.user || !data?.session) {
    throw new Error(
      'Supabase did not return an anonymous user session.'
    );
  }

  return {
    user: data.user,
    created: true,
  };
}
