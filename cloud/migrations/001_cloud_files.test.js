import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(
  new URL('./001_cloud_files.sql', import.meta.url),
  'utf8'
);
const normalizedMigration = migration.replace(/\s+/g, ' ').toLowerCase();

function policySql(policyName) {
  const policy = migration.match(
    new RegExp(`create policy ${policyName}\\b[\\s\\S]*?;`, 'i')
  );
  assert.ok(policy, `missing policy: ${policyName}`);
  return policy[0].replace(/\s+/g, ' ').toLowerCase();
}

test('defines file metadata without storing file contents', () => {
  assert.match(migration, /create table if not exists public\.cloud_files/i);
  assert.match(migration, /id uuid primary key/i);
  assert.match(migration, /owner_id uuid not null references auth\.users\s*\(id\)/i);
  for (const column of [
    'filename text not null',
    'mime_type text not null',
    'file_size bigint not null',
    'storage_path text not null',
    'checksum text',
    'created_at timestamptz not null',
    'updated_at timestamptz not null',
    'deleted_at timestamptz',
  ]) {
    assert.ok(migration.toLowerCase().includes(column), `missing column: ${column}`);
  }
  assert.doesNotMatch(migration, /\bbytea\b|\bfile_contents\b/i);
});

test('enforces owner path prefixes in metadata constraints and insert/update checks', () => {
  assert.ok(normalizedMigration.includes("left(storage_path, 37) = (owner_id::text || '/')"));
  assert.match(
    migration,
    /left\(storage_path,\s*37\)\s*=\s*\(\(select auth\.uid\(\)\)::text\s*\|\|\s*'\/'\)/i
  );
  assert.match(migration, /owner_id\s*=\s*\(select auth\.uid\(\)\)/i);
});

test('creates both permissive operations and restrictive owner guards for metadata', () => {
  for (const operation of ['select', 'insert', 'update', 'delete']) {
    assert.ok(
      normalizedMigration.includes(
        `create policy cloud_files_${operation}_owner on public.cloud_files as permissive for ${operation} to authenticated`
      )
    );
    assert.ok(
      normalizedMigration.includes(
        `create policy cloud_files_${operation}_owner_guard on public.cloud_files as restrictive for ${operation} to authenticated`
      )
    );
  }
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on table public\.cloud_files from public, anon/i);
});

test('keeps the bucket private and fails instead of changing a conflicting bucket', () => {
  assert.match(
    migration,
    /insert into storage\.buckets\s*\(id,\s*name,\s*public\)\s*values\s*\('pocketfiles',\s*'pocketfiles',\s*false\)\s*on conflict \(id\) do nothing/i
  );
  assert.match(
    migration,
    /raise exception 'The existing pocketfiles Storage bucket is not private or has an incompatible configuration\.'/i
  );
});

test('keeps permissive Storage policies owner-scoped to PocketFiles', () => {
  for (const operation of ['select', 'insert', 'update', 'delete']) {
    const policy = policySql(`pocketfiles_objects_${operation}_owner`);
    assert.ok(
      policy.includes(
        `create policy pocketfiles_objects_${operation}_owner on storage.objects as permissive for ${operation} to authenticated`
      ),
      `${operation} owner policy must remain permissive and authenticated`
    );
    assert.ok(policy.includes("bucket_id = 'pocketfiles'"));
    assert.ok(
      policy.includes(
        '(storage.foldername(name))[1] = (select auth.uid())::text'
      ),
      `${operation} owner policy must check the first folder segment`
    );
  }
});

test('restrictive Storage guards permit other buckets and authenticate PocketFiles owners', () => {
  const ownerGuard = "bucket_id <> 'pocketfiles' or ( (select auth.uid()) is not null and (storage.foldername(name))[1] = (select auth.uid())::text )";

  for (const operation of ['select', 'insert', 'update', 'delete']) {
    const policy = policySql(`pocketfiles_objects_${operation}_owner_guard`);
    assert.ok(
      policy.includes(
        `create policy pocketfiles_objects_${operation}_owner_guard on storage.objects as restrictive for ${operation} to public`
      ),
      `${operation} guard must remain restrictive and cover all roles`
    );

    const expressions =
      operation === 'insert'
        ? ['with check']
        : operation === 'update'
          ? ['using', 'with check']
          : ['using'];
    for (const expression of expressions) {
      assert.ok(
        policy.includes(`${expression} ( ${ownerGuard} )`),
        `${operation} guard ${expression} must allow other buckets and require the PocketFiles owner`
      );
    }
  }
});

test('drops the DELETE owner policy before recreating it', () => {
  const dropIndex = normalizedMigration.indexOf(
    'drop policy if exists pocketfiles_objects_delete_owner on storage.objects'
  );
  const createIndex = normalizedMigration.indexOf(
    'create policy pocketfiles_objects_delete_owner on storage.objects'
  );
  assert.notEqual(dropIndex, -1, 'DELETE owner policy drop must exist');
  assert.notEqual(createIndex, -1, 'DELETE owner policy creation must exist');
  assert.ok(dropIndex < createIndex, 'DELETE owner policy must be dropped first');
});

test('uses a fixed search path and an idempotently recreated updated-at trigger', () => {
  assert.match(migration, /create or replace function public\.set_cloud_files_updated_at\(\)/i);
  assert.match(migration, /set search_path = ''/i);
  assert.match(migration, /new\.updated_at\s*:=\s*pg_catalog\.now\(\)/i);
  assert.match(migration, /drop trigger if exists cloud_files_set_updated_at/i);
  assert.match(migration, /create trigger cloud_files_set_updated_at/i);
});
