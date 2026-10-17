let operationQueue = Promise.resolve();
let idSequence = 0;

function serialize(operation) {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.catch(() => {});
  return result;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function uniqueId() {
  idSequence += 1;
  return `trash-${Date.now().toString(36)}-${idSequence.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function writeIndex(fs, indexUri, entries) {
  const tempUri = `${indexUri}.tmp-${uniqueId()}`;
  const backupUri = `${indexUri}.bak`;
  let hasBackup = false;

  await fs.writeAsStringAsync(tempUri, JSON.stringify(entries), { encoding: 'utf8' });
  const currentIndex = await fs.getInfoAsync(indexUri);
  if (currentIndex.exists) {
    await fs.moveAsync({ from: indexUri, to: backupUri });
    hasBackup = true;
  }

  try {
    await fs.moveAsync({ from: tempUri, to: indexUri });
  } catch (error) {
    if (hasBackup) {
      try {
        await fs.moveAsync({ from: backupUri, to: indexUri });
      } catch (restoreError) {
        throw new Error(
          `Could not replace recycle-bin metadata (${errorText(error)}); recovery backup could not be restored (${errorText(restoreError)}).`
        );
      }
    }
    throw error;
  }

  if (hasBackup) {
    try {
      await fs.deleteAsync(backupUri, { idempotent: true });
      return null;
    } catch (error) {
      return `Recycle-bin metadata was saved, but its temporary recovery copy could not be removed: ${errorText(error)}`;
    }
  }
  return null;
}

async function readIndex(fs, indexUri) {
  const indexInfo = await fs.getInfoAsync(indexUri);
  const backupUri = `${indexUri}.bak`;
  const backupInfo = await fs.getInfoAsync(backupUri);

  if (!indexInfo.exists && backupInfo.exists) {
    await fs.moveAsync({ from: backupUri, to: indexUri });
  } else if (indexInfo.exists && backupInfo.exists) {
    await fs.deleteAsync(backupUri, { idempotent: true });
  }

  const recoveredIndexInfo = await fs.getInfoAsync(indexUri);
  if (!recoveredIndexInfo.exists) return { entries: [], changed: false };

  const raw = await fs.readAsStringAsync(indexUri, { encoding: 'utf8' });
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('Recycle-bin metadata has an invalid format. Its contents were left untouched.');
  }

  const records = [];
  const seenIds = new Set();
  let changed = false;
  for (const entry of parsed) {
    if (
      !entry ||
      typeof entry.name !== 'string' ||
      typeof entry.uri !== 'string' ||
      typeof entry.originalUri !== 'string'
    ) {
      throw new Error('Recycle-bin metadata contains an invalid record. Its contents were left untouched.');
    }
    let id = typeof entry.id === 'string' && entry.id ? entry.id : entry.uri;
    if (seenIds.has(id)) {
      changed = true;
      do {
        id = uniqueId();
      } while (seenIds.has(id));
    }
    seenIds.add(id);
    const state = entry.state || 'trashed';
    if (id !== entry.id || state !== entry.state) changed = true;
    records.push({ ...entry, id, state });
  }

  return { entries: records, changed };
}

async function recoverEntries(fs, indexUri, trashRoot) {
  const indexData = await readIndex(fs, indexUri);
  const entries = indexData.entries;
  const recovered = [];
  let changed = indexData.changed;

  for (const entry of entries) {
    if (entry.state === 'pending' || entry.state === 'restoring' || entry.state === 'deleting') {
      const [trashInfo, originalInfo] = await Promise.all([
        fs.getInfoAsync(entry.uri),
        fs.getInfoAsync(entry.originalUri),
      ]);

      if (entry.state === 'deleting' && !trashInfo.exists) {
        changed = true;
        continue;
      }
      if (entry.state === 'restoring') {
        if (!trashInfo.exists && originalInfo.exists) {
          changed = true;
          continue;
        }
        if (trashInfo.exists) {
          entry.state = 'trashed';
          changed = true;
        } else {
          entry.state = 'missing';
          changed = true;
        }
      } else if (trashInfo.exists) {
        entry.state = 'trashed';
        changed = true;
      } else if (originalInfo.exists) {
        changed = true;
        continue;
      } else {
        entry.state = 'missing';
        changed = true;
      }
    }
    recovered.push(entry);
  }

  if (changed) {
    const warning = await writeIndex(fs, indexUri, recovered);
    return { entries: recovered, warning };
  }
  return { entries: recovered, warning: null };
}

async function createUniqueTrashTarget(fs, trashRoot, entries) {
  const ids = new Set(entries.map((entry) => entry.id));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = uniqueId();
    const uri = `${trashRoot}${id}`;
    if (ids.has(id)) continue;
    const targetInfo = await fs.getInfoAsync(uri);
    if (!targetInfo.exists) return { id, uri };
  }
  throw new Error('Could not allocate a unique recycle-bin file ID. Please retry.');
}

async function persistOrThrow(fs, indexUri, entries) {
  try {
    return await writeIndex(fs, indexUri, entries);
  } catch (error) {
    throw new Error(`Recycle-bin metadata could not be saved: ${errorText(error)}`);
  }
}

export function loadTrashEntries(fs, indexUri, trashRoot) {
  return serialize(async () => recoverEntries(fs, indexUri, trashRoot));
}

export function moveToTrash(fs, item, indexUri, trashRoot) {
  return serialize(async () => {
    const { entries } = await recoverEntries(fs, indexUri, trashRoot);
    const target = await createUniqueTrashTarget(fs, trashRoot, entries);
    const entry = {
      id: target.id,
      name: item.name,
      uri: target.uri,
      originalUri: item.uri,
      movedAt: Date.now(),
      state: 'pending',
      isDirectory: Boolean(item.isDirectory),
    };

    const pendingEntries = [...entries, entry];
    let warning = await persistOrThrow(fs, indexUri, pendingEntries);

    try {
      await fs.moveAsync({ from: item.uri, to: entry.uri });
    } catch (error) {
      try {
        warning = await persistOrThrow(
          fs,
          indexUri,
          pendingEntries.filter((record) => record.id !== entry.id)
        ) || warning;
      } catch (metadataError) {
        throw new Error(
          `Could not move "${item.name}" to the recycle bin: ${errorText(error)}. Its pending metadata will be reconciled on the next refresh (${errorText(metadataError)}).`
        );
      }
      throw new Error(`Could not move "${item.name}" to the recycle bin: ${errorText(error)}`);
    }

    const trashedEntries = pendingEntries.map((record) =>
      record.id === entry.id ? { ...record, state: 'trashed' } : record
    );
    try {
      warning = await persistOrThrow(fs, indexUri, trashedEntries) || warning;
    } catch (error) {
      return {
        entry: { ...entry, state: 'pending' },
        warning: `The file was moved to the recycle bin, but metadata finalization failed. The pending record will be recovered on refresh: ${errorText(error)}`,
      };
    }
    return { entry: { ...entry, state: 'trashed' }, warning };
  });
}

export async function moveItemsToTrash(fs, items, indexUri, trashRoot) {
  const results = [];
  for (const item of items) {
    try {
      results.push({ item, success: true, ...(await moveToTrash(fs, item, indexUri, trashRoot)) });
    } catch (error) {
      results.push({ item, success: false, error: errorText(error) });
    }
  }
  return results;
}

export function restoreFromTrash(fs, id, indexUri, trashRoot) {
  return serialize(async () => {
    const { entries } = await recoverEntries(fs, indexUri, trashRoot);
    const entry = entries.find((record) => record.id === id);
    if (!entry) throw new Error('This recycle-bin item is no longer available.');

    const trashedInfo = await fs.getInfoAsync(entry.uri);
    if (!trashedInfo.exists) {
      throw new Error(`"${entry.name}" is missing from the recycle bin and cannot be restored.`);
    }
    const originalInfo = await fs.getInfoAsync(entry.originalUri);
    if (originalInfo.exists) {
      throw new Error(`Cannot restore "${entry.name}": an item already exists at its original location.`);
    }

    const separator = entry.originalUri.lastIndexOf('/');
    const parentUri = separator >= 0 ? entry.originalUri.slice(0, separator + 1) : '';
    if (parentUri) {
      const parentInfo = await fs.getInfoAsync(parentUri);
      if (!parentInfo.exists) {
        await fs.makeDirectoryAsync(parentUri, { intermediates: true });
      }
    }

    const restoringEntries = entries.map((record) =>
      record.id === id ? { ...record, state: 'restoring' } : record
    );
    let warning = await persistOrThrow(fs, indexUri, restoringEntries);

    try {
      await fs.moveAsync({ from: entry.uri, to: entry.originalUri });
    } catch (error) {
      try {
        warning = await persistOrThrow(fs, indexUri, entries) || warning;
      } catch (metadataError) {
        throw new Error(
          `Could not restore "${entry.name}": ${errorText(error)}. Its recycle-bin state will be reconciled on refresh (${errorText(metadataError)}).`
        );
      }
      throw new Error(`Could not restore "${entry.name}": ${errorText(error)}`);
    }

    const remainingEntries = restoringEntries.filter((record) => record.id !== id);
    try {
      warning = await persistOrThrow(fs, indexUri, remainingEntries) || warning;
    } catch (error) {
      return {
        entry,
        warning: `"${entry.name}" was restored, but its recycle-bin record could not be finalized. It will be reconciled on refresh: ${errorText(error)}`,
      };
    }

    return { entry, warning };
  });
}

export function permanentlyDelete(fs, id, indexUri, trashRoot) {
  return serialize(async () => {
    const { entries } = await recoverEntries(fs, indexUri, trashRoot);
    const entry = entries.find((record) => record.id === id);
    if (!entry) throw new Error('This recycle-bin item is no longer available.');

    const deletingEntries = entries.map((record) =>
      record.id === id ? { ...record, state: 'deleting' } : record
    );
    let warning = await persistOrThrow(fs, indexUri, deletingEntries);

    try {
      await fs.deleteAsync(entry.uri, { idempotent: true });
    } catch (error) {
      try {
        warning = await persistOrThrow(fs, indexUri, entries) || warning;
      } catch (metadataError) {
        throw new Error(
          `Could not permanently delete "${entry.name}": ${errorText(error)}. Its recycle-bin state will be reconciled on refresh (${errorText(metadataError)}).`
        );
      }
      throw new Error(`Could not permanently delete "${entry.name}": ${errorText(error)}`);
    }

    const remainingEntries = deletingEntries.filter((record) => record.id !== id);
    try {
      warning = await persistOrThrow(fs, indexUri, remainingEntries) || warning;
    } catch (error) {
      return {
        entry,
        warning: `"${entry.name}" was permanently deleted, but its recycle-bin record could not be finalized. It will be reconciled on refresh: ${errorText(error)}`,
      };
    }
    return { entry, warning };
  });
}
