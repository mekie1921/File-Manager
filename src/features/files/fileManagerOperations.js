const ANDROID_VIEW_ACTION = 'android.intent.action.VIEW';
const ANDROID_GRANT_READ_URI_PERMISSION = 1;

export function matchesSearch(value, search) {
  return !search || String(value || '').toLowerCase().includes(search.toLowerCase());
}

export function sortEntries(entries, sortMode) {
  const sortedEntries = [...entries];
  sortedEntries.sort((a, b) => {
    const nameA = a.name.toLowerCase();
    const nameB = b.name.toLowerCase();
    if (sortMode === 'size') return (b.size || 0) - (a.size || 0);
    if (sortMode === 'date') return (b.modifiedAt || 0) - (a.modifiedAt || 0);
    if (sortMode === 'type') return (a.type || '').localeCompare(b.type || '') || nameA.localeCompare(nameB);
    return nameA.localeCompare(nameB);
  });
  return sortedEntries;
}

export function visibleSelectedItems(visibleItems, selectedIds) {
  const selected = new Set(selectedIds);
  return visibleItems.filter((item) => selected.has(item.id));
}

function withoutTrailingSlash(uri) {
  return uri.endsWith('/') ? uri.slice(0, -1) : uri;
}

export function parentDirectoryUri(currentUri, rootUri) {
  const current = withoutTrailingSlash(currentUri);
  const root = withoutTrailingSlash(rootUri);
  if (current === root || !current.startsWith(`${root}/`)) return null;
  const separator = current.lastIndexOf('/');
  const parent = current.slice(0, separator);
  return `${parent}/`;
}

export function appDirectoryBreadcrumbs(currentUri, rootUri) {
  const root = withoutTrailingSlash(rootUri);
  const current = withoutTrailingSlash(currentUri);
  if (current !== root && !current.startsWith(`${root}/`)) {
    throw new Error('The current folder is outside PocketFiles app storage.');
  }

  const breadcrumbs = [{ name: 'Home', uri: `${root}/` }];
  if (current === root) return breadcrumbs;

  let path = `${root}/`;
  for (const name of current.slice(root.length + 1).split('/').filter(Boolean)) {
    path = `${path}${name}/`;
    breadcrumbs.push({ name, uri: path });
  }
  return breadcrumbs;
}

export async function listLocalFilesRecursively(fs, rootUri) {
  const pendingDirectories = [rootUri];
  const visitedDirectories = new Set();
  const files = [];

  while (pendingDirectories.length) {
    const directoryUri = pendingDirectories.pop();
    if (visitedDirectories.has(directoryUri)) continue;
    visitedDirectories.add(directoryUri);

    const children = await fs.readDirectoryAsync(directoryUri);
    for (let start = 0; start < children.length; start += 32) {
      const items = await Promise.all(
        children.slice(start, start + 32).map(async (name) => {
          const uri = `${directoryUri.endsWith('/') ? directoryUri : `${directoryUri}/`}${name}`;
          const info = await fs.getInfoAsync(uri);
          return { name, uri, info };
        })
      );
      for (const { name, uri, info } of items) {
        if (!info.exists) continue;
        if (info.isDirectory) {
          pendingDirectories.push(`${uri}/`);
        } else {
          files.push({
            id: uri,
            uri,
            name,
            isDirectory: false,
            size: info.size || 0,
            modifiedAt: info.modificationTime || info.lastModified || 0,
            path: directoryUri,
          });
        }
      }
    }
  }
  return files;
}

function requireValidItemName(name) {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.trim() === '.' ||
    name.trim() === '..' ||
    /[\/\\\u0000-\u001f]/.test(name)
  ) {
    throw new Error('Enter a valid name without path separators or control characters.');
  }
  return name.trim();
}

function childUri(directoryUri, name) {
  const separator = directoryUri.endsWith('/') ? '' : '/';
  return `${directoryUri}${separator}${name}`;
}

async function requireUnusedDestination(fs, uri, name) {
  const info = await fs.getInfoAsync(uri);
  if (info.exists) {
    throw new Error(`An item named "${name}" already exists in this folder.`);
  }
}

export async function createLocalFolder(fs, directoryUri, requestedName) {
  const name = requireValidItemName(requestedName);
  const destination = childUri(directoryUri, name);
  await requireUnusedDestination(fs, destination, name);
  await fs.makeDirectoryAsync(destination, { intermediates: true });
  return destination;
}

export async function importLocalFile(fs, sourceUri, directoryUri, requestedName, expectedSize = 0) {
  if (
    typeof sourceUri !== 'string' ||
    !(sourceUri.startsWith('file://') || sourceUri.startsWith('content://'))
  ) {
    throw new Error('The source file reference is invalid or unsupported.');
  }
  const name = requireValidItemName(requestedName);
  const destination = childUri(directoryUri, name);
  await requireUnusedDestination(fs, destination, name);
  const temporaryName = `.${Date.now()}-${name}.pending`;
  const temporaryDestination = childUri(directoryUri, temporaryName);
  let destinationCreated = false;
  try {
    await requireUnusedDestination(fs, temporaryDestination, temporaryName);
    await fs.copyAsync({ from: sourceUri, to: temporaryDestination });
    const temporaryInfo = await fs.getInfoAsync(temporaryDestination);
    if (!temporaryInfo.exists || temporaryInfo.isDirectory) {
      throw new Error('The copied file could not be verified.');
    }
    if (Number.isFinite(expectedSize) && expectedSize > 0 && temporaryInfo.size !== expectedSize) {
      throw new Error('The copied file size does not match the source file.');
    }
    await fs.moveAsync({ from: temporaryDestination, to: destination });
    destinationCreated = true;
    const savedInfo = await fs.getInfoAsync(destination);
    if (!savedInfo.exists || savedInfo.isDirectory) {
      throw new Error('The saved file could not be verified in its destination.');
    }
  } catch (error) {
    const cleanupErrors = [];
    for (const uri of [temporaryDestination, ...(destinationCreated ? [destination] : [])]) {
      try {
        const info = await fs.getInfoAsync(uri);
        if (info.exists) await fs.deleteAsync(uri);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError?.message || 'cleanup failed');
      }
    }
    if (cleanupErrors.length) {
      throw new Error(
        `${error?.message || 'The file could not be copied.'} Incomplete-file cleanup failed: ${cleanupErrors.join('; ')}`
      );
    }
    throw error;
  }
  return destination;
}

export async function renameLocalItem(fs, item, directoryUri, requestedName) {
  const name = requireValidItemName(requestedName);
  const destination = childUri(directoryUri, name);
  if (destination === item.uri) return destination;
  await requireUnusedDestination(fs, destination, name);
  await fs.moveAsync({ from: item.uri, to: destination });
  return destination;
}

export async function openWithCompatibleApp(contentUri, mimeType, startActivityAsync) {
  if (typeof contentUri !== 'string' || !contentUri.startsWith('content://')) {
    throw new Error('Android file opening requires a readable content URI.');
  }
  if (typeof startActivityAsync !== 'function') {
    throw new Error('Android file opening is unavailable in this app build.');
  }
  const params = {
    data: contentUri,
    flags: ANDROID_GRANT_READ_URI_PERMISSION,
  };
  if (typeof mimeType === 'string' && mimeType.trim()) params.type = mimeType.trim();
  return startActivityAsync(ANDROID_VIEW_ACTION, params);
}
