import { fileCategoryKey } from './fileCategories.js';

export const MEDIA_QUERY_PAGE_SIZE = 100;

export const DEFAULT_DISCOVERY_SETTINGS = Object.freeze({
  autoDiscoveryEnabled: true,
  autoRefreshEnabled: true,
  autoCopyEnabled: false,
  autoCopyTypes: [],
});

const AUTO_COPY_TYPES = new Set([
  'images',
  'videos',
  'audio',
  'documents',
  'downloads',
  'archives',
  'applications',
  'other',
]);

export function normalizeDiscoverySettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_DISCOVERY_SETTINGS };
  }
  return {
    autoDiscoveryEnabled: value.autoDiscoveryEnabled !== false,
    autoRefreshEnabled: value.autoRefreshEnabled !== false,
    autoCopyEnabled: value.autoCopyEnabled === true,
    autoCopyTypes: [...new Set(
      (Array.isArray(value.autoCopyTypes) ? value.autoCopyTypes : [])
        .filter((type) => AUTO_COPY_TYPES.has(type))
    )],
  };
}

function mimeTypeForMedia(mediaType, filename = '') {
  const extension = filename.split('.').pop()?.toLowerCase() || '';
  if (mediaType === 'image') {
    return `image/${extension === 'jpg' ? 'jpeg' : extension || 'jpeg'}`;
  }
  if (mediaType === 'video') {
    return `video/${extension || 'mp4'}`;
  }
  if (mediaType === 'audio') {
    return `audio/${extension || 'mpeg'}`;
  }
  return null;
}

function mediaItemFromMetadata(metadata) {
  const name = metadata.filename || 'Untitled media';
  return {
    id: metadata.id,
    uri: metadata.id,
    name,
    isDirectory: false,
    size: Number.isFinite(metadata.fileSize) ? metadata.fileSize : 0,
    modifiedAt: metadata.modificationTime || metadata.creationTime || 0,
    mimeType: mimeTypeForMedia(metadata.mediaType, name),
    mediaType: metadata.mediaType,
    duration: metadata.duration || 0,
    storageKind: 'shared-media',
  };
}

export async function listAccessibleMedia(mediaLibrary, options = {}) {
  const pageSize = options.pageSize || MEDIA_QUERY_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error('Media query page size must be a positive integer.');
  }
  const { AssetField, MediaType, Query } = mediaLibrary;
  if (!AssetField || !MediaType || typeof Query !== 'function') {
    throw new Error('Android media discovery is unavailable in this app build.');
  }

  const results = [];
  const seen = new Set();
  for (const mediaType of [MediaType.IMAGE, MediaType.VIDEO, MediaType.AUDIO]) {
    for (let offset = 0; ; offset += pageSize) {
      const page = await new Query()
        .eq(AssetField.MEDIA_TYPE, mediaType)
        .orderBy(AssetField.CREATION_TIME)
        .limit(pageSize)
        .offset(offset)
        .exeForMetadata();
      if (!Array.isArray(page)) {
        throw new Error('Android returned an invalid media discovery result.');
      }
      for (const metadata of page) {
        if (!metadata?.id || seen.has(metadata.id)) continue;
        seen.add(metadata.id);
        results.push(mediaItemFromMetadata(metadata));
      }
      if (page.length < pageSize) break;
    }
  }
  return results;
}

export function mergeDiscoveredFiles(...groups) {
  const filesByUri = new Map();
  for (const group of groups) {
    for (const item of group || []) {
      if (item?.uri && !filesByUri.has(item.uri)) filesByUri.set(item.uri, item);
    }
  }
  return [...filesByUri.values()];
}

export function isEligibleForAutomaticCopy(item, types) {
  if (!item || item.isDirectory || !Array.isArray(types) || !types.length) return false;
  const selectedTypes = new Set(types);
  if (selectedTypes.has('downloads') && /download/i.test(item.path || '')) return true;
  return selectedTypes.has(fileCategoryKey(item));
}

export function getUniqueDestinationName(name, exists) {
  const dotIndex = name.lastIndexOf('.');
  const baseName = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  const extension = dotIndex > 0 ? name.slice(dotIndex) : '';
  for (let index = 0; index < 10000; index += 1) {
    const candidate = index === 0 ? name : `${baseName} (${index})${extension}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`Could not find an unused destination name for "${name}".`);
}

export async function copyEligibleFiles({
  files,
  settings,
  history,
  destinationUri,
  fileSystem,
  copyFile,
  saveHistory,
}) {
  const nextHistory = { ...(history || {}) };
  const copied = [];
  const failures = [];
  if (!settings?.autoCopyEnabled || !settings.autoCopyTypes?.length) {
    return { history: nextHistory, copied, failures };
  }

  const destinationNames = new Set();
  for (const item of files || []) {
    if (!isEligibleForAutomaticCopy(item, settings.autoCopyTypes)) continue;
    const sourceId = item.uri;
    if (!sourceId || !sourceId.startsWith('content://')) continue;
    const previous = nextHistory[sourceId];
    try {
      if (previous?.destinationUri) {
        const existing = await fileSystem.getInfoAsync(previous.destinationUri);
        if (existing.exists) {
          if (previous.status !== 'complete') {
            nextHistory[sourceId] = { ...previous, status: 'complete' };
            await saveHistory(nextHistory);
          }
          continue;
        }
        if (previous.status === 'complete') continue;
      }

      const name = await findAvailableDestinationName(
        item.name || 'Imported file',
        destinationUri,
        destinationNames,
        fileSystem
      );
      destinationNames.add(name);
      const outputUri = previous?.destinationUri || `${destinationUri}${name}`;
      nextHistory[sourceId] = { destinationUri: outputUri, status: 'pending' };
      await saveHistory(nextHistory);
      await copyFile(item, outputUri, item.size);
      const savedInfo = await fileSystem.getInfoAsync(outputUri);
      if (!savedInfo.exists || savedInfo.isDirectory) {
        throw new Error('The saved copy could not be verified in Best storage.');
      }
      nextHistory[sourceId] = { destinationUri: outputUri, status: 'complete' };
      await saveHistory(nextHistory);
      copied.push({ item, destinationUri: outputUri, size: savedInfo.size || 0 });
    } catch (error) {
      failures.push({ item, error: error?.message || 'The automatic copy failed.' });
    }
  }
  return { history: nextHistory, copied, failures };
}

async function findAvailableDestinationName(name, destinationUri, reservedNames, fileSystem) {
  return findAvailableFileName(name, destinationUri, fileSystem, reservedNames);
}

export async function findAvailableFileName(name, destinationUri, fileSystem, reservedNames = new Set()) {
  const dotIndex = name.lastIndexOf('.');
  const baseName = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  const extension = dotIndex > 0 ? name.slice(dotIndex) : '';
  for (let index = 0; index < 10000; index += 1) {
    const candidate = index === 0 ? name : `${baseName} (${index})${extension}`;
    if (reservedNames.has(candidate)) continue;
    const info = await fileSystem.getInfoAsync(`${destinationUri}${candidate}`);
    if (!info.exists) return candidate;
  }
  throw new Error(`Could not find an unused destination name for "${name}".`);
}

export function listAuthorizedFilesRecursively(rootUri, Directory) {
  const pendingDirectories = [rootUri];
  const visitedDirectories = new Set();
  const files = [];

  while (pendingDirectories.length) {
    const directoryUri = pendingDirectories.pop();
    if (visitedDirectories.has(directoryUri)) continue;
    visitedDirectories.add(directoryUri);
    const directory = new Directory(directoryUri);
    for (const item of directory.list()) {
      const isDirectory = item instanceof Directory;
      const info = item.info();
      if (!info.exists || !item.name) continue;
      if (isDirectory) {
        pendingDirectories.push(item.uri);
      } else {
        files.push({
          id: item.uri,
          uri: item.uri,
          name: item.name,
          isDirectory: false,
          size: info.size || 0,
          modifiedAt: info.modificationTime || info.lastModified || 0,
          mimeType: item.type || null,
          path: directoryUri,
          storageKind: 'authorized-folder',
        });
      }
    }
  }
  return files;
}
