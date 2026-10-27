export const RECENT_ACTIVITY_LIMIT = 50;

export function normalizeRecentActivity(records, limit = RECENT_ACTIVITY_LIMIT) {
  if (!Array.isArray(records)) return [];

  const byUri = new Map();
  for (const record of records) {
    if (!record || typeof record.uri !== 'string' || !record.uri) continue;
    const activityAt = Number.isFinite(record.activityAt) ? record.activityAt : 0;
    const previous = byUri.get(record.uri);
    if (!previous || activityAt >= previous.activityAt) {
      byUri.set(record.uri, {
        uri: record.uri,
        name: typeof record.name === 'string' ? record.name : '',
        mimeType: typeof record.mimeType === 'string' ? record.mimeType : '',
        size: Number.isFinite(record.size) ? record.size : 0,
        activityAt,
        accessible: record.accessible !== false,
      });
    }
  }

  return [...byUri.values()]
    .sort((left, right) => right.activityAt - left.activityAt)
    .slice(0, limit);
}

export function recordRecentActivity(records, item, activityAt = Date.now(), limit = RECENT_ACTIVITY_LIMIT) {
  if (!item || typeof item.uri !== 'string' || !item.uri) return normalizeRecentActivity(records, limit);
  const existing = normalizeRecentActivity(records, limit);
  return normalizeRecentActivity([
    ...existing.filter((record) => record.uri !== item.uri),
    {
      uri: item.uri,
      name: typeof item.name === 'string' ? item.name : '',
      mimeType: typeof item.mimeType === 'string' ? item.mimeType : '',
      size: Number.isFinite(item.size) ? item.size : 0,
      activityAt: Number.isFinite(activityAt) ? activityAt : Date.now(),
      accessible: true,
    },
  ], limit);
}

export function removeRecentActivity(records, uri, limit = RECENT_ACTIVITY_LIMIT) {
  return normalizeRecentActivity(
    normalizeRecentActivity(records, limit).filter((record) => record.uri !== uri),
    limit
  );
}

export async function loadRecentActivity(fileSystem, indexUri, limit = RECENT_ACTIVITY_LIMIT) {
  const info = await fileSystem.getInfoAsync(indexUri);
  if (!info.exists) return [];
  const raw = await fileSystem.readAsStringAsync(indexUri, { encoding: 'utf8' });
  return normalizeRecentActivity(JSON.parse(raw), limit);
}

export async function saveRecentActivity(fileSystem, indexUri, records, limit = RECENT_ACTIVITY_LIMIT) {
  const normalized = normalizeRecentActivity(records, limit);
  await fileSystem.writeAsStringAsync(indexUri, JSON.stringify(normalized), { encoding: 'utf8' });
  return normalized;
}
