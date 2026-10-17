import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudFileService } from './cloudFileService.js';

const ownerId = 'user-123';

function createHarness({
  listResult = [{
    id: 'file-1',
    owner_id: ownerId,
    filename: 'notes.txt',
    mime_type: 'text/plain',
    file_size: 3,
    storage_path: `${ownerId}/object-1`,
  }],
  insertError = null,
  storageUploadError = null,
  storageUploadPath = null,
  insertRecordOverrides = {},
  storageRemoveError = null,
  storageRemoveData = null,
  storageDownloadError = null,
  downloadBytes = [1, 2, 3],
  localFileSize = 3,
  restoreMissing = false,
  listError = null,
} = {}) {
  const calls = [];
  let tableOperation = null;
  let updateData = null;
  const table = {
    select(columns) {
      calls.push(['select', columns]);
      if (tableOperation !== 'update' && tableOperation !== 'insert') tableOperation = 'select';
      return this;
    },
    eq(column, value) {
      calls.push(['eq', column, value]);
      return this;
    },
    is(column, value) {
      calls.push(['is', column, value]);
      return this;
    },
    order(column, options) {
      calls.push(['order', column, options]);
      return Promise.resolve({ data: listResult, error: listError });
    },
    insert(value) {
      calls.push(['insert', value]);
      tableOperation = 'insert';
      return this;
    },
    update(value) {
      calls.push(['update', value]);
      tableOperation = 'update';
      updateData = value;
      return this;
    },
    delete() {
      calls.push(['delete']);
      tableOperation = 'delete';
      return this;
    },
    single() {
      return insertError
        ? Promise.resolve({ data: null, error: insertError })
        : Promise.resolve({
            data: {
              id: 'file-2',
              ...calls.find(([kind]) => kind === 'insert')[1],
              ...insertRecordOverrides,
            },
            error: null,
          });
    },
    maybeSingle() {
      if (tableOperation === 'update' && updateData?.deleted_at) {
        return Promise.resolve({
          data: { id: 'file-1', owner_id: ownerId, storage_path: `${ownerId}/object-1`, deleted_at: updateData.deleted_at },
          error: null,
        });
      }
      if (tableOperation === 'update' && updateData?.deleted_at === null) {
        return Promise.resolve({
          data: restoreMissing ? null : { id: 'file-1', deleted_at: null },
          error: null,
        });
      }
      if (tableOperation === 'select') {
        return Promise.resolve({ data: listResult[0] || null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    then(resolve, reject) {
      if (tableOperation === 'delete') {
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      }
      return Promise.resolve({ data: null, error: null }).then(resolve, reject);
    },
  };

  const storage = {
    async upload(path, body, options) {
      calls.push(['storage.upload', path, body, options]);
      return storageUploadError
        ? { data: null, error: storageUploadError }
        : { data: { path: storageUploadPath || path }, error: null };
    },
    async download(path) {
      calls.push(['storage.download', path]);
      return storageDownloadError
        ? { data: null, error: storageDownloadError }
        : {
            data: {
              size: downloadBytes.length,
              async arrayBuffer() { return new Uint8Array(downloadBytes).buffer; },
            },
            error: null,
          };
    },
    async remove(paths) {
      calls.push(['storage.remove', paths]);
      return {
        data: storageRemoveError
          ? null
          : storageRemoveData || paths.map((path) => ({ name: path })),
        error: storageRemoveError,
      };
    },
  };

  const supabase = {
    auth: {
      async getUser() {
        return { data: { user: { id: ownerId } }, error: null };
      },
    },
    from(name) {
      calls.push(['from', name]);
      return table;
    },
    storage: {
      from(name) {
        calls.push(['bucket', name]);
        return storage;
      },
    },
  };

  const writes = [];
  const service = createCloudFileService({
    supabase,
    readLocalFile: async (uri) => {
      calls.push(['readLocalFile', uri]);
      return new Uint8Array([1, 2, 3]);
    },
    getLocalFileSize: async (uri) => {
      calls.push(['getLocalFileSize', uri]);
      return localFileSize;
    },
    writeLocalFile: async (filename, bytes) => {
      writes.push({ filename, bytes });
      return `file:///documents/PocketFiles/${filename}`;
    },
    createId: () => 'object-2',
  });

  return { service, calls, writes };
}

test('lists only active metadata owned by the authenticated user', async () => {
  const { service, calls } = createHarness();
  const files = await service.list();

  assert.equal(files.length, 1);
  assert.ok(calls.some((call) => call[0] === 'eq' && call[1] === 'owner_id' && call[2] === ownerId));
  assert.ok(calls.some((call) => call[0] === 'is' && call[1] === 'deleted_at' && call[2] === null));
});

test('rejects listed metadata with invalid names, MIME types, sizes, or owner paths', async () => {
  const invalidRecords = [
    { filename: '../notes.txt' },
    { mime_type: '' },
    { file_size: -1 },
    { storage_path: `${ownerId}/../other` },
    { owner_id: 'another-user' },
  ];

  for (const override of invalidRecords) {
    const { service } = createHarness({
      listResult: [{
        id: 'file-1',
        owner_id: ownerId,
        filename: 'notes.txt',
        mime_type: 'text/plain',
        file_size: 3,
        storage_path: `${ownerId}/object-1`,
        ...override,
      }],
    });
    await assert.rejects(service.list());
  }
});

test('uploads binary data without overwriting and saves matching metadata', async () => {
  const { service, calls } = createHarness();
  const record = await service.upload({
    uri: 'file:///cache/notes.txt',
    name: 'notes.txt',
    mimeType: 'text/plain',
    size: 3,
  });
  const upload = calls.find(([kind]) => kind === 'storage.upload');
  const insert = calls.find(([kind]) => kind === 'insert');

  assert.equal(record.id, 'file-2');
  assert.equal(upload[1], `${ownerId}/object-2`);
  assert.deepEqual(upload[3], { contentType: 'text/plain', upsert: false });
  assert.equal(insert[1].file_size, 3);
  assert.equal(insert[1].storage_path, upload[1]);
});

test('refuses document-provider content URIs before any remote write', async () => {
  const { service, calls } = createHarness();
  await assert.rejects(
    service.upload({ uri: 'content://provider/document/7', name: 'notes.txt' }),
    /content URIs are not supported/
  );
  assert.equal(calls.some(([kind]) => kind === 'storage.upload'), false);
});

test('cleans up the uploaded object when metadata insertion fails', async () => {
  const { service, calls } = createHarness({ insertError: new Error('database unavailable') });
  await assert.rejects(
    service.upload({ uri: 'file:///cache/notes.txt', name: 'notes.txt' }),
    /metadata could not be saved: database unavailable/
  );
  assert.ok(calls.some(([kind]) => kind === 'delete'));
  assert.ok(calls.some(([kind]) => kind === 'storage.remove'));
});

test('does not insert metadata when storage upload fails', async () => {
  const { service, calls } = createHarness({ storageUploadError: new Error('network unavailable') });
  await assert.rejects(
    service.upload({ uri: 'file:///cache/notes.txt', name: 'notes.txt' }),
    /network unavailable/
  );
  assert.equal(calls.some(([kind]) => kind === 'insert'), false);
});

test('rejects oversized uploads before reading or uploading file contents', async () => {
  const { service, calls } = createHarness({ localFileSize: 50 * 1024 * 1024 + 1 });
  await assert.rejects(
    service.upload({ uri: 'file:///cache/large.zip', name: 'large.zip' }),
    /cannot be larger than 50 MB/
  );
  assert.equal(calls.some(([kind]) => kind === 'readLocalFile'), false);
  assert.equal(calls.some(([kind]) => kind === 'storage.upload'), false);
});

test('rejects changed or unknown file sizes instead of uploading mismatched bytes', async () => {
  const changed = createHarness({ localFileSize: 4 });
  await assert.rejects(
    changed.service.upload({ uri: 'file:///cache/notes.txt', name: 'notes.txt', size: 3 }),
    /changed before upload/
  );
  assert.equal(changed.calls.some(([kind]) => kind === 'readLocalFile'), false);

  const unknown = createHarness({ localFileSize: null });
  await assert.rejects(
    unknown.service.upload({ uri: 'file:///cache/notes.txt', name: 'notes.txt' }),
    /size is missing or invalid/
  );
  assert.equal(unknown.calls.some(([kind]) => kind === 'storage.upload'), false);
});

test('rejects cloud metadata over the file-size limit before downloading content', async () => {
  const { service, calls } = createHarness({
    listResult: [{
      id: 'file-1',
      owner_id: ownerId,
      filename: 'large.zip',
      mime_type: 'application/zip',
      file_size: 50 * 1024 * 1024 + 1,
      storage_path: `${ownerId}/object-1`,
    }],
  });
  await assert.rejects(
    service.download({
      id: 'file-1',
      owner_id: ownerId,
      filename: 'large.zip',
      storage_path: `${ownerId}/object-1`,
    }),
    /cannot be larger than 50 MB/
  );
  assert.equal(calls.some(([kind]) => kind === 'storage.download'), false);
});

test('does not write a download that disagrees with cloud metadata size', async () => {
  const { service, writes } = createHarness({ downloadBytes: [1, 2] });
  await assert.rejects(
    service.download({
      id: 'file-1',
      owner_id: ownerId,
      filename: 'notes.txt',
      storage_path: `${ownerId}/object-1`,
    }),
    /does not match its cloud metadata/
  );
  assert.equal(writes.length, 0);
});

test('removes an object when storage does not confirm the requested upload path', async () => {
  const { service, calls } = createHarness({ storageUploadPath: `${ownerId}/unexpected` });
  await assert.rejects(
    service.upload({ uri: 'file:///cache/notes.txt', name: 'notes.txt' }),
    /unconfirmed object was removed/
  );
  assert.ok(calls.some(([kind, paths]) => kind === 'storage.remove' && paths[0] === `${ownerId}/object-2`));
  assert.equal(calls.some(([kind]) => kind === 'insert'), false);
});

test('reports cleanup errors after an unconfirmed storage upload', async () => {
  const { service } = createHarness({
    storageUploadPath: `${ownerId}/unexpected`,
    storageRemoveError: new Error('cleanup unavailable'),
  });
  await assert.rejects(
    service.upload({ uri: 'file:///cache/notes.txt', name: 'notes.txt' }),
    /cleanup failed: cleanup unavailable/
  );
});

test('reports both the metadata error and rollback failures', async () => {
  const { service } = createHarness({
    insertError: new Error('database unavailable'),
    storageRemoveError: new Error('network unavailable'),
  });
  await assert.rejects(
    service.upload({ uri: 'file:///cache/notes.txt', name: 'notes.txt' }),
    /storage cleanup failed: network unavailable/
  );
});

test('cleans up object and metadata when inserted metadata does not match uploaded bytes', async () => {
  const { service, calls } = createHarness({ insertRecordOverrides: { file_size: 2 } });
  await assert.rejects(
    service.upload({ uri: 'file:///cache/notes.txt', name: 'notes.txt', size: 3 }),
    /metadata could not be saved: Cloud metadata insert returned an invalid response/
  );
  assert.ok(calls.some(([kind]) => kind === 'delete'));
  assert.ok(calls.some(([kind, paths]) => kind === 'storage.remove' && paths[0] === `${ownerId}/object-2`));
});

test('downloads only owner-scoped records to the local file writer', async () => {
  const { service, calls, writes } = createHarness();
  const result = await service.download({
    id: 'file-1',
    owner_id: ownerId,
    filename: 'notes.txt',
    storage_path: `${ownerId}/object-1`,
  });

  assert.equal(result.size, 3);
  assert.deepEqual([...writes[0].bytes], [1, 2, 3]);
  assert.ok(calls.some((call) => call[0] === 'storage.download' && call[1] === `${ownerId}/object-1`));
  await assert.rejects(
    service.download({ id: 'foreign', owner_id: 'someone-else', filename: 'x', storage_path: 'someone-else/x' }),
    /does not belong to the current account/
  );
});

test('rejects stale cloud paths before downloading their object', async () => {
  const { service, calls } = createHarness();
  await assert.rejects(
    service.download({
      id: 'file-1',
      owner_id: ownerId,
      filename: 'notes.txt',
      storage_path: `${ownerId}/different-object`,
    }),
    /changed/
  );
  assert.equal(calls.some(([kind]) => kind === 'storage.download'), false);
});

test('reports cloud list network failures rather than showing a false empty state', async () => {
  const { service } = createHarness({ listError: new Error('network unavailable') });
  await assert.rejects(service.list(), /network unavailable/);
});

test('marks metadata deleted and removes the matching owner-scoped object', async () => {
  const { service, calls } = createHarness();
  const result = await service.remove({
    id: 'file-1',
    owner_id: ownerId,
    filename: 'notes.txt',
    storage_path: `${ownerId}/object-1`,
  });

  assert.equal(result.record.id, 'file-1');
  assert.ok(calls.some(([kind]) => kind === 'update' && typeof calls.find((call) => call[0] === 'update')[1].deleted_at === 'string'));
  assert.ok(calls.some(([kind, paths]) => kind === 'storage.remove' && paths[0] === `${ownerId}/object-1`));
});

test('restores active metadata when cloud object deletion fails', async () => {
  const { service, calls } = createHarness({ storageRemoveError: new Error('network unavailable') });
  await assert.rejects(
    service.remove({
      id: 'file-1',
      owner_id: ownerId,
      filename: 'notes.txt',
      storage_path: `${ownerId}/object-1`,
    }),
    /Metadata was restored/
  );
  const updates = calls.filter(([kind]) => kind === 'update');
  assert.equal(updates.length, 2);
  assert.equal(updates[1][1].deleted_at, null);
});

test('does not report deletion success without confirmation of the removed object', async () => {
  const { service, calls } = createHarness({ storageRemoveData: [] });
  await assert.rejects(
    service.remove({
      id: 'file-1',
      owner_id: ownerId,
      filename: 'notes.txt',
      storage_path: `${ownerId}/object-1`,
    }),
    /did not confirm removal/
  );
  assert.equal(calls.filter(([kind]) => kind === 'update').length, 2);
});

test('reports when metadata restoration after deletion failure cannot be confirmed', async () => {
  const { service } = createHarness({ storageRemoveError: new Error('network unavailable'), restoreMissing: true });
  await assert.rejects(
    service.remove({
      id: 'file-1',
      owner_id: ownerId,
      filename: 'notes.txt',
      storage_path: `${ownerId}/object-1`,
    }),
    /metadata could not be restored.*not confirmed/
  );
});
