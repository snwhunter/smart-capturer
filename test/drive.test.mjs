import test from 'node:test';
import assert from 'node:assert/strict';
import { createDriveStore } from '../drive.mjs';

const env = {
  DRIVE_FOLDER_ID: 'folder-test',
  GOOGLE_DRIVE_CREDENTIALS_JSON: JSON.stringify({
    client_id: 'client-test', client_secret: 'client-secret-test', refresh_token: 'refresh-test'
  })
};

test('Drive store is disabled unless both folder and credentials are present', () => {
  assert.equal(createDriveStore({ env: {} }).configured, false);
  assert.equal(createDriveStore({ env: { DRIVE_FOLDER_ID: 'folder' } }).configured, false);
  assert.throws(() => createDriveStore({ env: { GOOGLE_DRIVE_CREDENTIALS_JSON: '{}' } }), /invalid/);
});

test('Drive upload refreshes server token and writes multipart data to the configured folder', async () => {
  const calls = [];
  const store = createDriveStore({
    env,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes('oauth2.googleapis.com')) {
        assert.match(options.body, /refresh_token=refresh-test/);
        return new Response(JSON.stringify({ access_token: 'access-test', expires_in: 3600 }));
      }
      assert.equal(options.headers.authorization, 'Bearer access-test');
      const body = options.body.toString();
      assert.match(body, /"parents":\["folder-test"\]/);
      assert.match(body, /"smartCapturerId":"capture-test"/);
      if (body.includes('capture.jpg')) assert.match(body, /synthetic-image-data/);
      return new Response(JSON.stringify({ id: 'drive-file-test', name: 'capture.jpg', size: '20' }));
    }
  });
  const first = await store.uploadFile({
    name: 'capture.jpg', buffer: Buffer.from('synthetic-image-data'), contentType: 'image/jpeg',
    captureId: 'capture-test', kind: 'image'
  });
  assert.equal(first.id, 'drive-file-test');
  await store.uploadFile({ name: 'metadata.json', buffer: Buffer.from('{}'), contentType: 'application/json', captureId: 'capture-test', kind: 'image' });
  assert.equal(calls.filter(call => call.url.includes('oauth2.googleapis.com')).length, 1, 'access token should be cached');
});

test('Drive errors do not expose OAuth credentials or provider response bodies', async () => {
  const logs = [];
  const store = createDriveStore({
    env,
    logger: { error: message => logs.push(message) },
    fetchImpl: async () => new Response('refresh-test PRIVATE_FILE_DATA', { status: 403 })
  });
  await assert.rejects(() => store.uploadFile({
    name: 'capture.jpg', buffer: Buffer.from('x'), contentType: 'image/jpeg', captureId: 'capture-test', kind: 'image'
  }), /not confirmed saved/);
  assert.doesNotMatch(JSON.stringify(logs), /refresh-test|PRIVATE_FILE_DATA|client-secret-test/);
});
