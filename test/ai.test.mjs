import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalyzer } from '../ai.mjs';

const analysis = {
  category: 'Receipt', title: 'Test receipt', context: 'Synthetic receipt', tags: ['test'],
  confidence: 0.9, destination_hint: 'Receipts', extracted: { amount: '12.50' }
};
const fallback = { ...analysis, confidence: 0.25 };
const geminiResponse = value => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] });
const openaiResponse = value => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
const imageUrl = 'data:image/png;base64,aGVsbG8=';
const response = value => new Response(JSON.stringify(value), { status: 200 });

test('Gemini is the default, even with an OpenAI key available; no cross-provider fallback', async () => {
  const analyzer = createAnalyzer({ env: { OPENAI_API_KEY: 'test-openai' }, fetchImpl: () => assert.fail('must not call OpenAI') });
  assert.equal(analyzer.provider, 'gemini');
  assert.equal(analyzer.configured, false);
  assert.equal((await analyzer.analyze({}, fallback)).source, 'local-fallback');
});

test('Gemini sends server credentials in a header and translates text and image input', async () => {
  let calls = 0;
  const analyzer = createAnalyzer({
    env: { GEMINI_API_KEY: 'test-gemini', GEMINI_MODEL: 'test-model' },
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent');
      assert.equal(options.headers['x-goog-api-key'], 'test-gemini');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      const body = JSON.parse(options.body);
      assert.equal(body.generationConfig.responseMimeType, 'application/json');
      assert.deepEqual(body.contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } });
      assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), { kind: 'image', text: 'Test', filename: 'test.png' });
      assert.ok(body.systemInstruction.parts[0].text.includes('never invent facts'));
      return response(geminiResponse({ ...analysis, source: 'injected', warning: 'untrusted' }));
    }
  });
  const actual = await analyzer.analyze({ kind: 'image', text: 'Test', file: { name: 'test.png', dataUrl: imageUrl } }, fallback);
  assert.deepEqual(actual, { ...analysis, source: 'gemini' });
  assert.equal(calls, 1);
});

test('OpenAI is explicitly selectable and returns the same contract', async () => {
  const analyzer = createAnalyzer({
    env: { AI_PROVIDER: 'openai', GEMINI_API_KEY: 'unused', OPENAI_API_KEY: 'test-openai', OPENAI_MODEL: 'test-openai-model' },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(options.headers.authorization, 'Bearer test-openai');
      assert.equal(options.headers['x-goog-api-key'], undefined);
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'test-openai-model');
      assert.equal(body.store, false);
      assert.deepEqual(body.text, { format: { type: 'json_object' } });
      assert.equal(body.input[0].content[1].image_url, imageUrl);
      return response(openaiResponse(analysis));
    }
  });
  assert.deepEqual(await analyzer.analyze({ file: { dataUrl: imageUrl } }, fallback), { ...analysis, source: 'openai' });
});

for (const provider of ['gemini', 'openai']) {
  test(`${provider} handles a text-only capture`, async () => {
    const analyzer = createAnalyzer({
      env: { AI_PROVIDER: provider, GEMINI_API_KEY: 'test', OPENAI_API_KEY: 'test' },
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(provider === 'gemini' ? body.contents[0].parts.length : body.input[0].content.length, 1);
        return response(provider === 'gemini' ? geminiResponse(analysis) : openaiResponse(analysis));
      }
    });
    assert.equal((await analyzer.analyze({ kind: 'link', text: 'https://example.com' }, fallback)).source, provider);
  });

  test(`${provider} rejects invalid and incomplete model results`, async () => {
    for (const value of [null, {}, { ...analysis, confidence: 7 }, { ...analysis, tags: 'bad' }, { ...analysis, extracted: [] }]) {
      const analyzer = createAnalyzer({
        env: { AI_PROVIDER: provider, GEMINI_API_KEY: 'test', OPENAI_API_KEY: 'test' }, logger: { error() {} },
        fetchImpl: async () => response(provider === 'gemini' ? geminiResponse(value) : openaiResponse(value))
      });
      assert.equal((await analyzer.analyze({}, fallback)).source, 'fallback-after-error');
    }
  });

  test(`${provider} error payloads and credentials never reach the browser or logs`, async () => {
    const logs = [];
    const analyzer = createAnalyzer({
      env: { AI_PROVIDER: provider, GEMINI_API_KEY: 'secret-test-key', OPENAI_API_KEY: 'secret-test-key' },
      logger: { error: line => logs.push(line) },
      fetchImpl: async () => new Response('secret-test-key PRIVATE_CAPTURE', { status: 429 })
    });
    const result = await analyzer.analyze({}, fallback);
    assert.equal(result.source, 'fallback-after-error');
    assert.equal(result.title, fallback.title);
    assert.match(logs[0], /http-429/);
    assert.doesNotMatch(JSON.stringify({ result, logs }), /secret-test-key|PRIVATE_CAPTURE/);
  });
}

test('blocked, truncated, and malformed Gemini output uses local suggestions', async () => {
  for (const result of [
    { promptFeedback: { blockReason: 'SAFETY' } },
    { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: JSON.stringify(analysis) }] } }] },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not json' }] } }] }
  ]) {
    const analyzer = createAnalyzer({ env: { GEMINI_API_KEY: 'test' }, logger: { error() {} }, fetchImpl: async () => response(result) });
    assert.equal((await analyzer.analyze({}, fallback)).source, 'fallback-after-error');
  }
});

test('incomplete OpenAI output is not treated as successful analysis', async () => {
  const analyzer = createAnalyzer({
    env: { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'test' }, logger: { error() {} },
    fetchImpl: async () => response({ ...openaiResponse(analysis), status: 'incomplete' })
  });
  assert.equal((await analyzer.analyze({}, fallback)).source, 'fallback-after-error');
});

test('timeouts are bounded and do not expose fetch errors', async () => {
  const analyzer = createAnalyzer({
    env: { GEMINI_API_KEY: 'test' }, timeoutMs: 10, logger: { error() {} },
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => assert.fail('timeout was not applied'), 1000);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); });
    })
  });
  assert.equal((await analyzer.analyze({}, fallback)).source, 'fallback-after-error');
});

test('invalid provider fails configuration rather than silently changing providers', () => {
  assert.throws(() => createAnalyzer({ env: { AI_PROVIDER: 'typo' } }), /AI_PROVIDER/);
});

test('unsupported image never triggers a provider request', async () => {
  const analyzer = createAnalyzer({ env: { GEMINI_API_KEY: 'test' }, logger: { error() {} }, fetchImpl: () => assert.fail('unexpected request') });
  assert.equal((await analyzer.analyze({ file: { dataUrl: 'https://example.com/private' } }, fallback)).source, 'fallback-after-error');
});
