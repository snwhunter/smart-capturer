// A live camera can start on navigation; a native file picker requires a gesture.
export function startDirectCamera({ enqueueImages, contextName }) {
  const get = id => document.getElementById(id);
  const video = get('cameraVideo');
  const shutter = get('cameraShutter');
  const status = get('cameraStatus');
  const retry = get('cameraRetry');
  let stream = null;
  let opening = false;
  let generation = 0;
  document.body.classList.add('direct-camera');
  get('liveCamera').classList.remove('hidden');
  const exit = new URL(location.href);
  exit.searchParams.delete('camera');
  get('cameraExit').href = exit.pathname + exit.search;

  function stop() {
    generation++;
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
    shutter.disabled = true;
  }

  async function open() {
    if (opening || stream || document.hidden) return;
    opening = true;
    const attempt = generation;
    retry.classList.add('hidden');
    status.textContent = 'Starting camera…';
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is unavailable in this browser. Open this link in Safari or use Take photo below.');
      const next = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
      if (attempt !== generation || document.hidden) {
        next.getTracks().forEach(track => track.stop());
        return;
      }
      stream = next;
      video.srcObject = stream;
      await video.play();
      shutter.disabled = false;
      status.textContent = contextName() ? `Ready — photos attach to “${contextName()}”.` : 'Ready to capture.';
    } catch (error) {
      stop();
      status.textContent = error.name === 'NotAllowedError'
        ? 'Allow camera access in your browser settings, then tap Enable camera. You can also use Take photo below.'
        : error.message || 'Could not open camera. Use Take photo below.';
      retry.classList.remove('hidden');
    } finally {
      opening = false;
    }
  }

  shutter.addEventListener('click', async () => {
    if (!video.videoWidth || !stream) return;
    shutter.disabled = true;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .92));
      if (!blob) throw new Error('Could not capture photo. Please try again.');
      await enqueueImages([new File([blob], `capture-${Date.now()}.jpg`, { type: 'image/jpeg' })]);
      status.textContent = contextName() ? `Photo queued for “${contextName()}”. Ready for the next.` : 'Photo queued. Ready for the next.';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      shutter.disabled = !stream;
    }
  });
  retry.addEventListener('click', open);
  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', open);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else open();
  });
  open();
}
