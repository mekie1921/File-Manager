import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_COLLECTIONS,
  emptyCollectionMetadata,
  normalizeCollectionMetadata,
  removeCollectionAssignments,
  renameCollectionPath,
  setCollectionMembership,
} from './fileCollections.js';

test('default collection labels match the requested lists exactly', () => {
  assert.deepEqual(DEFAULT_COLLECTIONS.images, ['My Photos', 'Family', 'Friends', 'Work', 'Other']);
  assert.deepEqual(DEFAULT_COLLECTIONS.videos, ['My Videos', 'Family', 'Friends', 'Work', 'Other']);
  assert.deepEqual(DEFAULT_COLLECTIONS.documents, ['My Videos', 'Family', 'Friends', 'Work', 'Other']);
  assert.ok(Object.values(DEFAULT_COLLECTIONS).flat().every((name) => name !== 'Travel'));
});

test('legacy Travel assignments are removed without touching files or other valid collections', () => {
  const result = normalizeCollectionMetadata({
    version: 1,
    assignments: {
      'file:///photos/old-trip.jpg': { images: ['Travel'] },
      'file:///photos/family.jpg': { images: ['Family', 'Travel'] },
      'file:///docs/notes.pdf': { documents: ['Work'] },
    },
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.metadata.assignments, {
    'file:///photos/family.jpg': { images: ['Family'] },
    'file:///docs/notes.pdf': { documents: ['Work'] },
  });
  assert.ok(result.metadata.assignments['file:///photos/old-trip.jpg'] === undefined);
});

test('collection assignments toggle independently of the original file and persist in metadata', () => {
  const uri = 'file:///documents/PocketFiles/photo.jpg';
  let metadata = emptyCollectionMetadata();
  metadata = setCollectionMembership(metadata, 'images', [uri], 'Family');
  assert.deepEqual(metadata.assignments[uri].images, ['Family']);
  metadata = setCollectionMembership(metadata, 'images', [uri], 'Friends');
  assert.deepEqual(metadata.assignments[uri].images, ['Family', 'Friends']);
  metadata = setCollectionMembership(metadata, 'images', [uri], 'Family');
  assert.deepEqual(metadata.assignments[uri].images, ['Friends']);
  metadata = setCollectionMembership(metadata, 'images', [uri], 'Family', true);
  metadata = setCollectionMembership(metadata, 'images', [uri], 'Family', true);
  assert.deepEqual(metadata.assignments[uri].images, ['Friends', 'Family']);
  assert.throws(() => setCollectionMembership(metadata, 'images', [uri], 'Travel'), /supported collection/);
});

test('renaming a folder updates descendant assignment keys and permanent deletion prunes keys', () => {
  const metadata = {
    version: 1,
    assignments: {
      'file:///files/Old/photo.jpg': { images: ['My Photos'] },
      'file:///files/Old/docs/report.pdf': { documents: ['Work'] },
    },
  };
  const renamed = renameCollectionPath(metadata, 'file:///files/Old', 'file:///files/New');
  assert.deepEqual(Object.keys(renamed.assignments).sort(), [
    'file:///files/New/docs/report.pdf',
    'file:///files/New/photo.jpg',
  ]);
  const pruned = removeCollectionAssignments(renamed, ['file:///files/New/photo.jpg']);
  assert.deepEqual(Object.keys(pruned.assignments), ['file:///files/New/docs/report.pdf']);
  const folderPruned = removeCollectionAssignments(renamed, ['file:///files/New']);
  assert.deepEqual(folderPruned.assignments, {});
});

test('malformed metadata is reported instead of silently overwritten', () => {
  assert.throws(
    () => normalizeCollectionMetadata({ version: 9, assignments: {} }),
    /invalid format/
  );
});
