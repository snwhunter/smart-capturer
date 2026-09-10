class DriveStoreError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function parseCredentials(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (['client_id', 'client_secret', 'refresh_token'].every(key => typeof parsed[key] === 'string' && parsed[key])) {
      return parsed;
    }
  } catch {}
  throw new Error('GOOGLE_DRIVE_CREDENTIALS_JSON is invalid');
}

async function checkedJson(fetchImpl, url, options, code) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(60000), redirect: 'error' });
  } catch {
    throw new DriveStoreError(`${code}-request-failed`);
  }
  // Provider bodies can contain private file metadata. Keep them server-side.
  if (!response.ok) throw new DriveStoreError(`${code}-http-${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new DriveStoreError(`${code}-invalid-response`);
  }
}

export function createDriveStore({ env = process.env, fetchImpl = globalThis.fetch, logger = console } = {}) {
  const folderId = (env.DRIVE_FOLDER_ID || '').trim();
  const credentials = parseCredentials(env.GOOGLE_DRIVE_CREDENTIALS_JSON || '');
  let cachedToken = { value: '', expires: 0 };

  async function accessToken() {
    if (cachedToken.value && cachedToken.expires > Date.now() + 60000) return cachedToken.value;
    const form = new URLSearchParams({
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      refresh_token: credentials.refresh_token,
      grant_type: 'refresh_token'
    });
    const result = await checkedJson(fetchImpl, 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    }, 'token');
    if (typeof result.access_token !== 'string' || !result.access_token) throw new DriveStoreError('token-invalid-response');
    cachedToken = { value: result.access_token, expires: Date.now() + Number(result.expires_in || 3600) * 1000 };
    return cachedToken.value;
  }

  async function upload({ name, buffer, contentType, captureId, kind }) {
    if (!folderId || !credentials) throw new DriveStoreError('not-configured');
    const token = await accessToken();
    const boundary = `smart-capturer-${crypto.randomUUID()}`;
    const metadata = {
      name,
      parents: [folderId],
      appProperties: { smartCapturerId: captureId, smartCapturerKind: kind || 'unknown' }
    };
    const prefix = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const result = await checkedJson(fetchImpl,
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,size,mimeType,parents,webViewLink',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` },
        body: Buffer.concat([prefix, buffer, suffix])
      }, 'upload');
    if (!result.id) throw new DriveStoreError('upload-invalid-response');
    return result;
  }

  return {
    configured: Boolean(folderId && credentials),
    folderId,
    async uploadFile(options) {
      try {
        return await upload(options);
      } catch (error) {
        logger.error(`Drive upload failed: code=${error instanceof DriveStoreError ? error.code : 'unknown'}`);
        throw new Error('Google Drive upload failed. The capture was not confirmed saved.');
      }
    }
  };
}
