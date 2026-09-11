const launchKeys = new Set([
  'assignment', 'assignment_id', 'context', 'title', 'category', 'tags', 'source', 'ref'
]);

function clean(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

export function parseLaunchContext(search = '') {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(search);
  const assignmentName = clean(params.get('assignment'), 300);
  const context = assignmentName || clean(params.get('context'), 1000);
  if (!context) return null;

  const tags = clean(params.get('tags'), 500)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .slice(0, 20);

  return {
    context,
    title: clean(params.get('title'), 300) || assignmentName,
    category: clean(params.get('category'), 100) || (assignmentName ? 'Homework' : 'Unsorted'),
    tags,
    source: clean(params.get('source'), 100) || (assignmentName ? 'AndrewsHW Tracker' : 'URL launch'),
    external_ref: clean(params.get('assignment_id'), 300) || clean(params.get('ref'), 300),
    assignment_name: assignmentName
  };
}

export function launchSearchForPath(search = '') {
  const params = search instanceof URLSearchParams ? new URLSearchParams(search) : new URLSearchParams(search);
  params.delete('scope');
  return params.toString() ? `?${params}` : '';
}

export function clearLaunchContext(search = '') {
  const params = search instanceof URLSearchParams ? new URLSearchParams(search) : new URLSearchParams(search);
  for (const key of launchKeys) params.delete(key);
  return params.toString() ? `?${params}` : '';
}
