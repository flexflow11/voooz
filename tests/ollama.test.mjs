import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOllamaResearch } from '../server/ollama.mjs';

const source = 'https://admissions.example.ru/rules/2026';
const result = { recommendations: [{ universityId: 'example', reason: 'Есть направление', admission: null }], sources: ['https://example.ru/invented'] };
const evidence = [{ url: source, title: 'Правила приёма', text: 'Официальный документ: набор предметов, минимальные баллы и условия.' }];
const reply = (body = result, extra = {}) => new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(body) }, ...extra }), { status: 200 });

test('Ollama is keyless, accepts only local endpoints and rejects cloud model names', async () => {
  for (const baseUrl of ['https://api.openai.com', 'http://169.254.169.254', 'https://example.ru', 'http://user:secret@localhost:11434', 'http://localhost:11434/other', 'http://localhost:11434/?token=secret']) {
    const adapter = createOllamaResearch({ baseUrl, fetchImpl: () => assert.fail('invalid endpoint cannot be called') });
    assert.equal(adapter.configured, false);
    assert.equal(await adapter.research('admissions', {}), null);
    assert.equal((await adapter.checkHealth()).reason, 'invalid_configuration');
  }
  for (const model of ['qwen3:cloud', 'qwen3:4b-cloud', 'bad\nmodel', 'https://example.ru/model']) assert.equal(createOllamaResearch({ model }).configured, false);
  for (const baseUrl of ['http://localhost:11434', 'http://127.0.0.1:11435', 'http://[::1]:11434', 'http://ollama:11434', 'http://host.docker.internal:11434']) assert.equal(createOllamaResearch({ baseUrl }).configured, true);
  assert.equal(createOllamaResearch().model, 'qwen2.5:0.5b');
});

test('Ollama sends local JSON chat without keys, paid web-search tools, or a false browsing claim', async () => {
  const adapter = createOllamaResearch({ fetchImpl: async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(Object.keys(init.headers), ['Content-Type']);
    assert(init.signal instanceof AbortSignal);
    const request = JSON.parse(init.body);
    assert.equal(request.model, 'qwen2.5:0.5b');
    assert.equal(request.stream, false);
    assert.equal(request.format, 'json');
    assert.equal(request.options.temperature, 0);
    assert.equal(request.options.num_ctx, 8192);
    assert.equal(request.options.num_predict, 1200);
    assert.equal(request.options.num_thread, 4);
    assert.equal(request.tools, undefined);
    assert.match(request.messages[0].content, /нет веб-поиска/);
    assert.deepEqual(JSON.parse(request.messages[1].content).evidence, evidence);
    return reply();
  } });
  const answer = await adapter.research('admissions_recommendations', { evidence, profile: { specialty: 'Информатика' } });
  assert.equal(adapter.provider, 'Qwen · Ollama');
  assert.deepEqual(answer.result, result);
  assert.deepEqual([...answer.sources], [source]);
});

test('only text documents actually fed to Ollama grant citations; model-authored sources never do', async () => {
  let input;
  const adapter = createOllamaResearch({ fetchImpl: async (url, init) => { input = JSON.parse(JSON.parse(init.body).messages[1].content); return reply(); } });
  const docs = [
    ...evidence, ...evidence,
    { url: 'https://example.ru/empty', text: '  ' },
    { url: 'http://example.ru/insecure', text: 'not allowed' },
    { url: 'https://localhost/', text: 'not allowed' },
    { url: 'https://user:secret@example.ru/', text: 'not allowed' },
  ];
  const grounded = await adapter.research('admissions', { evidence: docs });
  assert.deepEqual(input.evidence, evidence);
  assert.deepEqual([...grounded.sources], [source]);
  const ungrounded = await adapter.research('admissions', { sources: [source] });
  assert.equal(ungrounded.sources.size, 0);
  assert.deepEqual(input.evidence, []);
  assert(!ungrounded.sources.has(result.sources[0]));
});

test('Ollama admissions JSON schema constrains returned university IDs to the supplied shortlist without forcing facts', async () => {
  let schema;
  const adapter = createOllamaResearch({ fetchImpl: async (url, init) => { schema = JSON.parse(init.body).format; return reply({ recommendations: [] }); } });
  await adapter.research('admissions_recommendations', { universities: [{ id: 'technical' }, { id: 'medical' }, { id: 'technical' }, null], evidence });
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['recommendations']);
  assert.equal(schema.additionalProperties, false);
  const recommendations = schema.properties.recommendations;
  assert.equal(recommendations.type, 'array');
  assert.equal(recommendations.maxItems, 3);
  assert.equal(recommendations.minItems, 0, 'an empty answer remains permitted when evidence is insufficient');
  assert.deepEqual(recommendations.items.properties.universityId, { type: 'string', enum: ['technical', 'medical'] });
  assert.equal(recommendations.items.properties.universityId.enum.includes('invented'), false);
  assert.deepEqual(recommendations.items.required, ['universityId', 'reason', 'admission']);
  assert.equal(recommendations.items.additionalProperties, false);
  const admission = recommendations.items.properties.admission;
  assert.deepEqual(admission.anyOf[0], { type: 'null' });
  const details = admission.anyOf[1];
  assert.equal(details.additionalProperties, false);
  assert.deepEqual(details.properties.source.enum, [source]);
  assert.equal(details.properties.examOptions.maxItems, 3);
  assert.equal(details.properties.history.maxItems, 5);
  assert.equal(details.properties.achievementRules.anyOf[1].properties.items.maxItems, 10);
  function assertBoundedObjects(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') { assert.equal(node.additionalProperties, false); assert(node.properties); }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(assertBoundedObjects);
      else if (value && typeof value === 'object') assertBoundedObjects(value);
    }
  }
  assertBoundedObjects(schema);
  await adapter.research('admissions_recommendations', { universities: [{ id: 'technical' }] });
  assert.deepEqual(schema.properties.recommendations.items.properties.admission, { type: 'null' }, 'without actual documents the model cannot invent an admission object');
  await adapter.research('university_details', { universities: [{ id: 'technical' }], evidence });
  assert.equal(schema, 'json', 'other tasks retain the ordinary JSON format');
  await adapter.research('admissions_recommendations', { evidence });
  assert.equal(schema, 'json', 'tasks without shortlist IDs do not invent a model enum');
});

test('Ollama evidence limits preserve all admitted documents fairly and reject oversized inputs', async () => {
  let sent;
  const adapter = createOllamaResearch({ fetchImpl: async (url, init) => { sent = JSON.parse(JSON.parse(init.body).messages[1].content); return reply(); } });
  const docs = Array.from({ length: 12 }, (_, i) => ({ url: `https://example.ru/doc-${i}`, title: `Документ ${i}`, text: 'а'.repeat(10_000) }));
  const answer = await adapter.research('admissions', { evidence: docs });
  assert.equal(sent.evidence.length, 9);
  assert.equal(answer.sources.size, 9);
  assert(sent.evidence.reduce((sum, doc) => sum + doc.text.length, 0) <= 6_000);
  assert(sent.evidence.every(doc => doc.text.length > 600));
  assert(!answer.sources.has(docs[9].url));
  await assert.rejects(adapter.research('admissions', { request: 'x'.repeat(25_000) }), { message: 'AI_INPUT' });
});

test('Ollama health separates reachable runtime, installed model and missing model', async () => {
  for (const [models, installed] of [[[{ name: 'qwen2.5:0.5b' }], true], [[{ model: 'qwen2.5:0.5b' }], true], [[], false]]) {
    const adapter = createOllamaResearch({ fetchImpl: async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:11434/api/tags');
      assert.equal(init.redirect, 'error');
      assert(init.signal instanceof AbortSignal);
      return new Response(JSON.stringify({ models }));
    } });
    const health = await adapter.checkHealth();
    assert.equal(health.available, true);
    assert.equal(health.modelInstalled, installed);
    assert.equal(health.reason, installed ? undefined : 'model_missing');
  }
  const latest = createOllamaResearch({ model: 'qwen2.5', fetchImpl: async () => new Response(JSON.stringify({ models: [{ name: 'qwen2.5:latest' }] })) });
  assert.equal((await latest.checkHealth()).modelInstalled, true);
  const remote = createOllamaResearch({ fetchImpl: async () => new Response(JSON.stringify({ models: [{ name: 'qwen2.5:0.5b', remote_host: 'https://ollama.com' }] })) });
  assert.deepEqual(await remote.checkHealth(), { available: true, modelInstalled: false, model: 'qwen2.5:0.5b', reason: 'cloud_model_unsupported' });
  const offline = createOllamaResearch({ fetchImpl: async () => { throw new Error('private route information'); } });
  assert.deepEqual(await offline.checkHealth(), { available: false, modelInstalled: false, model: 'qwen2.5:0.5b', reason: 'unavailable' });
});

test('Ollama deduplicates local inference and returns independent cached values', async () => {
  let calls = 0;
  const adapter = createOllamaResearch({ fetchImpl: async () => { calls++; await new Promise(done => setTimeout(done, 5)); return reply(); } });
  const [first, second] = await Promise.all([adapter.research('admissions', { evidence }), adapter.research('admissions', { evidence })]);
  assert.equal(calls, 1);
  first.sources.clear(); first.result.recommendations.length = 0;
  assert.equal(second.sources.size, 1);
  assert.equal((await adapter.research('admissions', { evidence })).result.recommendations.length, 1);
  assert.equal(calls, 1);
});

test('Ollama disk cache can be reused without preserving source document text', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'voooz-ollama-cache-'));
  try {
    const adapter = createOllamaResearch({ cacheDir, fetchImpl: async () => reply() });
    await adapter.research('admissions', { evidence });
    const names = await readdir(cacheDir);
    assert.equal(names.length, 1);
    assert.match(names[0], /^ollama-[a-f0-9]{64}\.json$/);
    const raw = await readFile(join(cacheDir, names[0]), 'utf8');
    assert(!raw.includes(evidence[0].text));
    const edited = JSON.parse(raw);
    edited.sources.push('https://example.ru/not-fed-to-model');
    await writeFile(join(cacheDir, names[0]), JSON.stringify(edited));
    const cached = createOllamaResearch({ cacheDir, fetchImpl: () => assert.fail('must reuse cached answer') });
    assert.deepEqual([...(await cached.research('admissions', { evidence })).sources], [source]);
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test('Ollama failures never expose process errors; truncated and malformed replies cannot become admissions facts', async () => {
  for (const [status, code] of [[404, 'AI_UNAVAILABLE'], [429, 'AI_LIMIT'], [503, 'AI_LIMIT'], [500, 'AI_UNAVAILABLE']]) {
    const adapter = createOllamaResearch({ fetchImpl: async () => new Response('secret internal model path', { status }) });
    await assert.rejects(adapter.research('admissions', {}), error => error.message === code && !String(error).includes('internal model path'));
  }
  for (const makeReply of [
    () => reply([], {}), () => reply({}, { done: false }), () => reply({}, { done_reason: 'length' }),
    () => reply({}, { remote_host: 'https://ollama.com' }),
    () => new Response('not json'), () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    () => reply({}, { message: { content: '{malformed' } }),
  ]) {
    const adapter = createOllamaResearch({ fetchImpl: async () => makeReply() });
    await assert.rejects(adapter.research('admissions', {}), { message: 'AI_FORMAT' });
  }
  const adapter = createOllamaResearch({ fetchImpl: async () => { throw new Error('secret runtime details'); } });
  await assert.rejects(adapter.research('admissions', {}), { message: 'AI_UNAVAILABLE' });
});
