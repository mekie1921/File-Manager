import assert from 'node:assert/strict';
import test from 'node:test';
import {
  copyEligibleFiles,
  DEFAULT_DISCOVERY_SETTINGS,
  getUniqueDestinationName,
  isEligibleForAutomaticCopy,
  listAccessibleMedia,
  listAuthorizedFilesRecursively,
  mergeDiscoveredFiles,
  normalizeDiscoverySettings,
} from './fileDiscovery.js';

test('discovery defaults to read-only automatic discovery and validates copy types', () => {
  assert.deepEqual(normalizeDiscoverySettings(null), DEFAULT_DISCOVERY_SETTINGS);
  assert.deepEqual(
    normalizeDiscoverySettings({
      autoDiscoveryEnabled: false,
      autoRefreshEnabled: false,
      autoCopyEnabled: true,
      autoCopyTypes: ['images', 'unknown', 'images'],
    }),
    {
      autoDiscoveryEnabled: false,
      autoRefreshEnabled: false,
      autoCopyEnabled: true,
      autoCopyTypes: ['images'],
    }
  );
});

test('media discovery pages each supported type and deduplicates stable content URIs', async () => {
  const queries = [];
  class Query {
    eq(field, value) {
      this.mediaType = value;
      return this;
    }
    orderBy() { return this; }
    limit(value) {
      this.pageSize = value;
      return this;
    }
    offset(value) {
      this.pageOffset = value;
      return this;
    }
    async exeForMetadata() {
      queries.push({ type: this.mediaType, offset: this.pageOffset });
      if (this.mediaType === 'image' && this.pageOffset === 0) {
        return [
          { id: 'content://media/1', filename: 'photo.jpg', mediaType: 'image', creationTime: 5 },
          { id: 'content://media/1', filename: 'duplicate.jpg', mediaType: 'image' },
        ];
      }
      return [];
    }
  }
  const files = await listAccessibleMedia(
    { AssetField: { MEDIA_TYPE: 'mediaType', CREATION_TIME: 'creationTime' }, MediaType: { IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio' }, Query },
    { pageSize: 2 }
  );
  assert.equal(files.length, 1);
  assert.equal(files[0].uri, 'content://media/1');
  assert.equal(files[0].mimeType, 'image/jpeg');
  assert.deepEqual(queries.map(({ type, offset }) => [type, offset]), [
    ['image', 0],
    ['image', 2],
    ['video', 0],
    ['audio', 0],
  ]);
});

test('media discovery continues through full pages and reports malformed results', async () => {
  const videoOffsets = [];
  class Query {
    eq(field, mediaType) {
      this.mediaType = mediaType;
      return this;
    }
    orderBy() { return this; }
    limit() { return this; }
    offset(value) {
      this.pageOffset = value;
      if (this.mediaType === 'video') videoOffsets.push(value);
      return this;
    }
    async exeForMetadata() {
      if (this.mediaType === 'video' && this.pageOffset === 0) {
        return [
          { id: 'content://media/1', filename: 'one.mp4', mediaType: 'video' },
          { id: 'content://media/2', filename: 'two.mp4', mediaType: 'video' },
        ];
      }
      return [];
    }
  }
  const files = await listAccessibleMedia(
    { AssetField: { MEDIA_TYPE: 'mediaType', CREATION_TIME: 'creationTime' }, MediaType: { IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio' }, Query },
    { pageSize: 2 }
  );
  assert.equal(files.length, 2);
  assert.deepEqual(videoOffsets, [0, 2]);

  class InvalidQuery {
    eq() { return this; }
    orderBy() { return this; }
    limit() { return this; }
    offset() { return this; }
    async exeForMetadata() { return null; }
  }
  await assert.rejects(
    listAccessibleMedia(
      { AssetField: { MEDIA_TYPE: 'mediaType', CREATION_TIME: 'creationTime' }, MediaType: { IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio' }, Query: InvalidQuery }
    ),
    /invalid media discovery/
  );
});

test('discovered lists merge by URI and automatic copy rules honor file type and Downloads folder', () => {
  const media = { uri: 'content://media/one', name: 'one.jpg', mimeType: 'image/jpeg' };
  assert.deepEqual(mergeDiscoveredFiles([media], [{ ...media, name: 'duplicate.jpg' }]), [media]);
  assert.equal(isEligibleForAutomaticCopy(media, ['images']), true);
  assert.equal(isEligibleForAutomaticCopy({ uri: 'content://docs/one', name: 'report.pdf', path: 'content://downloads' }, ['downloads']), true);
  assert.equal(isEligibleForAutomaticCopy(media, []), false);
  assert.equal(getUniqueDestinationName('report.pdf', (name) => name === 'report.pdf'), 'report (1).pdf');
});

test('automatic copy verifies the destination and records an idempotent source reference', async () => {
  const records = new Map();
  const saved = [];
  let history = {};
  const fs = {
    async getInfoAsync(uri) {
      return { exists: records.has(uri), isDirectory: false, size: records.get(uri)?.length || 0 };
    },
  };
  const copyFile = async (source, destination) => {
    records.set(destination, `copy of ${source}`);
  };
  const saveHistory = async (next) => {
    history = { ...next };
  };
  const options = {
    files: [{ uri: 'content://media/photo', name: 'photo.jpg', mimeType: 'image/jpeg', size: 4 }],
    settings: { autoCopyEnabled: true, autoCopyTypes: ['images'] },
    history,
    destinationUri: 'file:///Best/Automatic copies/',
    fileSystem: fs,
    copyFile,
    saveHistory,
  };
  const first = await copyEligibleFiles(options);
  saved.push(...first.copied);
  assert.equal(first.copied.length, 1);
  assert.equal(history['content://media/photo'].status, 'complete');
  const second = await copyEligibleFiles({ ...options, history });
  assert.equal(second.copied.length, 0);
  assert.equal(records.size, 1);
  assert.equal(saved[0].destinationUri, 'file:///Best/Automatic copies/photo.jpg');
});

test('automatic copy reports failures and does not record an unverified destination as complete', async () => {
  let history = {};
  const result = await copyEligibleFiles({
    files: [{ uri: 'content://media/photo', name: 'photo.jpg', mimeType: 'image/jpeg' }],
    settings: { autoCopyEnabled: true, autoCopyTypes: ['images'] },
    history,
    destinationUri: 'file:///Best/Automatic copies/',
    fileSystem: { async getInfoAsync() { return { exists: false }; } },
    async copyFile() { throw new Error('permission denied'); },
    async saveHistory(next) { history = { ...next }; },
  });
  assert.equal(result.copied.length, 0);
  assert.match(result.failures[0].error, /permission denied/);
  assert.equal(result.history['content://media/photo'].status, 'pending');
});

test('authorized folder discovery recurses only through the selected provider tree', () => {
  const tree = {
    'content://root': ['content://root/photo.jpg', 'content://root/docs'],
    'content://root/docs': ['content://root/docs/report.pdf'],
  };
  class Directory {
    constructor(uri) {
      this.uri = uri;
      this.name = uri.split('/').pop();
      this.type = null;
    }
    list() {
      return (tree[this.uri] || []).map((uri) =>
        tree[uri] ? new Directory(uri) : { uri, name: uri.split('/').pop(), type: 'application/pdf', info: () => ({ exists: true, size: 12 }) }
      );
    }
    info() {
      return { exists: true };
    }
  }
  const files = listAuthorizedFilesRecursively('content://root', Directory);
  assert.deepEqual(files.map(({ name }) => name).sort(), ['photo.jpg', 'report.pdf']);
  assert.ok(files.every(({ storageKind }) => storageKind === 'authorized-folder'));
});
