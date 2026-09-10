import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('HTTP routes keep credentials server-side and preserve auth and local fallback', { timeout: 15000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'smart-capturer-test-'));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, STORAGE_BUCKET: '', AI_PROVIDER: 'gemini', GEMINI_API_KEY: '', OPENAI_API_KEY: 'unused-test-secret', CAPTURE_ACCESS_KEY: 'test-family' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    child.kill();
    await exited;
    await rm(dataDir, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/listening on (\d+)/);
      if (match) resolve(Number(match[1]));
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited: ${code}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ai_provider, 'gemini');
  assert.equal(health.ai, false);
  assert.equal(health.auth_required, true);
  assert.doesNotMatch(JSON.stringify(health), /unused-test-secret|test-family/);
  assert.equal((await fetch(`${base}/api/analyze`, { method: 'POST', body: '{}' })).status, 401);
  const analyzed = await (await fetch(`${base}/api/analyze`, {
    method: 'POST', headers: { 'x-smart-capturer-key': 'test-family' }, body: JSON.stringify({ kind: 'data', text: 'Test receipt' })
  })).json();
  assert.equal(analyzed.category, 'Receipt');
  assert.equal(analyzed.source, 'local-fallback');
  assert.equal((await fetch(`${base}/ai.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/drive.mjs`)).status, 404);
  const client = await (await fetch(`${base}/app.js`)).text();
  assert.doesNotMatch(client, /GEMINI_API_KEY|OPENAI_API_KEY|unused-test-secret/);
});
