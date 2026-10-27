export const CATEGORY_CONFIG = [
  { key: 'images', label: 'Images', icon: '🖼️', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif'] },
  { key: 'videos', label: 'Videos', icon: '🎬', extensions: ['mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm', '3gp'] },
  { key: 'audio', label: 'Audio', icon: '🎵', extensions: ['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac', 'opus', 'wma'] },
  { key: 'documents', label: 'Documents', icon: '📄', extensions: ['pdf', 'txt', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'csv', 'odt', 'ods'] },
  { key: 'downloads', label: 'Downloads', icon: '⬇️', extensions: ['download', 'crdownload', 'part', 'partial'] },
  { key: 'archives', label: 'Archives', icon: '🗜️', extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'] },
  { key: 'applications', label: 'Applications', icon: '📱', extensions: ['apk', 'xapk', 'aab'] },
  { key: 'other', label: 'Other files', icon: '📦', extensions: [] },
];

const FILE_ICONS_BY_EXTENSION = {
  pdf: '📕',
  doc: '📘',
  docx: '📘',
  odt: '📘',
  xls: '📗',
  xlsx: '📗',
  ods: '📗',
  csv: '📊',
  ppt: '📙',
  pptx: '📙',
  txt: '📝',
  rtf: '📝',
  zip: '🗜️',
  rar: '🗜️',
  '7z': '🗜️',
  tar: '🗜️',
  gz: '🗜️',
  bz2: '🗜️',
  xz: '🗜️',
  apk: '📱',
  xapk: '📱',
  aab: '📱',
  download: '⬇️',
  crdownload: '⬇️',
  part: '⬇️',
  partial: '⬇️',
};

const MIME_CATEGORY_PREFIXES = [
  ['images', 'image/'],
  ['videos', 'video/'],
  ['audio', 'audio/'],
];

export function fileCategoryKey(item) {
  if (!item || item.isDirectory) return null;
  const mimeType = typeof item.mimeType === 'string' ? item.mimeType.toLowerCase() : '';
  const mimeCategory = MIME_CATEGORY_PREFIXES.find(([, prefix]) => mimeType.startsWith(prefix));
  if (mimeCategory) return mimeCategory[0];

  const extension = (item.name || '').split('.').pop()?.toLowerCase() || '';
  const category = CATEGORY_CONFIG.find(
    (candidate) => candidate.key !== 'other' && candidate.extensions.includes(extension)
  );
  return category?.key || 'other';
}

export function matchesFileCategory(item, categoryKey) {
  if (categoryKey === 'downloads' && /download/i.test(item?.path || '')) return true;
  return fileCategoryKey(item) === categoryKey;
}

export function fileIconForItem(item) {
  if (item?.isDirectory) return '📁';
  const extension = (item?.name || '').split('.').pop()?.toLowerCase() || '';
  if (FILE_ICONS_BY_EXTENSION[extension]) return FILE_ICONS_BY_EXTENSION[extension];
  return CATEGORY_CONFIG.find((category) => category.key === fileCategoryKey(item))?.icon || '📦';
}

export function collectionCategoryForFile(item) {
  const category = fileCategoryKey(item);
  return ['images', 'videos', 'documents'].includes(category) ? category : null;
}
