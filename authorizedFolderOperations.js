function requireValidChildName(name) {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.trim() === '.' ||
    name.trim() === '..' ||
    /[\\/]/.test(name) ||
    /[\u0000-\u001f]/.test(name)
  ) {
    throw new Error('Enter a valid name without path separators or control characters.');
  }
  return name.trim();
}

function ensureUniqueName(name, entries) {
  if (entries.some((entry) => entry.name === name)) {
    throw new Error(`An item named "${name}" already exists in this folder.`);
  }
}

export function listAuthorizedDirectory(directoryUri, Directory) {
  const directory = new Directory(directoryUri);
  return directory.list().map((item) => {
    const isDirectory = item instanceof Directory;
    const info = item.info();
    if (!info.exists) {
      throw new Error('A listed item is no longer available. Refresh the folder and try again.');
    }
    if (!item.name) {
      throw new Error('The document provider did not return an item name.');
    }
    return {
      id: item.uri,
      uri: item.uri,
      name: item.name,
      isDirectory,
      size: info.size || 0,
      modifiedAt: info.modificationTime || info.lastModified || 0,
      mimeType: isDirectory ? null : item.type || null,
      path: directoryUri,
      storageKind: 'authorized-folder',
    };
  });
}

export async function createAuthorizedFolder(storageAccessFramework, directoryUri, requestedName, entries) {
  const name = requireValidChildName(requestedName);
  ensureUniqueName(name, entries);
  return storageAccessFramework.makeDirectoryAsync(directoryUri, name);
}

export async function deleteAuthorizedItem(storageAccessFramework, item) {
  await storageAccessFramework.deleteAsync(item.uri);
}

export async function copyFileIntoAuthorizedFolder(
  File,
  Directory,
  sourceUri,
  destinationUri,
  requestedName,
  entries
) {
  const name = requireValidChildName(requestedName);
  ensureUniqueName(name, entries);
  const source = new File(sourceUri);
  const destination = new File(new Directory(destinationUri), name);
  await source.copy(destination);
}

export function parentBreadcrumbs(stack, uri) {
  const uriIndex = stack.findIndex((entry) => entry.uri === uri);
  return uriIndex < 0 ? stack : stack.slice(0, uriIndex + 1);
}
