
begin;

-- ============================================================
-- PocketFiles Phase 4 - Step 2A
-- Cloud file metadata, row-level security, and private storage
-- ============================================================

-- 1. Cloud file metadata table.
-- File contents are stored in Supabase Storage, not this table.

create table if not exists public.cloud_files (
  id uuid primary key default gen_random_uuid(),

  owner_id uuid not null references auth.users (id) on delete cascade,

  filename text not null,
  mime_type text not null default 'application/octet-stream',
  file_size bigint not null,
  storage_path text not null,
  checksum text,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  deleted_at timestamptz,

  constraint cloud_files_filename_nonempty
    check (length(btrim(filename)) > 0),

  constraint cloud_files_filename_is_basename
    check (
      position('/' in filename) = 0
      and position(chr(92) in filename) = 0
    ),

  constraint cloud_files_mime_type_nonempty
    check (length(btrim(mime_type)) > 0),

  constraint cloud_files_file_size_nonnegative
    check (file_size >= 0),

  constraint cloud_files_storage_path_owner_prefix
    check (
      left(storage_path, 37) = (owner_id::text || '/')
      and length(storage_path) > 37
      and position('//' in storage_path) = 0
      and right(storage_path, 1) <> '/'
    ),

  constraint cloud_files_checksum_nonempty
    check (
      checksum is null or length(btrim(checksum)) > 0
    ),

  constraint cloud_files_storage_path_unique
    unique (storage_path)
);

-- 2. Indexes for efficient owner-specific file queries.

create index if not exists cloud_files_owner_id_idx
  on public.cloud_files (owner_id);

create index if not exists cloud_files_owner_active_updated_idx
  on public.cloud_files (owner_id, updated_at desc)
  where deleted_at is null;

create index if not exists cloud_files_owner_deleted_idx
  on public.cloud_files (owner_id, deleted_at desc)
  where deleted_at is not null;

-- 3. Table privileges and row-level security.

revoke all on table public.cloud_files from public, anon;

grant select, insert, update, delete
  on table public.cloud_files to authenticated;

alter table public.cloud_files enable row level security;

-- SELECT policies.

drop policy if exists cloud_files_select_owner
  on public.cloud_files;

drop policy if exists cloud_files_select_owner_guard
  on public.cloud_files;

create policy cloud_files_select_owner
  on public.cloud_files as permissive
  for select to authenticated
  using (owner_id = (select auth.uid()));

create policy cloud_files_select_owner_guard
  on public.cloud_files as restrictive
  for select to authenticated
  using (owner_id = (select auth.uid()));

-- INSERT policies.

drop policy if exists cloud_files_insert_owner
  on public.cloud_files;

drop policy if exists cloud_files_insert_owner_guard
  on public.cloud_files;

create policy cloud_files_insert_owner
  on public.cloud_files as permissive
  for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and left(storage_path, 37) =
        ((select auth.uid())::text || '/')
  );

create policy cloud_files_insert_owner_guard
  on public.cloud_files as restrictive
  for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and left(storage_path, 37) =
        ((select auth.uid())::text || '/')
  );

-- UPDATE policies.

drop policy if exists cloud_files_update_owner
  on public.cloud_files;

drop policy if exists cloud_files_update_owner_guard
  on public.cloud_files;

create policy cloud_files_update_owner
  on public.cloud_files as permissive
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and left(storage_path, 37) =
        ((select auth.uid())::text || '/')
  );

create policy cloud_files_update_owner_guard
  on public.cloud_files as restrictive
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and left(storage_path, 37) =
        ((select auth.uid())::text || '/')
  );

-- DELETE policies.

drop policy if exists cloud_files_delete_owner
  on public.cloud_files;

drop policy if exists cloud_files_delete_owner_guard
  on public.cloud_files;

create policy cloud_files_delete_owner
  on public.cloud_files as permissive
  for delete to authenticated
  using (owner_id = (select auth.uid()));

create policy cloud_files_delete_owner_guard
  on public.cloud_files as restrictive
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- 4. Automatically update updated_at when a row changes.

create or replace function public.set_cloud_files_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$function$;

drop trigger if exists cloud_files_set_updated_at
  on public.cloud_files;

create trigger cloud_files_set_updated_at
  before update on public.cloud_files
  for each row
  execute function public.set_cloud_files_updated_at();

-- 5. Create the private PocketFiles Storage bucket.
-- Do not silently change an existing bucket's configuration.

insert into storage.buckets (id, name, public)
values ('pocketfiles', 'pocketfiles', false)
on conflict (id) do nothing;

do $block$
begin
  if not exists (
    select 1
    from storage.buckets
    where id = 'pocketfiles'
      and name = 'pocketfiles'
      and public = false
  ) then
        raise exception 'The existing pocketfiles Storage bucket is not private or has an incompatible configuration.';
  end if;
end;
$block$;

-- 6. Storage SELECT policies.

drop policy if exists pocketfiles_objects_select_owner
  on storage.objects;

drop policy if exists pocketfiles_objects_select_owner_guard
  on storage.objects;

create policy pocketfiles_objects_select_owner
  on storage.objects as permissive
  for select to authenticated
  using (
    bucket_id = 'pocketfiles'
    and (storage.foldername(name))[1] =
        (select auth.uid())::text
  );

create policy pocketfiles_objects_select_owner_guard
  on storage.objects as restrictive
  for select to public
  using (
    bucket_id <> 'pocketfiles'
    or (
      (select auth.uid()) is not null
      and (storage.foldername(name))[1] =
          (select auth.uid())::text
    )
  );

-- 7. Storage INSERT policies.

drop policy if exists pocketfiles_objects_insert_owner
  on storage.objects;

drop policy if exists pocketfiles_objects_insert_owner_guard
  on storage.objects;

create policy pocketfiles_objects_insert_owner
  on storage.objects as permissive
  for insert to authenticated
  with check (
    bucket_id = 'pocketfiles'
    and (storage.foldername(name))[1] =
        (select auth.uid())::text
  );

create policy pocketfiles_objects_insert_owner_guard
  on storage.objects as restrictive
  for insert to public
  with check (
    bucket_id <> 'pocketfiles'
    or (
      (select auth.uid()) is not null
      and (storage.foldername(name))[1] =
          (select auth.uid())::text
    )
  );

-- 8. Storage UPDATE policies.

drop policy if exists pocketfiles_objects_update_owner
  on storage.objects;

drop policy if exists pocketfiles_objects_update_owner_guard
  on storage.objects;

create policy pocketfiles_objects_update_owner
  on storage.objects as permissive
  for update to authenticated
  using (
    bucket_id = 'pocketfiles'
    and (storage.foldername(name))[1] =
        (select auth.uid())::text
  )
  with check (
    bucket_id = 'pocketfiles'
    and (storage.foldername(name))[1] =
        (select auth.uid())::text
  );

create policy pocketfiles_objects_update_owner_guard
  on storage.objects as restrictive
  for update to public
  using (
    bucket_id <> 'pocketfiles'
    or (
      (select auth.uid()) is not null
      and (storage.foldername(name))[1] =
          (select auth.uid())::text
    )
  )
  with check (
    bucket_id <> 'pocketfiles'
    or (
      (select auth.uid()) is not null
      and (storage.foldername(name))[1] =
          (select auth.uid())::text
    )
  );

-- 9. Storage DELETE policies.

drop policy if exists pocketfiles_objects_delete_owner
  on storage.objects;

drop policy if exists pocketfiles_objects_delete_owner_guard
  on storage.objects;

create policy pocketfiles_objects_delete_owner
  on storage.objects as permissive
  for delete to authenticated
  using (
    bucket_id = 'pocketfiles'
    and (storage.foldername(name))[1] =
        (select auth.uid())::text
  );

create policy pocketfiles_objects_delete_owner_guard
  on storage.objects as restrictive
  for delete to public
  using (
    bucket_id <> 'pocketfiles'
    or (
      (select auth.uid()) is not null
      and (storage.foldername(name))[1] =
          (select auth.uid())::text
    )
  );

commit;
