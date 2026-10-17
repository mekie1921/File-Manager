# Supabase client foundation

This step adds only an optional Supabase client and encrypted session storage. It does not add account UI, cloud file transfers, or synchronization.

## Local development configuration

Copy `.env.example` in the project root to `.env`, then set:

- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (preferred), or the legacy `EXPO_PUBLIC_SUPABASE_ANON_KEY`

The example file is a template only; Expo does not read `.env.example`. Expo CLI loads `EXPO_PUBLIC_` variables from `.env` and inlines direct references such as `process.env.EXPO_PUBLIC_SUPABASE_URL` into the JavaScript bundle. Restart/reload Expo after changing values. The root `.env` is ignored by Git.

## EAS Build configuration

Create the same two `EXPO_PUBLIC_` variables in the PocketFiles project's **preview** environment in the Expo dashboard under **Project settings → Environment variables**. They must be plain-text or sensitive EAS variables available to the client bundler; these values are public client configuration and are embedded in the app bundle. Do not mark them as server-only secrets. The existing internal `preview` build profile resolves to the EAS `preview` environment by default. Build with:

```powershell
npx.cmd eas-cli build --profile preview --platform android
```

No `eas.json` profile change is required for this setup.

## Key and session handling

Use only a Supabase publishable key or legacy anon key in the mobile app. These are public by design and are not authorization boundaries; database and Storage policies must enforce user access in later phases. Never put a `service_role` key or `sb_secret_` key in app configuration or source.

Supabase auth session values are stored via `expo-secure-store`, not plaintext files or AsyncStorage. The client is `null` when public configuration is absent or invalid, so the existing local-only app remains usable. SecureStore/native failures are surfaced to Supabase rather than silently switching storage.

SecureStore payload-size limits vary by platform and native implementation; this adapter does not claim that arbitrarily large session values are supported. Its unit tests use mocked storage. Android device behavior and real session sizes still require testing.

The `expo-secure-store` config plugin is enabled with its default Android backup configuration. It excludes SecureStore's encrypted preferences from Auto Backup because the Android Keystore key cannot be restored with those encrypted values. A restored app may therefore require signing in again. The generated `android/` project is not edited manually.

## Cloud file database foundation (not yet applied)

The migration at [`migrations/001_cloud_files.sql`](./migrations/001_cloud_files.sql) defines a `public.cloud_files` metadata table and a private Supabase Storage bucket named `pocketfiles`. It stores file metadata only; file contents are not written to the database.

Every metadata row belongs to an `auth.users` account through `owner_id`. The table policies permit authenticated users to read, insert, update, and delete only rows whose owner is their own `auth.uid()`. Insert and update checks also require `storage_path` to begin with that user's UUID followed by `/`. The column constraint enforces this ownership prefix independently of RLS.

Storage policies are scoped to the `pocketfiles` bucket and compare the first path segment returned by `storage.foldername(name)` with the authenticated user's UUID. Separate restrictive policies provide an additional owner boundary even if other permissive policies exist, and also deny unauthenticated access to this bucket even if an unrelated permissive policy is present. The migration creates the bucket as private; if a bucket with that ID already exists but is not private or has an incompatible name, the migration aborts instead of silently changing its visibility.

This migration is **not applied to a live Supabase project**. To apply it later, open the intended project's Supabase Dashboard, go to **SQL Editor**, create a new query, paste the complete contents of `cloud/migrations/001_cloud_files.sql`, review it, and run it. Apply it first to a disposable/test project and verify the schema, RLS, and Storage behavior using separate authenticated users before using production. The policies have not been tested against a live Supabase instance.
