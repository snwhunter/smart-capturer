import { clearLaunchContext, launchSearchForPath, parseLaunchContext } from './launch-context.js';

const $ = selector => document.querySelector(selector);
const launchParams = new URLSearchParams(location.search);
const scope = location.pathname.startsWith('/work') || launchParams.get('scope') === 'work'
  ? 'work' : 'personal';
const inboxName = scope === 'work' ? 'Work / ToBeSorted' : 'Personal / ToBeSorted';
const recentKey = `smartCapturerRecent:${scope}`;

const state = {
  mode: 'image',
  text: '',
  analysis: null,
  launchContext: parseLaunchContext(launchParams),
  accessKey: localStorage.getItem('smartCapturerAccessKey') || '',
  processing: new Set()
};

async function apiFetch(url, options = {}) {
  options.headers = { ...(options.headers || {}), 'x-smart-capturer-key': state.accessKey };
  let response = await fetch(url, options);
  if (response.status === 401) {
    const key = prompt('Smart Capturer family access code:') || '';
    if (!key) throw new Error('Family access code required');
    state.accessKey = key;
    localStorage.setItem('smartCapturerAccessKey', key);
    options.headers = { ...(options.headers || {}), 'x-smart-capturer-key': key };
    response = await fetch(url, options);
    if (response.status === 401) {
      localStorage.removeItem('smartCapturerAccessKey');
      state.accessKey = '';
      throw new Error('Incorrect family access code');
    }
  }
  return response;
}

async function responseJsonOrThrow(response) {
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok) throw new Error(payload.error || payload.message || `Request failed (${response.status})`);
  return payload;
}

function loadRecent() {
  try { return JSON.parse(localStorage.getItem(recentKey) || '[]'); }
  catch { return []; }
}

function saveRecent(items) {
  localStorage.setItem(recentKey, JSON.stringify(items.slice(0, 30)));
}

function upsertRecent(item) {
  const items = loadRecent();
  const index = items.findIndex(entry => entry.id === item.id);
  if (index >= 0) items[index] = { ...items[index], ...item };
  else items.unshift(item);
  saveRecent(items);
  renderRecent();
}

function makeCaptureId() {
  return `${Date.now()}-${crypto.randomUUID()}`;
}

function openQueue() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('smartCapturerQueue', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('jobs', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function queuePut(job) {
  const db = await openQueue();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('jobs', 'readwrite');
    transaction.objectStore('jobs').put(job);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function queueDelete(id) {
  const db = await openQueue();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('jobs', 'readwrite');
    transaction.objectStore('jobs').delete(id);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function queueAll() {
  const db = await openQueue();
  const jobs = await new Promise((resolve, reject) => {
    const request = db.transaction('jobs').objectStore('jobs').getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return jobs;
}

async function thumbnailFor(file) {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = reject;
      element.src = objectUrl;
    });
    const size = 180;
    const scale = Math.min(size / image.naturalWidth, size / image.naturalHeight, 1);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', .68);
  } catch {
    return '';
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function enqueueImages(files) {
  const images = files.filter(file => !file.type || file.type.startsWith('image/'));
  if (!images.length) return setStatus('No image file was selected.');
  $('#cameraInput').value = '';
  $('#fileInput').value = '';
  setStatus(`${images.length} capture${images.length === 1 ? '' : 's'} queued. Ready for the next photo.`);

  for (const file of images) {
    const id = makeCaptureId();
    const entry = {
      id, scope, created_at: new Date().toISOString(), thumbnail: '',
      title: state.launchContext?.title || file.name || 'Photo',
      context: state.launchContext?.context || '',
      external_ref: state.launchContext?.external_ref || '',
      category: state.launchContext?.category || 'Unsorted', destination: inboxName, upload_status: 'queued', recognition_status: 'pending',
      workflow_status: 'to_be_sorted', message: 'Waiting to upload'
    };
    upsertRecent(entry);
    const thumbnail = await thumbnailFor(file);
    upsertRecent({ id, thumbnail });
    try {
      await queuePut({
        id, scope, file, name: file.name || 'capture.jpg', type: file.type || 'image/jpeg',
        created_at: entry.created_at,
        launch_context: state.launchContext ? { ...state.launchContext, tags: [...state.launchContext.tags] } : null
      });
    } catch {
      upsertRecent({ id, upload_status: 'failed', recognition_status: 'not_run', message: 'Could not queue this photo' });
    }
  }
  runQueue();
}

let activeWorkers = 0;
async function runQueue() {
  if (activeWorkers >= 2) return;
  const jobs = await queueAll().catch(() => []);
  const available = jobs.filter(job => job.scope === scope && !state.processing.has(job.id));
  while (activeWorkers < 2 && available.length) {
    const job = available.shift();
    activeWorkers += 1;
    state.processing.add(job.id);
    processJob(job).finally(() => {
      activeWorkers -= 1;
      state.processing.delete(job.id);
      runQueue();
    });
  }
}

async function processJob(job) {
  upsertRecent({ id: job.id, upload_status: 'uploading', message: `Uploading to ${inboxName}` });
  try {
    const file = await filePayload(job.file, job.name, job.type);
    const saved = await responseJsonOrThrow(await apiFetch('/api/save', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capture_id: job.id, scope,
        metadata: {
          kind: 'image', capture_status: 'saved', workflow_status: 'to_be_sorted',
          recognition_status: 'pending', destination: inboxName, original_filename: job.name,
          ...(job.launch_context || {})
        },
        files: [file]
      })
    }));
    upsertRecent({
      id: job.id, upload_status: 'saved', destination: saved.destination || inboxName,
      file_count: saved.file_count, bytes_saved: saved.bytes_saved, message: `Saved in ${saved.destination || inboxName}`
    });
    await queueDelete(job.id);
    await analyzeQueued(job, file);
  } catch (error) {
    upsertRecent({ id: job.id, upload_status: 'failed', recognition_status: 'not_run', message: error.message });
  }
}

async function analyzeQueued(job, file) {
  try {
    const result = await responseJsonOrThrow(await apiFetch('/api/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'image', file })
    }));
    const succeeded = result.source === 'gemini' || result.source === 'openai';
    const recognitionStatus = succeeded ? 'recognized' : result.source === 'local-fallback' ? 'not_run' : 'failed';
    const launch = job.launch_context || {};
    const tags = [...new Set([...(launch.tags || []), ...(Array.isArray(result.tags) ? result.tags : [])])];
    const patch = {
      recognition_status: recognitionStatus,
      category: launch.category || result.category,
      title: launch.title || result.title,
      context: launch.context || result.context,
      tags,
      confidence: result.confidence,
      destination_hint: result.destination_hint,
      extracted: result.extracted,
      analysis_source: result.source,
      analyzed_at: new Date().toISOString(),
      message: succeeded ? `Recognized as ${result.category}` : 'Saved; awaiting later recognition'
    };
    await responseJsonOrThrow(await apiFetch(`/api/captures/${job.id}?scope=${scope}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch)
    }));
    upsertRecent({ id: job.id, ...patch });
  } catch (error) {
    upsertRecent({ id: job.id, recognition_status: 'failed', message: `Saved; recognition failed: ${error.message}` });
  }
}

async function refreshStatuses() {
  if (!state.accessKey || document.hidden) return;
  const pending = loadRecent().filter(item => item.upload_status === 'saved' && item.workflow_status !== 'sorted').slice(0, 12);
  for (const item of pending) {
    try {
      const result = await responseJsonOrThrow(await apiFetch(`/api/captures/${item.id}?scope=${scope}`));
      const record = result.record || {};
      upsertRecent({
        id: item.id,
        title: record.title || item.title,
        category: record.category || item.category,
        destination: record.destination || item.destination,
        recognition_status: record.recognition_status || item.recognition_status,
        workflow_status: record.workflow_status || item.workflow_status,
        message: record.message || item.message
      });
    } catch {}
  }
}

function renderRecent() {
  const items = loadRecent();
  $('#recentList').innerHTML = items.length ? items.map(item => {
    const upload = item.upload_status === 'saved' ? 'Uploaded' : item.upload_status === 'uploading' ? 'Uploading…' : item.upload_status === 'failed' ? 'Upload failed' : 'Queued';
    const recognition = item.recognition_status === 'recognized' ? `Recognized${item.category ? `: ${item.category}` : ''}`
      : item.recognition_status === 'failed' ? 'Recognition failed'
      : item.recognition_status === 'not_run' ? 'Recognition waiting' : 'Recognition pending';
    return `<article class="recent-item ${esc(item.upload_status || 'queued')}">
      <div class="recent-thumb">${item.thumbnail?.startsWith('data:image/') ? `<img src="${esc(item.thumbnail)}" alt="Capture thumbnail">` : '<span>📷</span>'}</div>
      <div class="recent-body"><strong>${esc(item.title || 'Photo')}</strong>
        <span class="recent-meta">${esc(upload)} · ${esc(recognition)}</span>
        ${item.context ? `<span class="recent-context">${esc(item.context)}</span>` : ''}
        <span class="recent-destination">${esc(item.destination || inboxName)}</span>
        ${item.message ? `<span class="recent-message">${esc(item.message)}</span>` : ''}
      </div>
      <time>${new Date(item.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
    </article>`;
  }).join('') : '<p class="muted">Nothing captured yet.</p>';
}

const modes = [...document.querySelectorAll('.mode')];
const panes = { image: $('#imagePane'), link: $('#linkPane'), data: $('#dataPane') };
modes.forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));

function setMode(mode) {
  state.mode = mode;
  modes.forEach(button => button.classList.toggle('active', button.dataset.mode === mode));
  Object.entries(panes).forEach(([key, pane]) => pane.classList.toggle('active', key === mode));
  $('#contextCard').classList.add('hidden');
}

$('#cameraInput').addEventListener('change', event => enqueueImages([...event.target.files]));
$('#fileInput').addEventListener('change', event => enqueueImages([...event.target.files]));
$('#analyzeLink').addEventListener('click', () => analyzeText('link', $('#linkInput').value.trim()));
$('#analyzeData').addEventListener('click', () => analyzeText('data', $('#dataInput').value.trim()));

async function analyzeText(kind, text) {
  if (!text) return;
  state.text = text;
  setStatus('Analyzing context…');
  try {
    const result = await responseJsonOrThrow(await apiFetch('/api/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, text })
    }));
    fillContext(result);
  } catch (error) {
    setStatus(`Analysis unavailable: ${error.message}`);
  }
}

function fillContext(result) {
  const launch = state.launchContext || {};
  const merged = {
    ...result,
    category: launch.category || result.category,
    title: launch.title || result.title,
    context: launch.context || result.context,
    tags: [...new Set([...(launch.tags || []), ...(Array.isArray(result.tags) ? result.tags : [])])]
  };
  state.analysis = merged;
  $('#category').value = [...$('#category').options].some(option => option.value === merged.category) ? merged.category : 'Other';
  $('#title').value = merged.title || '';
  $('#context').value = merged.context || '';
  $('#tags').value = merged.tags.join(', ');
  $('#destination').value = result.destination_hint || inboxName;
  $('#confidence').textContent = `${Math.round((result.confidence || 0) * 100)}% guess`;
  $('#contextCard').classList.remove('hidden');
}

$('#saveCapture').addEventListener('click', async () => {
  const metadata = {
    kind: state.mode, category: $('#category').value, title: $('#title').value,
    context: $('#context').value, tags: $('#tags').value.split(',').map(value => value.trim()).filter(Boolean),
    destination: $('#destination').value || inboxName, original_text: state.text,
    recognition_status: state.analysis?.source === 'gemini' || state.analysis?.source === 'openai' ? 'recognized' : 'not_run',
    analysis_source: state.analysis?.source || 'none', extracted: state.analysis?.extracted || {},
    ...(state.launchContext || {})
  };
  try {
    $('#saveCapture').disabled = true;
    const saved = await responseJsonOrThrow(await apiFetch('/api/save', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope, metadata, files: [] })
    }));
    upsertRecent({ ...metadata, id: saved.id, scope, created_at: new Date().toISOString(), upload_status: 'saved', workflow_status: 'to_be_sorted' });
    $('#contextCard').classList.add('hidden');
    $('#linkInput').value = '';
    $('#dataInput').value = '';
    setStatus(`Saved in ${saved.destination || inboxName}.`);
  } catch (error) {
    setStatus(`Could not save: ${error.message}`);
  } finally {
    $('#saveCapture').disabled = false;
  }
});

$('#startOver').addEventListener('click', () => $('#contextCard').classList.add('hidden'));

function setStatus(text) {
  $('#status').textContent = text;
  $('#status').classList.remove('hidden');
}

async function filePayload(file, fallbackName, fallbackType) {
  return {
    name: file.name || fallbackName,
    type: file.type || fallbackType,
    size: file.size,
    lastModified: file.lastModified,
    dataUrl: await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Could not read image'));
      reader.readAsDataURL(file);
    })
  };
}

function esc(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

$('#scopeName').textContent = scope === 'work' ? 'WORK CAPTURE' : 'PERSONAL CAPTURE';
$('#scopeSwitch').textContent = scope === 'work' ? 'Switch to personal' : 'Switch to work';
$('#scopeSwitch').href = `${scope === 'work' ? '/capture' : '/work'}${launchSearchForPath(launchParams)}`;
$('#captureDestination').textContent = inboxName;

function renderLaunchContext() {
  const card = $('#launchContext');
  if (!state.launchContext) return card.classList.add('hidden');
  $('#launchContextType').textContent = state.launchContext.assignment_name ? 'ASSIGNMENT CONTEXT' : 'PRELOADED CONTEXT';
  $('#launchContextName').textContent = state.launchContext.context;
  $('#launchContextMeta').textContent = [state.launchContext.category, state.launchContext.source, state.launchContext.external_ref]
    .filter(Boolean).join(' · ');
  card.classList.remove('hidden');
}

$('#clearLaunchContext').addEventListener('click', () => {
  state.launchContext = null;
  history.replaceState(null, '', `${location.pathname}${clearLaunchContext(location.search)}`);
  $('#scopeSwitch').href = scope === 'work' ? '/capture' : '/work';
  renderLaunchContext();
  setStatus('Preloaded context cleared. New captures will be unsorted.');
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').then(registration => registration.update()).catch(() => {});
renderRecent();
renderLaunchContext();
runQueue();
refreshStatuses();
setInterval(refreshStatuses, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { runQueue(); refreshStatuses(); } });
