import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createYandexResearch, YANDEX_RESPONSES_URL } from '../server/yandex.mjs';

const source = 'https://admissions.example.ru/rules/2026';
const result = { recommendations: [{ universityId: 'example', reason: 'Подтверждено', passingScore: null }], sources: ['https://example.ru/invented'] };
const reply = (body = result, annotations = [{ type: 'url_citation', url: source }], extra = {}) => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(body), annotations }] }], ...extra }), { status: 200 });
const options = { key: 'private-test-key', folderId: 'test-folder', cacheDir: false };

test('Yandex requires both server credentials and a valid same-project model URI', async () => {
  for (const override of [{ key: '' }, { folderId: '' }, { folderId: '../bad' }, { model: 'gpt://other-folder/yandexgpt/latest' }, { key: 'bad\nkey' }]) {
    const adapter = createYandexResearch({ ...options, ...override, fetchImpl: () => assert.fail('must not call without configuration') });
    assert.equal(adapter.configured, false);
    assert.equal(await adapter.research('admissions', {}), null);
  }
  assert.equal(createYandexResearch(options).model, 'gpt://test-folder/yandexgpt/latest');
  assert.equal(createYandexResearch({ ...options, model: 'gpt://test-folder/yandexgpt/latest' }).configured, true);
});

test('Yandex sends documented Responses web-search request with key confined to Authorization', async () => {
  const adapter = createYandexResearch({ ...options, fetchImpl: async (url, init) => {
    assert.equal(url, YANDEX_RESPONSES_URL);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer private-test-key');
    assert.equal(init.headers['OpenAI-Project'], 'test-folder');
    const request = JSON.parse(init.body);
    assert.equal(request.model, 'gpt://test-folder/yandexgpt/latest');
    assert.equal(request.store, false);
    assert.deepEqual(request.tools[0], { type: 'web_search', filters: { allowed_domains: ['example.ru', 'other.example.ru'] }, search_context_size: 'high' });
    assert.deepEqual(request.tool_choice, { type: 'web_search' });
    assert.equal(request.text.format.type, 'json_object');
    assert.equal(request.max_output_tokens, 8000);
    assert(!init.body.includes(options.key));
    assert(init.signal instanceof AbortSignal);
    return reply();
  } });
  const answer = await adapter.research('admissions', { universities: [{ website: 'https://www.example.ru/' }, { website: 'https://other.example.ru/' }, { website: 'https://www.example.ru/' }] });
  assert.equal(adapter.provider, 'Yandex AI Studio');
  assert.deepEqual(answer.result, result);
  assert.deepEqual([...answer.sources], [source]);
  assert(!JSON.stringify(answer).includes(options.key));
});

test('Yandex accepts independent citation metadata, normalizes scheme-less URLs, rejects fabricated JSON sources and unsafe URLs', async () => {
  const adapter = createYandexResearch({ ...options, fetchImpl: async () => reply(result, [
    { type: 'url_citation', url: 'admissions.example.ru/rules/2026' },
    { type: 'url_citation', url: 'https://localhost/' },
    { type: 'url_citation', url: 'http://example.ru/' },
    { type: 'url_citation', url: 'https://user:secret@example.ru/' },
    { type: 'file_citation', url: 'https://example.ru/not-a-search-citation' },
    { url: 'https://example.ru/no-citation-type' },
  ]) });
  const answer = await adapter.research('admissions', {});
  assert.deepEqual([...answer.sources], [source]);
  const noSources = createYandexResearch({ ...options, fetchImpl: async () => reply(result, []) });
  assert.equal((await noSources.research('admissions', {})).sources.size, 0);
});

test('Yandex deduplicates identical pending requests and cached results cannot be mutated by callers', async () => {
  let calls = 0;
  const adapter = createYandexResearch({ ...options, fetchImpl: async () => { calls++; await new Promise(done => setTimeout(done, 5)); return reply(); } });
  const [first, second] = await Promise.all([adapter.research('admissions', { city: 'moscow' }), adapter.research('admissions', { city: 'moscow' })]);
  assert.equal(calls, 1);
  first.sources.clear();
  first.result.recommendations.length = 0;
  assert.equal(second.sources.size, 1);
  const third = await adapter.research('admissions', { city: 'moscow' });
  assert.equal(third.result.recommendations.length, 1);
  assert.equal(third.sources.size, 1);
  assert.equal(calls, 1);
});

test('Yandex persists a bounded-answer cache without credentials and can reuse it across instances', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'voooz-yandex-cache-'));
  try {
    const adapter = createYandexResearch({ ...options, cacheDir, fetchImpl: async () => reply() });
    await adapter.research('admissions', { specialty: '09.03.01' });
    const names = await readdir(cacheDir);
    assert.equal(names.length, 1);
    assert.match(names[0], /^yandex-[a-f0-9]{64}\.json$/);
    assert(!(await readFile(join(cacheDir, names[0]), 'utf8')).includes(options.key));
    const reused = createYandexResearch({ ...options, cacheDir, fetchImpl: () => assert.fail('cache should avoid provider request') });
    assert.equal((await reused.research('admissions', { specialty: '09.03.01' })).sources.has(source), true);
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test('Yandex errors are redacted, unsuccessful answers are not cached and malformed or oversized output is rejected', async () => {
  for (const [status, code] of [[401, 'AI_AUTH'], [403, 'AI_AUTH'], [429, 'AI_LIMIT'], [500, 'AI_UNAVAILABLE']]) {
    let calls = 0;
    const adapter = createYandexResearch({ ...options, fetchImpl: async () => { calls++; return new Response('private-test-key SECRET provider error', { status }); } });
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(adapter.research('admissions', {}), error => error.message === code && !String(error).includes(options.key));
    assert.equal(calls, 2);
  }
  for (const makeReply of [
    () => reply([], []),
    () => reply({}, [], { status: 'incomplete' }),
    () => new Response('{bad json'),
    () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
  ]) {
    const adapter = createYandexResearch({ ...options, fetchImpl: async () => makeReply() });
    await assert.rejects(adapter.research('admissions', {}), { message: 'AI_FORMAT' });
  }
  const failedFetch = createYandexResearch({ ...options, fetchImpl: async () => { throw new Error('private-test-key'); } });
  await assert.rejects(failedFetch.research('admissions', {}), { message: 'AI_UNAVAILABLE' });
});
