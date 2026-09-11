import { captureButtonLabel, clearLaunchContext, launchSearchForPath, parseLaunchContext } from './launch-context.js?v=5';

const $ = selector => document.querySelector(selector);
const launchParams = new URLSearchParams(location.search);
const scope = location.pathname.startsWith('/work') || launchParams.get('scope') === 'work'
  ? 'work' : 'personal';
const recordMatch = location.pathname.match(/^\/record\/([a-zA-Z0-9-]{10,120})$/);
const recordId = recordMatch?.[1] || '';
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
  const contextName = state.launchContext?.assignment_name || state.launchContext?.context;
  setStatus(`${images.length} capture${images.length === 1 ? '' : 's'} queued${contextName ? ` for ${contextName}` : ''}. Ready for the next photo.`);

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

async function enqueueText(kind, text) {
  if (!text) return setStatus(`Enter ${kind === 'link' ? 'a link' : 'some data'} first.`);
  if (text.length > 200000) return setStatus('This item is too large. Keep link or data captures under 200,000 characters.');
  const id = makeCaptureId();
  const contextName = state.launchContext?.assignment_name || state.launchContext?.context || '';
  const title = state.launchContext?.title || (kind === 'link' ? text.slice(0, 300) : text.replace(/\s+/g, ' ').slice(0, 80)) || `New ${kind}`;
  const entry = {
    id, scope, kind, created_at: new Date().toISOString(), thumbnail: '', title,
    context: state.launchContext?.context || '', external_ref: state.launchContext?.external_ref || '',
    category: state.launchContext?.category || 'Unsorted', destination: inboxName,
    upload_status: 'queued', recognition_status: 'pending', processing_status: 'queued', workflow_status: 'to_be_sorted',
    message: `Waiting to save ${kind}`
  };
  upsertRecent(entry);
  if (kind === 'link') $('#linkInput').value = '';
  else $('#dataInput').value = '';
  setStatus(`${kind === 'link' ? 'Link' : 'Data'} queued${contextName ? ` for ${contextName}` : ''}. Ready for the next item.`);
  try {
    await queuePut({
      id, scope, kind, text, created_at: entry.created_at,
      launch_context: state.launchContext ? { ...state.launchContext, tags: [...state.launchContext.tags] } : null
    });
    runQueue();
  } catch {
    upsertRecent({ id, upload_status: 'failed', recognition_status: 'not_run', message: `Could not queue this ${kind}` });
  }
}

let activeWorkers = 0;
async function runQueue() {
  if (activeWorkers >= 2) return;
  const jobs = await queueAll().catch(() => []);
  const available = jobs.filter(job => job.scope === scope && !state.processing.has(job.id) && (!job.next_attempt_at || job.next_attempt_at <= Date.now()));
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
  const kind = job.kind || 'image';
  let stored = job.stage === 'saved';
  if (kind !== 'image' && job.stage === 'saved') {
    try {
      await processSavedRecord(job);
      await queueDelete(job.id);
    } catch {
      const attempts = (job.attempts || 0) + 1;
      const delay = Math.min(60000, 5000 * 2 ** Math.min(attempts - 1, 4));
      await queuePut({ ...job, attempts, next_attempt_at: Date.now() + delay });
      setTimeout(runQueue, delay);
    }
    return;
  }
  upsertRecent({ id: job.id, upload_status: 'uploading', message: `Uploading to ${inboxName}` });
  try {
    const file = kind === 'image' ? await filePayload(job.file, job.name, job.type) : null;
    const launch = job.launch_context || {};
    const saved = await responseJsonOrThrow(await apiFetch('/api/save', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capture_id: job.id, scope,
        metadata: {
          kind, capture_status: 'saved', workflow_status: 'to_be_sorted',
          recognition_status: 'pending', processing_status: kind === 'image' ? undefined : 'queued', destination: inboxName,
          original_filename: kind === 'image' ? job.name : undefined,
          original_text: kind === 'image' ? undefined : job.text,
          context_locked: Boolean(job.launch_context),
          title: launch.title || (kind === 'link' ? job.text?.slice(0, 300) : job.text?.replace(/\s+/g, ' ').slice(0, 80)),
          category: launch.category || 'Unsorted',
          ...launch
        },
        files: file ? [file] : []
      })
    }));
    upsertRecent({
      id: job.id, upload_status: 'saved', destination: saved.destination || inboxName,
      file_count: saved.file_count, bytes_saved: saved.bytes_saved, message: `Saved in ${saved.destination || inboxName}`
    });
    stored = true;
    if (kind === 'image') {
      await queueDelete(job.id);
      await analyzeQueued(job, file);
    } else {
      await queuePut({ ...job, stage: 'saved', attempts: 0, next_attempt_at: 0 });
      await processSavedRecord(job);
      await queueDelete(job.id);
    }
  } catch (error) {
    if (stored && kind !== 'image') return;
    upsertRecent({ id: job.id, upload_status: 'failed', recognition_status: 'not_run', message: error.message });
  }
}

async function processSavedRecord(job) {
  upsertRecent({ id: job.id, workflow_status: 'processing', recognition_status: 'pending', message: 'Saved; backend processing started' });
  try {
    const result = await responseJsonOrThrow(await apiFetch(`/api/captures/${job.id}/process?scope=${scope}`, {
      method: 'POST', keepalive: true
    }));
    const record = result.record || {};
    upsertRecent({ id: job.id, ...record, upload_status: 'saved', message: record.message || 'Backend processing complete' });
  } catch (error) {
    upsertRecent({ id: job.id, upload_status: 'saved', processing_status: 'failed', workflow_status: 'to_be_sorted', recognition_status: 'failed', message: `Saved; backend processing will retry: ${error.message}` });
    throw error;
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
        processing_status: record.processing_status || item.processing_status,
        workflow_status: record.workflow_status || item.workflow_status,
        review_status: record.review_status || item.review_status,
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
    const icon = item.kind === 'link' ? '🔗' : item.kind === 'data' ? '✍️' : '📷';
    const saved = item.upload_status === 'saved';
    const tag = saved ? 'a' : 'article';
    const href = saved ? ` href="${esc(recordHref(item.id))}"` : '';
    return `<${tag} class="recent-item ${esc(item.upload_status || 'queued')}"${href}>
      <div class="recent-thumb">${item.thumbnail?.startsWith('data:image/') ? `<img src="${esc(item.thumbnail)}" alt="Capture thumbnail">` : `<span>${icon}</span>`}</div>
      <div class="recent-body"><strong>${esc(item.title || 'Photo')}</strong>
        <span class="recent-meta">${esc(upload)} · ${esc(recognition)} · ${esc(workflowLabel(item))}</span>
        ${item.context ? `<span class="recent-context">${esc(item.context)}</span>` : ''}
        <span class="recent-destination">${esc(item.destination || inboxName)}</span>
        ${item.message ? `<span class="recent-message">${esc(item.message)}</span>` : ''}
      </div>
      <time>${new Date(item.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
    </${tag}>`;
  }).join('') : '<p class="muted">Nothing captured yet.</p>';
}

function workflowLabel(item) {
  if (item.review_status === 'validated') return 'Edits validated';
  if (item.processing_status === 'processing') return 'Backend processing';
  if (item.processing_status === 'complete') return 'AI processed';
  if (item.processing_status === 'waiting_for_ai') return 'Awaiting AI';
  if (item.processing_status === 'failed') return 'Processing failed';
  if (item.workflow_status === 'reviewed') return 'Reviewed';
  if (item.workflow_status === 'sorted') return 'Sorted';
  return 'To be sorted';
}

function recordHref(id) {
  const params = new URLSearchParams(launchParams);
  params.set('scope', scope);
  return `/record/${encodeURIComponent(id)}?${params}`;
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
$('#analyzeLink').addEventListener('click', () => enqueueText('link', $('#linkInput').value.trim()));
$('#analyzeData').addEventListener('click', () => enqueueText('data', $('#dataInput').value.trim()));

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
  const captureCard = $('.capture-card');
  if (!state.launchContext) {
    card.classList.add('hidden');
    captureCard.classList.remove('context-active');
    $('#cameraButtonLabel').textContent = 'Take photo';
    document.title = 'Smart Capturer';
    return;
  }
  $('#launchContextType').textContent = state.launchContext.assignment_name ? 'YOU ARE SCANNING FOR THIS ASSIGNMENT' : 'YOU ARE CAPTURING FOR THIS CONTEXT';
  $('#launchContextName').textContent = state.launchContext.context;
  $('#launchContextMeta').textContent = [state.launchContext.category, state.launchContext.source, state.launchContext.external_ref]
    .filter(Boolean).join(' · ');
  $('#launchContextInstruction').textContent = `Every photo taken here will be attached to “${state.launchContext.context}”.`;
  $('#cameraButtonLabel').textContent = captureButtonLabel(state.launchContext);
  document.title = `Scan for ${state.launchContext.context} · Smart Capturer`;
  captureCard.classList.add('context-active');
  card.classList.remove('hidden');
}

$('#clearLaunchContext').addEventListener('click', () => {
  state.launchContext = null;
  history.replaceState(null, '', `${location.pathname}${clearLaunchContext(location.search)}`);
  $('#scopeSwitch').href = scope === 'work' ? '/capture' : '/work';
  renderLaunchContext();
  setStatus('Preloaded context cleared. New captures will be unsorted.');
});

let openRecord = null;

async function loadRecordDetails() {
  if (!recordId) return;
  document.body.classList.add('record-mode');
  $('#recordCard').classList.remove('hidden');
  $('#scopeSwitch').classList.add('hidden');
  $('#scopeName').textContent = 'CAPTURE RECORD';
  $('#recordBack').href = `${scope === 'work' ? '/work' : '/capture'}${launchSearchForPath(launchParams)}`;
  try {
    const result = await responseJsonOrThrow(await apiFetch(`/api/captures/${recordId}?scope=${scope}`));
    showRecord(result.record);
  } catch (error) {
    $('#recordHeading').textContent = 'Could not load record';
    setRecordSaveStatus(error.message, true);
  }
}

function showRecord(record) {
  openRecord = record;
  $('#recordHeading').textContent = record.title || record.context || 'Record details';
  $('#recordKind').value = record.kind || 'unknown';
  const category = record.category || 'Unsorted';
  if (![...$('#recordCategory').options].some(option => option.value === category)) {
    $('#recordCategory').add(new Option(category, category));
  }
  $('#recordCategory').value = category;
  $('#recordTitle').value = record.title || '';
  $('#recordOriginal').value = record.original_text || '';
  $('#recordOriginal').readOnly = record.kind === 'image';
  $('#recordContext').value = record.context || '';
  $('#recordTags').value = Array.isArray(record.tags) ? record.tags.join(', ') : '';
  $('#recordDestination').value = record.destination || inboxName;
  $('#recordStatusBadge').textContent = workflowLabel(record);
  const identity = [record.source, record.assignment_name, record.external_ref].filter(Boolean).join(' · ');
  $('#recordIdentity').textContent = identity;
  $('#recordIdentity').classList.toggle('hidden', !identity);
  document.title = `${record.title || record.context || 'Capture record'} · Smart Capturer`;
}

function setRecordSaveStatus(text, failed = false) {
  $('#recordSaveStatus').textContent = text;
  $('#recordSaveStatus').classList.remove('hidden');
  $('#recordSaveStatus').classList.toggle('failed-status', failed);
}

$('#saveRecord').addEventListener('click', async () => {
  if (!recordId || !openRecord) return;
  const edits = {
    category: $('#recordCategory').value,
    title: $('#recordTitle').value,
    original_text: $('#recordOriginal').value,
    context: $('#recordContext').value,
    tags: $('#recordTags').value.split(',').map(value => value.trim()).filter(Boolean),
    destination: $('#recordDestination').value
  };
  try {
    $('#saveRecord').disabled = true;
    setRecordSaveStatus('Validating edits…');
    const result = await responseJsonOrThrow(await apiFetch(`/api/captures/${recordId}?scope=${scope}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(edits)
    }));
    showRecord(result.record);
    upsertRecent({ ...result.record, id: recordId, upload_status: 'saved', created_at: result.record.created_at || new Date().toISOString() });
    setRecordSaveStatus('Edits validated and saved by the backend.');
  } catch (error) {
    setRecordSaveStatus(`Could not save: ${error.message}`, true);
  } finally {
    $('#saveRecord').disabled = false;
  }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js?v=6').then(registration => registration.update()).catch(() => {});
renderRecent();
renderLaunchContext();
loadRecordDetails();
runQueue();
refreshStatuses();
setInterval(refreshStatuses, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { runQueue(); refreshStatuses(); } });
