import assert from 'node:assert/strict';
import test from 'node:test';
import { openAndroidFile } from './androidFileOpening.js';
import {
  appDirectoryBreadcrumbs,
  createLocalFolder,
  importLocalFile,
  listLocalFilesRecursively,
  matchesSearch,
  openWithCompatibleApp,
  parentDirectoryUri,
  renameLocalItem,
  sortEntries,
  visibleSelectedItems,
} from './fileManagerOperations.js';

function createFileSystem() {
  const files = new Map();
  const directories = new Set(['file:///documents/PocketFiles/']);

  return {
    files,
    directories,
    async getInfoAsync(uri) {
      return { exists: files.has(uri) || directories.has(uri) || directories.has(`${uri}/`), isDirectory: directories.has(uri) || directories.has(`${uri}/`), size: files.get(uri)?.length || 0 };
    },
    async makeDirectoryAsync(uri) {
      if (directories.has(uri) || files.has(uri)) throw new Error('Destination exists');
      directories.add(uri.endsWith('/') ? uri : `${uri}/`);
    },
    async copyAsync({ from, to }) {
      if (!files.has(from)) throw new Error(`Missing source: ${from}`);
      if (files.has(to) || directories.has(to)) throw new Error(`Destination exists: ${to}`);
      files.set(to, files.get(from));
    },
    async moveAsync({ from, to }) {
      if (!files.has(from) && !directories.has(from)) throw new Error(`Missing source: ${from}`);
      if (files.has(to) || directories.has(to)) throw new Error(`Destination exists: ${to}`);
      if (files.has(from)) {
        files.set(to, files.get(from));
        files.delete(from);
      } else {
        directories.delete(from);
        directories.add(to);
      }
    },
    async readDirectoryAsync(uri) {
      const prefix = uri.endsWith('/') ? uri : `${uri}/`;
      const children = new Set();
      for (const path of [...files.keys(), ...directories]) {
        if (!path.startsWith(prefix) || path === prefix) continue;
        const rest = path.slice(prefix.length);
        const name = rest.split('/')[0];
        children.add(name);
      }
      return [...children];
    },
  };
}

test('folder creation, import, and rename update the next directory listing', async () => {
  const fs = createFileSystem();
  const root = 'file:///documents/PocketFiles/';
  const source = 'file:///cache/picked.txt';
  fs.files.set(source, 'picked contents');

  await createLocalFolder(fs, root, 'Reports');
  assert.deepEqual(await fs.readDirectoryAsync(root), ['Reports']);

  const importedUri = await importLocalFile(fs, source, root, 'picked.txt');
  assert.equal(fs.files.get(importedUri), 'picked contents');
  assert.deepEqual((await fs.readDirectoryAsync(root)).sort(), ['Reports', 'picked.txt']);

  const renamedUri = await renameLocalItem(
    fs,
    { uri: importedUri },
    root,
    'renamed.txt'
  );
  assert.equal(fs.files.get(renamedUri), 'picked contents');
  assert.equal(fs.files.has(importedUri), false);
  assert.deepEqual((await fs.readDirectoryAsync(root)).sort(), ['Reports', 'renamed.txt']);
});

test('import copies Android-granted content URIs without modifying the source', async () => {
  const fs = createFileSystem();
  const source = 'content://provider/shared/document/42';
  const destination = 'file:///documents/PocketFiles/shared.pdf';
  fs.files.set(source, 'shared contents');

  const savedUri = await importLocalFile(fs, source, 'file:///documents/PocketFiles/', 'shared.pdf');

  assert.equal(savedUri, destination);
  assert.equal(fs.files.get(savedUri), 'shared contents');
  assert.equal(fs.files.get(source), 'shared contents');
});

test('nested folder navigation and breadcrumbs stay within the absolute app-storage URI', () => {
  const root = 'file:///documents/PocketFiles/';
  const nested = `${root}Reports/2026/`;
  assert.equal(parentDirectoryUri(nested, root), `${root}Reports/`);
  assert.equal(parentDirectoryUri(`${root}Reports/`, root), root);
  assert.equal(parentDirectoryUri(root, root), null);
  assert.equal(parentDirectoryUri('file:///documents/Elsewhere/', root), null);
  assert.deepEqual(appDirectoryBreadcrumbs(nested, root), [
    { name: 'Home', uri: root },
    { name: 'Reports', uri: `${root}Reports/` },
    { name: '2026', uri: nested },
  ]);
});

test('recursive local listing includes nested files with their real parent paths', async () => {
  const fs = createFileSystem();
  const root = 'file:///documents/PocketFiles/';
  fs.directories.add(`${root}Pictures/`);
  fs.files.set(`${root}top.txt`, 'top');
  fs.files.set(`${root}Pictures/photo.jpg`, 'image');
  const files = await listLocalFilesRecursively(fs, root);
  assert.deepEqual(
    files.map(({ name, path }) => ({ name, path })).sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: 'photo.jpg', path: `${root}Pictures/` },
      { name: 'top.txt', path: root },
    ]
  );
});

test('create, import, and rename reject invalid names and existing destinations', async () => {
  const fs = createFileSystem();
  const root = 'file:///documents/PocketFiles/';
  fs.files.set('file:///cache/source.txt', 'source');
  fs.files.set(`${root}existing.txt`, 'existing');

  await assert.rejects(createLocalFolder(fs, root, '../outside'), /valid name/);
  await assert.rejects(createLocalFolder(fs, root, 'existing.txt'), /already exists/);
  await assert.rejects(importLocalFile(fs, 'file:///cache/source.txt', root, 'existing.txt'), /already exists/);
  await assert.rejects(
    renameLocalItem(fs, { uri: 'file:///cache/source.txt' }, root, 'existing.txt'),
    /already exists/
  );
  assert.equal(fs.files.get(`${root}existing.txt`), 'existing');
});

test('sorting preserves the input list while sorting by name, size, date, or type', () => {
  const entries = [
    { id: 'b', name: 'B.txt', size: 3, modifiedAt: 10, type: 'TXT' },
    { id: 'a', name: 'A.jpg', size: 9, modifiedAt: 20, type: 'JPG' },
  ];
  assert.deepEqual(sortEntries(entries, 'name').map(({ id }) => id), ['a', 'b']);
  assert.deepEqual(sortEntries(entries, 'size').map(({ id }) => id), ['a', 'b']);
  assert.deepEqual(sortEntries(entries, 'date').map(({ id }) => id), ['a', 'b']);
  assert.deepEqual(sortEntries(entries, 'type').map(({ id }) => id), ['a', 'b']);
  assert.deepEqual(entries.map(({ id }) => id), ['b', 'a']);
});

test('search is case-insensitive and visible selections exclude hidden items', () => {
  assert.equal(matchesSearch('Quarterly Report.PDF', 'report'), true);
  assert.equal(matchesSearch('Quarterly Report.PDF', 'image'), false);
  assert.equal(matchesSearch('anything', ''), true);

  const visible = [{ id: 'shown' }, { id: 'also-shown' }];
  assert.deepEqual(
    visibleSelectedItems(visible, ['hidden', 'shown']),
    [{ id: 'shown' }]
  );
});

test('opens only Android content URIs and grants the receiving app read access', async () => {
  let request;
  const result = await openWithCompatibleApp(
    'content://com.pocketfiles.app.FileSystemFileProvider/cache/report.pdf',
    'application/pdf',
    async (...args) => {
      request = args;
      return { resultCode: -1 };
    }
  );

  assert.deepEqual(request, [
    'android.intent.action.VIEW',
    {
      data: 'content://com.pocketfiles.app.FileSystemFileProvider/cache/report.pdf',
      type: 'application/pdf',
      flags: 1,
    },
  ]);
  assert.deepEqual(result, { resultCode: -1 });
  await assert.rejects(
    openWithCompatibleApp('file:///documents/report.pdf', 'application/pdf', async () => {}),
    /content URI/
  );
});

test('keeps file opening explicitly unavailable outside the Android implementation', async () => {
  await assert.rejects(openAndroidFile(), /Android app only/);
});
