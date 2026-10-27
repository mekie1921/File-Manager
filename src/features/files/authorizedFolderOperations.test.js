import assert from 'node:assert/strict';
import test from 'node:test';
import {
  copyFileIntoAuthorizedFolder,
  createAuthorizedFolder,
  deleteAuthorizedItem,
  listAuthorizedDirectory,
  parentBreadcrumbs,
} from './authorizedFolderOperations.js';

class MockDirectory {
  static records = new Map();

  constructor(uri) {
    this.uri = uri;
    this.name = uri.split('/').at(-1);
  }

  list() {
    return MockDirectory.records.get(this.uri) || [];
  }

  info() {
    return { exists: true, size: 24, modificationTime: 1000 };
  }
}

class MockFile {
  constructor(uri, childName) {
    this.uri = childName ? `${uri.uri}/${childName}` : uri;
    this.name = this.uri.split('/').at(-1);
    this.type = 'text/plain';
    this.copyCalls = [];
  }

  info() {
    return { exists: true, size: 24, modificationTime: 1000 };
  }

  async copy(destination) {
    this.copyCalls.push(destination.uri);
    MockFile.lastCopy = { source: this.uri, destination: destination.uri };
  }
}

function mockStorageAccessFramework() {
  return {
    created: [],
    deleted: [],
    async makeDirectoryAsync(parentUri, name) {
      this.created.push({ parentUri, name });
      return `${parentUri}/created/${name}`;
    },
    async deleteAsync(uri) {
      this.deleted.push(uri);
    },
  };
}

test('lists authorized-folder children with provider metadata and stable URI IDs', () => {
  const folderUri = 'content://provider/tree/root/document/root';
  const fileUri = 'content://provider/tree/root/document/root%2Freadme.txt';
  const folderChildUri = `${folderUri}/docs`;
  MockDirectory.records = new Map([
    [
      folderUri,
      [
        new MockFile(fileUri),
        new MockDirectory(folderChildUri),
      ],
    ],
  ]);

  const entries = listAuthorizedDirectory(folderUri, MockDirectory);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, fileUri);
  assert.equal(entries[0].storageKind, 'authorized-folder');
  assert.equal(entries[0].mimeType, 'text/plain');
  assert.equal(entries[1].isDirectory, true);
});

test('creates a unique folder through the provider API', async () => {
  const saf = mockStorageAccessFramework();
  const result = await createAuthorizedFolder(saf, 'content://provider/tree/root', 'New folder', []);
  assert.equal(result, 'content://provider/tree/root/created/New folder');
  assert.deepEqual(saf.created, [{ parentUri: 'content://provider/tree/root', name: 'New folder' }]);
});

test('folder creation rejects duplicates and invalid path names before provider access', async () => {
  const saf = mockStorageAccessFramework();
  await assert.rejects(
    createAuthorizedFolder(saf, 'content://provider/tree/root', 'same.txt', [{ name: 'same.txt' }]),
    /already exists/
  );
  await assert.rejects(
    createAuthorizedFolder(saf, 'content://provider/tree/root', '..', []),
    /valid name/
  );
  assert.deepEqual(saf.created, []);
});

test('deletes only through the selected provider and propagates provider failures', async () => {
  const saf = mockStorageAccessFramework();
  const item = { uri: 'content://provider/tree/root/document/root%2Ffile.txt' };
  await deleteAuthorizedItem(saf, item);
  assert.deepEqual(saf.deleted, [item.uri]);

  saf.deleteAsync = async () => {
    throw new Error('Provider denied deletion');
  };
  await assert.rejects(deleteAuthorizedItem(saf, item), /Provider denied deletion/);
});

test('copies a picked file into the authorized folder and refuses a name conflict', async () => {
  const destinationUri = 'content://provider/tree/root/document/root';
  await copyFileIntoAuthorizedFolder(
    MockFile,
    MockDirectory,
    'file:///cache/import.txt',
    destinationUri,
    'import.txt',
    []
  );
  assert.deepEqual(MockFile.lastCopy, {
    source: 'file:///cache/import.txt',
    destination: `${destinationUri}/import.txt`,
  });

  await assert.rejects(
    copyFileIntoAuthorizedFolder(
      MockFile,
      MockDirectory,
      'file:///cache/import.txt',
      destinationUri,
      'import.txt',
      [{ name: 'import.txt' }]
    ),
    /already exists/
  );
});

test('limits external breadcrumbs to the selected ancestor', () => {
  const stack = [
    { uri: 'content://provider/tree/root', name: 'Selected folder' },
    { uri: 'content://provider/tree/root/document/root%2Fdocs', name: 'docs' },
    { uri: 'content://provider/tree/root/document/root%2Fdocs%2Farchive', name: 'archive' },
  ];
  assert.deepEqual(parentBreadcrumbs(stack, stack[1].uri), stack.slice(0, 2));
});
