const BUCKET_NAME = 'pocketfiles';
const TABLE_NAME = 'cloud_files';
export const MAX_CLOUD_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const FILE_COLUMNS =
  'id,owner_id,filename,mime_type,file_size,storage_path,checksum,created_at,updated_at,deleted_at';

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function requireFileName(name) {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    /[\/\\\u0000-\u001f]/.test(name)
  ) {
    throw new Error('Cloud files must have a valid filename without path separators.');
  }
  return name.trim();
}

function requireOwnedPath(path, ownerId) {
  const prefix = `${ownerId}/`;
  const objectName = typeof path === 'string' ? path.slice(prefix.length) : '';
  if (
    typeof path !== 'string' ||
    !path.startsWith(prefix) ||
    !objectName ||
    objectName.includes('/') ||
    objectName === '.' ||
    objectName === '..' ||
    /[\u0000-\u001f]/.test(objectName)
  ) {
    throw new Error('The cloud file has an invalid owner-scoped storage path.');
  }
  return path;
}

function requireCloudRecord(record, ownerId) {
  if (!record || typeof record.id !== 'string' || !record.id) {
    throw new Error('Cloud file metadata returned an invalid file ID.');
  }
  if (record.owner_id !== ownerId) {
    throw new Error('Cloud file listing returned a record owned by another account.');
  }
  requireFileName(record.filename);
  if (typeof record.mime_type !== 'string' || !record.mime_type.trim()) {
    throw new Error('Cloud file metadata has an invalid MIME type.');
  }
  requireFileSize(record.file_size, 'Cloud file metadata size');
  requireOwnedPath(record.storage_path, ownerId);
  return record;
}

function requireBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error('The local file could not be read as binary data.');
}

async function readBrowserFile(file) {
  const contents = await file.arrayBuffer();
  if (!(contents instanceof ArrayBuffer)) {
    throw new Error('The selected browser file could not be read as binary data.');
  }
  return new Uint8Array(contents);
}

function requireFileSize(value, label) {
  const size = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`${label} is missing or invalid.`);
  }
  if (size > MAX_CLOUD_FILE_SIZE_BYTES) {
    throw new Error(`Cloud files cannot be larger than ${MAX_CLOUD_FILE_SIZE_BYTES / (1024 * 1024)} MB.`);
  }
  return size;
}

function requireRemovedObject(data, path) {
  if (!Array.isArray(data) || !data.some((file) => file?.name === path)) {
    throw new Error('Cloud storage did not confirm removal of the file.');
  }
}

export function createCloudFileService({
  supabase,
  readLocalFile,
  getLocalFileSize,
  writeLocalFile,
  createId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
}) {
  if (
    !supabase?.auth ||
    typeof readLocalFile !== 'function' ||
    typeof getLocalFileSize !== 'function' ||
    typeof writeLocalFile !== 'function'
  ) {
    throw new Error('Cloud file service requires Supabase authentication and local file handlers.');
  }

  async function currentOwnerId() {
    const { data, error } = await supabase.auth.getUser();
    if (error) throw error;
    const ownerId = data?.user?.id;
    if (typeof ownerId !== 'string' || !ownerId) {
      throw new Error('Connect to your cloud account before managing cloud files.');
    }
    return ownerId;
  }

  async function activeOwnedRecord(record, ownerId) {
    if (!record?.id || record.owner_id !== ownerId) {
      throw new Error('This cloud file does not belong to the current account.');
    }
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select(FILE_COLUMNS)
      .eq('id', record.id)
      .eq('owner_id', ownerId)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('This cloud file is no longer available.');
    requireCloudRecord(data, ownerId);
    if (record.storage_path && record.storage_path !== data.storage_path) {
      throw new Error('The cloud file changed. Refresh the cloud list and try again.');
    }
    return data;
  }

  async function list() {
    const ownerId = await currentOwnerId();
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select(FILE_COLUMNS)
      .eq('owner_id', ownerId)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false });
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Cloud file listing returned an invalid response.');
    return data.map((record) => requireCloudRecord(record, ownerId));
  }

  async function upload(item) {
    const ownerId = await currentOwnerId();
    const browserFile =
      item?.file &&
      typeof item.file.arrayBuffer === 'function' &&
      Number.isSafeInteger(item.file.size) &&
      item.file.size >= 0
        ? item.file
        : null;
    if (!browserFile && (typeof item?.uri !== 'string' || !item.uri.startsWith('file://'))) {
      throw new Error('Cloud upload requires a local file URI. Authorized content URIs are not supported.');
    }
    const filename = requireFileName(item.name);
    if (item.size !== undefined && item.size !== null) {
      requireFileSize(item.size, 'The selected file size');
    }
    const mimeType =
      typeof item.mimeType === 'string' && item.mimeType.trim()
        ? item.mimeType.trim()
        : 'application/octet-stream';
    const localSize = requireFileSize(
      browserFile ? browserFile.size : await getLocalFileSize(item.uri),
      'The local file size'
    );
    if (item.size !== undefined && item.size !== null && Number(item.size) !== localSize) {
      throw new Error('The selected file changed before upload. Select it again and retry.');
    }
    if (localSize > MAX_CLOUD_FILE_SIZE_BYTES) {
      throw new Error(`Cloud files cannot be larger than ${MAX_CLOUD_FILE_SIZE_BYTES / (1024 * 1024)} MB.`);
    }
    const bytes = browserFile
      ? await readBrowserFile(browserFile)
      : requireBytes(await readLocalFile(item.uri));
    if (bytes.byteLength !== localSize) {
      throw new Error('The local file changed while it was being read. Select it again and retry.');
    }
    const id = createId();
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new Error('Could not create a safe unique cloud file identifier.');
    }
    const storagePath = requireOwnedPath(`${ownerId}/${id}`, ownerId);
    const storage = supabase.storage.from(BUCKET_NAME);
    const uploadResult = await storage.upload(storagePath, bytes, {
      contentType: mimeType,
      upsert: false,
    });
    if (uploadResult.error) throw uploadResult.error;
    if (uploadResult.data?.path !== storagePath) {
      try {
        const { data, error } = await storage.remove([storagePath]);
        if (error) throw error;
        requireRemovedObject(data, storagePath);
      } catch (cleanupError) {
        throw new Error(
          `Cloud storage did not confirm the uploaded object path, and cleanup failed: ${errorMessage(cleanupError)}`
        );
      }
      throw new Error('Cloud storage did not confirm the uploaded object path. The unconfirmed object was removed.');
    }

    const metadata = {
      owner_id: ownerId,
      filename,
      mime_type: mimeType,
      file_size: bytes.byteLength,
      storage_path: storagePath,
    };

    try {
      const { data, error } = await supabase
        .from(TABLE_NAME)
        .insert(metadata)
        .select(FILE_COLUMNS)
        .single();
      if (error) throw error;
      if (
        !data?.id ||
        data.owner_id !== ownerId ||
        data.filename !== filename ||
        data.mime_type !== mimeType ||
        Number(data.file_size) !== bytes.byteLength ||
        data.storage_path !== storagePath
      ) {
        throw new Error('Cloud metadata insert returned an invalid response.');
      }
      return data;
    } catch (metadataError) {
      const cleanupErrors = [];
      try {
        const { error } = await supabase
          .from(TABLE_NAME)
          .delete()
          .eq('owner_id', ownerId)
          .eq('storage_path', storagePath);
        if (error) throw error;
      } catch (error) {
        cleanupErrors.push(`metadata cleanup failed: ${errorMessage(error)}`);
      }
      try {
        const { data, error } = await storage.remove([storagePath]);
        if (error) throw error;
        requireRemovedObject(data, storagePath);
      } catch (error) {
        cleanupErrors.push(`storage cleanup failed: ${errorMessage(error)}`);
      }
      throw new Error(
        `Cloud upload metadata could not be saved: ${errorMessage(metadataError)}${
          cleanupErrors.length ? `; ${cleanupErrors.join('; ')}` : ''
        }`
      );
    }
  }

  async function download(record) {
    const ownerId = await currentOwnerId();
    const activeRecord = await activeOwnedRecord(record, ownerId);
    const expectedSize = requireFileSize(activeRecord.file_size, 'Cloud file metadata size');
    const storagePath = activeRecord.storage_path;
    const { data, error } = await supabase.storage.from(BUCKET_NAME).download(storagePath);
    if (error) throw error;
    if (!data || typeof data.arrayBuffer !== 'function') {
      throw new Error('Cloud storage returned an invalid file download.');
    }
    const downloadedSize = requireFileSize(data.size, 'Downloaded cloud file size');
    if (downloadedSize !== expectedSize) {
      throw new Error('The downloaded file size does not match its cloud metadata. The file was not saved.');
    }
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (bytes.byteLength !== expectedSize) {
      throw new Error('The downloaded file size does not match its cloud metadata. The file was not saved.');
    }
    const localUri = await writeLocalFile(requireFileName(activeRecord.filename), bytes);
    if (
      typeof localUri !== 'string' ||
      (!localUri.startsWith('file://') && !localUri.startsWith('blob:'))
    ) {
      throw new Error('The downloaded file was not saved to local app storage.');
    }
    return { record: activeRecord, localUri, size: bytes.byteLength };
  }

  async function remove(record) {
    const ownerId = await currentOwnerId();
    const activeRecord = await activeOwnedRecord(record, ownerId);
    const storagePath = activeRecord.storage_path;
    const timestamp = new Date().toISOString();
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .update({ deleted_at: timestamp })
      .eq('id', activeRecord.id)
      .eq('owner_id', ownerId)
      .is('deleted_at', null)
      .select('id,owner_id,storage_path,deleted_at')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('This cloud file is no longer available.');
    if (data.storage_path !== storagePath) {
      throw new Error('The cloud file storage path changed. Refresh the cloud list before deleting it.');
    }

    try {
      const { data: removedObjects, error: storageError } = await supabase.storage
        .from(BUCKET_NAME)
        .remove([storagePath]);
      if (storageError) throw storageError;
      requireRemovedObject(removedObjects, storagePath);
    } catch (storageError) {
      try {
        const { error: restoreError } = await supabase
          .from(TABLE_NAME)
          .update({ deleted_at: null })
          .eq('id', activeRecord.id)
          .eq('owner_id', ownerId)
          .eq('deleted_at', timestamp);
        if (restoreError) throw restoreError;
        const { data: restoredRecord, error: verifyError } = await supabase
          .from(TABLE_NAME)
          .select('id,deleted_at')
          .eq('id', activeRecord.id)
          .eq('owner_id', ownerId)
          .maybeSingle();
        if (verifyError) throw verifyError;
        if (!restoredRecord || restoredRecord.deleted_at !== null) {
          throw new Error('The metadata restore was not confirmed.');
        }
      } catch (restoreError) {
        throw new Error(
          `Cloud storage deletion failed: ${errorMessage(storageError)}. The metadata could not be restored and remains marked deleted: ${errorMessage(restoreError)}`
        );
      }
      throw new Error(`Cloud storage deletion failed: ${errorMessage(storageError)}. Metadata was restored.`);
    }
    return { record: data };
  }

  return { list, upload, download, remove };
}
