import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadTrashEntries,
  moveItemsToTrash,
  moveToTrash,
  permanentlyDelete,
  restoreFromTrash,
} from './localFileOperations.js';

function createFileSystem() {
  const files = new Map();
  const directories = new Set(['file:///documents/', 'file:///documents/PocketFiles/']);
  let failNextWrite = false;
  let writesBeforeFailure = null;
  let failMoveFrom = null;

  function hasDescendants(uri) {
    const prefix = uri.endsWith('/') ? uri : `${uri}/`;
    return [...files.keys(), ...directories].some((path) => path.startsWith(prefix));
  }

  return {
    files,
    directories,
    failWriteOnce() {
      failNextWrite = true;
    },
    failWriteAfter(writes) {
      writesBeforeFailure = writes;
    },
    failMoveFrom(uri) {
      failMoveFrom = uri;
    },
    async getInfoAsync(uri) {
      if (files.has(uri)) {
        return { exists: true, isDirectory: false, size: files.get(uri).length };
      }
      if (directories.has(uri) || hasDescendants(uri)) {
        return { exists: true, isDirectory: true, size: 0 };
      }
      return { exists: false, isDirectory: false };
    },
    async readAsStringAsync(uri) {
      if (!files.has(uri)) throw new Error(`Missing file: ${uri}`);
      return files.get(uri);
    },
    async writeAsStringAsync(uri, value) {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error('Injected metadata write failure');
      }
      if (writesBeforeFailure === 0) {
        writesBeforeFailure = null;
        throw new Error('Injected metadata write failure');
      }
      if (writesBeforeFailure !== null) writesBeforeFailure -= 1;
      files.set(uri, value);
    },
    async makeDirectoryAsync(uri) {
      directories.add(uri);
    },
    async moveAsync({ from, to }) {
      if (failMoveFrom === from) {
        failMoveFrom = null;
        throw new Error(`Injected move failure for ${from}`);
      }
      if (files.has(to) || directories.has(to) || hasDescendants(to)) {
        throw new Error(`Destination exists: ${to}`);
      }
      if (files.has(from)) {
        files.set(to, files.get(from));
        files.delete(from);
        return;
      }
      const sourcePrefix = from.endsWith('/') ? from : `${from}/`;
      const childFiles = [...files.entries()].filter(([path]) => path.startsWith(sourcePrefix));
      const childDirectories = [...directories].filter((path) => path.startsWith(sourcePrefix));
      if (!directories.has(from) && !childFiles.length && !childDirectories.length) {
        throw new Error(`Source does not exist: ${from}`);
      }
      for (const [path, value] of childFiles) {
        files.set(`${to}${path.slice(from.length)}`, value);
        files.delete(path);
      }
      for (const path of childDirectories) {
        directories.add(`${to}${path.slice(from.length)}`);
        directories.delete(path);
      }
      directories.delete(from);
      directories.add(to);
    },
    async deleteAsync(uri) {
      files.delete(uri);
      directories.delete(uri);
      for (const path of [...files.keys()]) {
        if (path.startsWith(`${uri}/`)) files.delete(path);
      }
      for (const path of [...directories]) {
        if (path.startsWith(`${uri}/`)) directories.delete(path);
      }
    },
  };
}

const indexUri = 'file:///documents/PocketFilesTrash/index.json';
const trashRoot = 'file:///documents/PocketFilesTrash/';

test('delete and restore keeps original nested location and uses unique trash IDs', async () => {
  const fs = createFileSystem();
  const originalUri = 'file:///documents/PocketFiles/Folder/report.txt';
  fs.directories.add('file:///documents/PocketFiles/Folder/');
  fs.files.set(originalUri, 'file contents');

  const first = await moveToTrash(fs, { name: 'report.txt', uri: originalUri }, indexUri, trashRoot);
  assert.equal(first.entry.state, 'trashed');
  assert.notEqual(first.entry.id, originalUri);
  assert.equal(fs.files.has(originalUri), false);

  const restored = await restoreFromTrash(fs, first.entry.id, indexUri, trashRoot);
  assert.equal(restored.entry.originalUri, originalUri);
  assert.equal(fs.files.get(originalUri), 'file contents');
  assert.deepEqual((await loadTrashEntries(fs, indexUri, trashRoot)).entries, []);
});

test('restoring a folder restores its contained files to the original path', async () => {
  const fs = createFileSystem();
  const folderUri = 'file:///documents/PocketFiles/Folder';
  const childUri = `${folderUri}/nested.txt`;
  fs.directories.add(`${folderUri}/`);
  fs.files.set(childUri, 'nested contents');

  const moved = await moveToTrash(
    fs,
    { name: 'Folder', uri: folderUri, isDirectory: true },
    indexUri,
    trashRoot
  );
  await restoreFromTrash(fs, moved.entry.id, indexUri, trashRoot);

  assert.equal(fs.files.get(childUri), 'nested contents');
  assert.equal((await fs.getInfoAsync(folderUri)).isDirectory, true);
});

test('metadata write failure prevents moving the source file', async () => {
  const fs = createFileSystem();
  const originalUri = 'file:///documents/PocketFiles/keep.txt';
  fs.files.set(originalUri, 'keep');
  fs.failWriteOnce();

  await assert.rejects(
    moveToTrash(fs, { name: 'keep.txt', uri: originalUri }, indexUri, trashRoot),
    /Recycle-bin metadata could not be saved/
  );
  assert.equal(fs.files.get(originalUri), 'keep');
  assert.equal(fs.files.has(indexUri), false);
});

test('a moved file remains recoverable if final metadata update fails', async () => {
  const fs = createFileSystem();
  const originalUri = 'file:///documents/PocketFiles/recover.txt';
  fs.files.set(originalUri, 'recover');
  fs.failWriteAfter(1);

  const result = await moveToTrash(
    fs,
    { name: 'recover.txt', uri: originalUri },
    indexUri,
    trashRoot
  );

  assert.match(result.warning, /metadata finalization failed/);
  assert.equal(fs.files.has(originalUri), false);
  const recovered = await loadTrashEntries(fs, indexUri, trashRoot);
  assert.equal(recovered.entries.length, 1);
  assert.equal(recovered.entries[0].state, 'trashed');
  assert.equal(fs.files.get(recovered.entries[0].uri), 'recover');
});

test('move failure removes its pending record and preserves the source', async () => {
  const fs = createFileSystem();
  const originalUri = 'file:///documents/PocketFiles/retry.txt';
  fs.files.set(originalUri, 'retry');
  fs.failMoveFrom(originalUri);

  await assert.rejects(
    moveToTrash(fs, { name: 'retry.txt', uri: originalUri }, indexUri, trashRoot),
    /Could not move "retry.txt"/
  );
  assert.equal(fs.files.get(originalUri), 'retry');
  assert.deepEqual((await loadTrashEntries(fs, indexUri, trashRoot)).entries, []);
});

test('batch deletion reports a per-item failure and continues with remaining items', async () => {
  const fs = createFileSystem();
  const firstUri = 'file:///documents/PocketFiles/first.txt';
  const secondUri = 'file:///documents/PocketFiles/second.txt';
  fs.files.set(firstUri, 'first');
  fs.files.set(secondUri, 'second');
  fs.failMoveFrom(firstUri);

  const results = await moveItemsToTrash(
    fs,
    [
      { name: 'first.txt', uri: firstUri },
      { name: 'second.txt', uri: secondUri },
    ],
    indexUri,
    trashRoot
  );

  assert.equal(results[0].success, false);
  assert.match(results[0].error, /Could not move/);
  assert.equal(results[1].success, true);
  assert.equal(fs.files.get(firstUri), 'first');
  assert.equal(fs.files.has(secondUri), false);
  assert.equal((await loadTrashEntries(fs, indexUri, trashRoot)).entries.length, 1);
});

test('restoration refuses to overwrite a new item at the original path', async () => {
  const fs = createFileSystem();
  const originalUri = 'file:///documents/PocketFiles/conflict.txt';
  fs.files.set(originalUri, 'original');
  const result = await moveToTrash(
    fs,
    { name: 'conflict.txt', uri: originalUri },
    indexUri,
    trashRoot
  );
  fs.files.set(originalUri, 'new file');

  await assert.rejects(
    restoreFromTrash(fs, result.entry.id, indexUri, trashRoot),
    /already exists at its original location/
  );
  assert.equal(fs.files.get(originalUri), 'new file');
  assert.equal(fs.files.has(result.entry.uri), true);
});

test('recovery resolves a persisted pending entry when its moved file is present', async () => {
  const fs = createFileSystem();
  const originalUri = 'file:///documents/PocketFiles/pending.txt';
  const trashUri = `${trashRoot}existing-record`;
  fs.files.set(trashUri, 'pending');
  fs.files.set(
    indexUri,
    JSON.stringify([
      {
        id: 'existing-record',
        name: 'pending.txt',
        uri: trashUri,
        originalUri,
        movedAt: 1,
        state: 'pending',
      },
    ])
  );

  const recovered = await loadTrashEntries(fs, indexUri, trashRoot);
  assert.equal(recovered.entries[0].state, 'trashed');
  assert.equal(JSON.parse(fs.files.get(indexUri))[0].state, 'trashed');
});

test('startup recovers recycle-bin metadata from its atomic-write backup', async () => {
  const fs = createFileSystem();
  const trashUri = `${trashRoot}backup-record`;
  const backupUri = `${indexUri}.bak`;
  fs.files.set(trashUri, 'backup contents');
  fs.files.set(
    backupUri,
    JSON.stringify([
      {
        id: 'backup-record',
        name: 'backup.txt',
        uri: trashUri,
        originalUri: 'file:///documents/PocketFiles/backup.txt',
        movedAt: 1,
        state: 'trashed',
      },
    ])
  );

  const recovered = await loadTrashEntries(fs, indexUri, trashRoot);

  assert.equal(recovered.entries.length, 1);
  assert.equal(fs.files.has(indexUri), true);
  assert.equal(fs.files.has(backupUri), false);
});

test('recovery repairs duplicate legacy recycle-bin IDs without losing records', async () => {
  const fs = createFileSystem();
  const firstUri = `${trashRoot}first-file`;
  const secondUri = `${trashRoot}second-file`;
  const duplicated = {
    id: 'same-legacy-id',
    name: 'file.txt',
    originalUri: 'file:///documents/PocketFiles/file.txt',
    movedAt: 1,
    state: 'trashed',
  };
  fs.files.set(firstUri, 'first');
  fs.files.set(secondUri, 'second');
  fs.files.set(
    indexUri,
    JSON.stringify([
      { ...duplicated, uri: firstUri },
      { ...duplicated, uri: secondUri },
    ])
  );

  const recovered = await loadTrashEntries(fs, indexUri, trashRoot);
  assert.equal(recovered.entries.length, 2);
  assert.notEqual(recovered.entries[0].id, recovered.entries[1].id);
  assert.deepEqual(
    JSON.parse(fs.files.get(indexUri)).map((entry) => entry.id),
    recovered.entries.map((entry) => entry.id)
  );
});

test('permanent deletion clears both the trashed file and its metadata', async () => {
  const fs = createFileSystem();
  const originalUri = 'file:///documents/PocketFiles/remove.txt';
  fs.files.set(originalUri, 'remove');
  const result = await moveToTrash(
    fs,
    { name: 'remove.txt', uri: originalUri },
    indexUri,
    trashRoot
  );

  await permanentlyDelete(fs, result.entry.id, indexUri, trashRoot);

  assert.equal(fs.files.has(result.entry.uri), false);
  assert.deepEqual((await loadTrashEntries(fs, indexUri, trashRoot)).entries, []);
});
