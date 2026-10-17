export const DEFAULT_COLLECTIONS = Object.freeze({
  images: Object.freeze(['My Photos', 'Family', 'Friends', 'Work', 'Other']),
  videos: Object.freeze(['My Videos', 'Family', 'Friends', 'Work', 'Other']),
  documents: Object.freeze(['My Videos', 'Family', 'Friends', 'Work', 'Other']),
});

export function emptyCollectionMetadata() {
  return { version: 1, assignments: {} };
}

export function normalizeCollectionMetadata(input) {
  if (input === null || input === undefined) {
    return { metadata: emptyCollectionMetadata(), changed: false };
  }
  if (
    typeof input !== 'object' ||
    Array.isArray(input) ||
    (input.version !== undefined && input.version !== 1) ||
    !input.assignments ||
    typeof input.assignments !== 'object' ||
    Array.isArray(input.assignments)
  ) {
    throw new Error('Collection metadata has an invalid format. Existing data was left untouched.');
  }

  const assignments = {};
  let changed = input.version !== 1;
  for (const [uri, rawAssignment] of Object.entries(input.assignments)) {
    if (!uri || !rawAssignment || typeof rawAssignment !== 'object' || Array.isArray(rawAssignment)) {
      changed = true;
      continue;
    }
    const normalized = {};
    for (const [category, values] of Object.entries(rawAssignment)) {
      const allowed = DEFAULT_COLLECTIONS[category];
      if (!allowed) {
        changed = true;
        continue;
      }
      const safeValues = Array.isArray(values)
        ? [...new Set(values.filter((value) => typeof value === 'string' && allowed.includes(value)))]
        : [];
      if (!Array.isArray(values) || safeValues.length !== values.length) changed = true;
      if (safeValues.length) normalized[category] = safeValues;
    }
    if (Object.keys(normalized).length) assignments[uri] = normalized;
    else if (Object.keys(rawAssignment).length) changed = true;
  }

  const metadata = { version: 1, assignments };
  if (JSON.stringify(metadata) !== JSON.stringify(input)) changed = true;
  return { metadata, changed };
}

export function setCollectionMembership(metadata, category, uris, collection, shouldBeMember) {
  const allowed = DEFAULT_COLLECTIONS[category];
  if (!allowed || !allowed.includes(collection)) {
    throw new Error('Choose a supported collection for this file type.');
  }
  const assignments = { ...(metadata?.assignments || {}) };
  for (const uri of uris) {
    const current = { ...(assignments[uri] || {}) };
    const values = new Set(current[category] || []);
    if (shouldBeMember === undefined) {
      if (values.has(collection)) values.delete(collection);
      else values.add(collection);
    } else if (shouldBeMember) {
      values.add(collection);
    } else {
      values.delete(collection);
    }
    if (values.size) current[category] = [...values];
    else delete current[category];
    if (Object.keys(current).length) assignments[uri] = current;
    else delete assignments[uri];
  }
  return { version: 1, assignments };
}

export function renameCollectionPath(metadata, oldUri, newUri) {
  const assignments = {};
  for (const [uri, assignment] of Object.entries(metadata?.assignments || {})) {
    const renamedUri =
      uri === oldUri
        ? newUri
        : uri.startsWith(`${oldUri}/`)
          ? `${newUri}${uri.slice(oldUri.length)}`
          : uri;
    assignments[renamedUri] = assignment;
  }
  return { version: 1, assignments };
}

export function removeCollectionAssignments(metadata, uris) {
  const removed = [...new Set(uris)];
  return {
    version: 1,
    assignments: Object.fromEntries(
      Object.entries(metadata?.assignments || {}).filter(
        ([uri]) => !removed.some((removedUri) => uri === removedUri || uri.startsWith(`${removedUri}/`))
      )
    ),
  };
}
