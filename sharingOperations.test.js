import assert from 'node:assert/strict';
import test from 'node:test';
import { shareFilesOneAtATime } from './sharingOperations.js';

test('shares every selected file in order after individual confirmation', async () => {
  const files = [{ name: 'first.txt' }, { name: 'second.jpg' }, { name: 'third.pdf' }];
  const confirmations = [];
  const shared = [];

  const result = await shareFilesOneAtATime(
    files,
    async (file, index, total) => {
      confirmations.push([file.name, index, total]);
      return true;
    },
    async (file) => shared.push(file.name)
  );

  assert.deepEqual(confirmations, [
    ['first.txt', 0, 3],
    ['second.jpg', 1, 3],
    ['third.pdf', 2, 3],
  ]);
  assert.deepEqual(shared, ['first.txt', 'second.jpg', 'third.pdf']);
  assert.deepEqual(result, { completedCount: 3, stopped: false });
});

test('stops without sharing the next file when the user declines', async () => {
  const files = [{ name: 'first.txt' }, { name: 'second.jpg' }, { name: 'third.pdf' }];
  const shared = [];

  const result = await shareFilesOneAtATime(
    files,
    async (_file, index) => index === 0,
    async (file) => shared.push(file.name)
  );

  assert.deepEqual(shared, ['first.txt']);
  assert.deepEqual(result, { completedCount: 1, stopped: true });
});

test('does not continue after a share operation fails', async () => {
  const files = [{ name: 'first.txt' }, { name: 'second.jpg' }];
  let confirmationCount = 0;

  await assert.rejects(
    shareFilesOneAtATime(
      files,
      async () => {
        confirmationCount += 1;
        return true;
      },
      async () => {
        throw new Error('Share sheet failed');
      }
    ),
    /Share sheet failed/
  );
  assert.equal(confirmationCount, 1);
});
