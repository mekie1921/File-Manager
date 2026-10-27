import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeRecentActivity,
  recordRecentActivity,
  removeRecentActivity,
  loadRecentActivity,
  saveRecentActivity,
} from './recentActivity.js';

test('normalizeRecentActivity sorts persisted entries and removes duplicate URIs', () => {
  const records = normalizeRecentActivity([
    { uri: 'file://b', name: 'B.txt', activityAt: 100 },
    { uri: 'file://a', name: 'A.txt', activityAt: 300 },
    { uri: 'file://b', name: 'B.txt', activityAt: 200 },
  ]);
  assert.deepEqual(records.map((record) => record.uri), ['file://a', 'file://b']);
});

test('recordRecentActivity updates the existing entry without duplication', () => {
  const initial = [{ uri: 'file://a', name: 'A.txt', activityAt: 100 }];
  const records = recordRecentActivity(initial, { uri: 'file://a', name: 'A.txt', size: 42 }, 500);
  assert.equal(records.length, 1);
  assert.equal(records[0].activityAt, 500);
  assert.equal(records[0].size, 42);
});

test('removeRecentActivity never deletes the underlying URI', () => {
  const initial = [{ uri: 'file://a', activityAt: 100 }, { uri: 'file://b', activityAt: 200 }];
  assert.deepEqual(removeRecentActivity(initial, 'file://a').map((record) => record.uri), ['file://b']);
});

test('loadRecentActivity restores entries and saveRecentActivity persists normalized records', async () => {
  let stored;
  const fs = {
    async getInfoAsync() { return { exists: Boolean(stored) }; },
    async readAsStringAsync() { return stored; },
    async writeAsStringAsync(_uri, value) { stored = value; },
  };
  assert.deepEqual(await loadRecentActivity(fs, 'file://index'), []);
  await saveRecentActivity(fs, 'file://index', [{ uri: 'file://a', activityAt: 1 }]);
  assert.deepEqual(await loadRecentActivity(fs, 'file://index'), [{
    uri: 'file://a', name: '', mimeType: '', size: 0, activityAt: 1, accessible: true,
  }]);
});

test('recording an inaccessible file keeps its metadata without throwing', () => {
  const records = recordRecentActivity([], { uri: 'content://revoked/file', name: 'revoked.pdf', accessible: false }, 700);
  assert.equal(records.length, 1);
  assert.equal(records[0].activityAt, 700);
});

test('malformed and missing recent records return a safe empty list', async () => {
  assert.deepEqual(normalizeRecentActivity(null), []);
  const fs = {
    async getInfoAsync() { throw new Error('revoked permission'); },
  };
  await assert.rejects(() => loadRecentActivity(fs, 'file://index'), /revoked permission/);
});
