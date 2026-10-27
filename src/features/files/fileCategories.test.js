import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CATEGORY_CONFIG,
  collectionCategoryForFile,
  fileCategoryKey,
  fileIconForItem,
  matchesFileCategory,
} from './fileCategories.js';

test('classifies media, documents, downloads, archives, applications and unknown files', () => {
  const cases = [
    ['photo.heic', 'images'],
    ['clip.mp4', 'videos'],
    ['song.flac', 'audio'],
    ['report.pdf', 'documents'],
    ['partial.crdownload', 'downloads'],
    ['bundle.zip', 'archives'],
    ['app.apk', 'applications'],
    ['opaque.bin', 'other'],
  ];
  for (const [name, expected] of cases) {
    assert.equal(fileCategoryKey({ name, isDirectory: false }), expected);
  }
  assert.equal(fileCategoryKey({ name: 'folder', isDirectory: true }), null);
  assert.equal(fileCategoryKey({ name: 'unknown.bin', mimeType: 'image/heic' }), 'images');
});

test('provides exactly the requested default collection categories without Travel', () => {
  assert.deepEqual(CATEGORY_CONFIG.map(({ key }) => key), [
    'images',
    'videos',
    'audio',
    'documents',
    'downloads',
    'archives',
    'applications',
    'other',
  ]);
  assert.equal(matchesFileCategory({ name: 'note.txt' }, 'documents'), true);
  const downloadedPdf = { name: 'report.pdf', path: 'content://provider/tree/primary%3ADownload' };
  assert.equal(fileCategoryKey(downloadedPdf), 'documents');
  assert.equal(matchesFileCategory(downloadedPdf, 'downloads'), true);
  assert.equal(collectionCategoryForFile({ name: 'note.txt' }), 'documents');
  assert.equal(collectionCategoryForFile({ name: 'pack.zip' }), null);
});

test('uses a matching icon for each common file type and folders', () => {
  const cases = [
    [{ name: 'photo.png' }, '🖼️'],
    [{ name: 'clip.mp4' }, '🎬'],
    [{ name: 'song.mp3' }, '🎵'],
    [{ name: 'report.pdf' }, '📕'],
    [{ name: 'notes.txt' }, '📝'],
    [{ name: 'budget.xlsx' }, '📗'],
    [{ name: 'slides.pptx' }, '📙'],
    [{ name: 'bundle.zip' }, '🗜️'],
    [{ name: 'app.apk' }, '📱'],
    [{ name: 'partial.crdownload' }, '⬇️'],
    [{ name: 'unknown.bin' }, '📦'],
    [{ name: 'folder', isDirectory: true }, '📁'],
  ];
  for (const [item, expected] of cases) {
    assert.equal(fileIconForItem(item), expected, item.name);
  }
});
