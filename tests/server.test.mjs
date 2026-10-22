import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.mjs';
import { safeUrl, validatePassingScore } from '../server/ai.mjs';
import { validateWebAppUrl, runTelegramBot } from '../server/telegram.mjs';

const catalog = {
  meta: { source: 'test fixture' },
  cities: [{ id: 'moscow', name: 'Москва' }, { id: 'kazan', name: 'Казань' }],
  specialties: [{ code: '09.03.01', name: 'Информатика и вычислительная техника' }],
  universities: [
    { id: 'medical', name: 'Медицинский университет', shortName: 'Мед', cityId: 'moscow', tags: ['Медицина', 'Биология'], website: 'https://medical.example.ru/', description: 'Медицинское образование', images: [] },
    { id: 'technical', name: 'Технический университет', shortName: 'Тех', cityId: 'moscow', category: 'tech', tags: ['Информатика', 'Инженерия'], website: 'https://technical.example.ru/', description: 'Информатика и программирование', images: [] },
    { id: 'kazan-u', name: 'Казанский университет', shortName: 'КазУ', cityId: 'kazan', tags: ['Наука'], website: 'https://kazan.example.ru/', description: 'Исследования', images: [] },
  ],
};

const profile = { exams: [{ subject: 'Русский язык', score: 88 }, { subject: 'Математика', score: 79 }, { subject: 'Информатика', score: 91 }], specialty: '09.03.01', achievements: { gto: true, certificate: true }, city: 'moscow' };

async function withServer(options, action) {
  const server = await createServer({ catalog, aiProvider: 'openai', aiKey: '', cacheDir: false, ...options });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await action(base); } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
}

const post = (base, body) => fetch(`${base}/api/recommendations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('catalog, city filter, category filter and university detail work without AI', async () => {
  await withServer({}, async base => {
    assert.equal((await (await fetch(`${base}/api/health`)).json()).ai.configured, false);
    assert.deepEqual((await (await fetch(`${base}/api/catalog`)).json()).cities, catalog.cities);
    assert.deepEqual((await (await fetch(`${base}/api/universities?city=kazan`)).json()).universities.map(u => u.id), ['kazan-u']);
    assert.deepEqual((await (await fetch(`${base}/api/universities?category=tech`)).json()).universities.map(u => u.id), ['technical']);
    assert.equal((await (await fetch(`${base}/api/universities/technical`)).json()).university.name, 'Технический университет');
    assert.equal((await fetch(`${base}/api/universities/missing`)).status, 404);
    assert.equal((await fetch(`${base}/api/universities?city=unknown`)).status, 404);
  });
});

test('local recommendations calculate exam totals and match themes without inventing admissions data or achievement points', async () => {
  await withServer({}, async base => {
    const response = await post(base, profile);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.totalScore, 258);
    assert.equal(result.achievementPoints, null);
    assert.equal(result.ai.used, false);
    assert.equal(result.recommendations[0].university.id, 'technical');
    assert.equal(result.recommendations[0].relevance, 'thematic');
    assert(result.recommendations.every(r => r.university.cityId === 'moscow' && r.passingScore === null && r.subjectMatch === null));
    assert.match(result.disclaimer, /не гарантирует/);
  });
});

test('invalid exam ranges, repeated subjects, foreign cities and malformed JSON are rejected', async () => {
  await withServer({}, async base => {
    for (const body of [
      { ...profile, exams: [{ subject: 'Русский язык', score: 101 }, profile.exams[1]] },
      { ...profile, exams: [{ subject: 'Русский язык', score: -1 }, profile.exams[1]] },
      { ...profile, exams: [{ subject: 'Русский язык', score: 80.5 }, profile.exams[1]] },
      { ...profile, exams: [{ subject: 'Русский язык', score: '80' }, profile.exams[1]] },
      { ...profile, exams: [profile.exams[0], profile.exams[0]] },
      { ...profile, exams: [{ subject: 'Неизвестный предмет', score: 80 }, profile.exams[1]] },
      { ...profile, city: 'not-a-city' },
      { ...profile, specialty: { malicious: true } },
      { ...profile, achievements: [] },
    ]) assert.equal((await post(base, body)).status, 400);
    assert.equal((await fetch(`${base}/api/recommendations`, { method: 'POST', body: '{oops' })).status, 400);
  });
});

test('scores require cited official sources, year, funding, program and a compatible exam set', () => {
  const university = catalog.universities[1];
  const source = 'https://technical.example.ru/admissions/2025';
  const raw = { value: 270, year: 2025, source, program: 'Информатика', subjects: profile.exams.map(e => e.subject), funding: 'budget', type: 'last_admitted' };
  const sources = new Set([source, 'https://other.example.ru/']);
  assert.equal(validatePassingScore(raw, sources, university, profile.exams).value, 270);
  assert.equal(validatePassingScore({ ...raw, type: 'minimum' }, sources, university, profile.exams), null);
  assert.equal(validatePassingScore({ ...raw, source: 'https://other.example.ru/' }, sources, university, profile.exams), null);
  assert.equal(validatePassingScore({ ...raw, source: 'https://technical.example.ru/not-in-search' }, sources, university, profile.exams), null);
  assert.equal(validatePassingScore({ ...raw, year: 2099 }, sources, university, profile.exams), null);
  assert.equal(validatePassingScore({ ...raw, value: 311 }, sources, university, profile.exams), null);
  assert.equal(validatePassingScore({ ...raw, subjects: ['Русский язык', 'Математика', 'Физика'] }, sources, university, profile.exams).subjectMatch, false);
  for (const url of ['http://example.ru', 'https://127.0.0.1', 'https://localhost', 'https://user:password@example.ru', 'javascript:alert(1)', 'https://example.ru:3000']) assert.equal(safeUrl(url), null);
});

test('AI adapter sends web-search request and only exposes admissions numbers from cited official sources', async () => {
  let calls = 0;
  const source = 'https://technical.example.ru/admissions/2025';
  const fakeFetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const request = JSON.parse(options.body);
    assert.equal(request.tools[0].type, 'web_search');
    assert(request.include.includes('web_search_call.action.sources'));
    return new Response(JSON.stringify({ output: [
      { type: 'web_search_call', action: { sources: [{ url: source }] } },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ recommendations: [
        { universityId: 'technical', reason: 'Есть программа', passingScore: { value: 270, year: 2025, source, program: 'Информатика', subjects: profile.exams.map(e => e.subject), funding: 'budget', type: 'last_admitted' } },
        { universityId: 'medical', reason: 'Неподтверждённый балл', passingScore: { value: 222, year: 2025, source: 'https://medical.example.ru/fake', program: 'Лечебное дело', subjects: ['Русский язык', 'Химия', 'Биология'], funding: 'budget', type: 'last_admitted' } },
        { universityId: 'invented-id', reason: 'Не должен попасть в ответ', passingScore: null },
      ] }) }] },
    ] }), { status: 200 });
  };
  await withServer({ aiKey: 'server-only-test-key', fetchImpl: fakeFetch }, async base => {
    const result = await (await post(base, profile)).json();
    assert.equal(result.ai.used, true);
    assert.equal(result.recommendations.length, 2);
    assert.equal(result.recommendations[0].passingScore.value, 270);
    assert.equal(result.recommendations[1].passingScore, null);
    assert(!JSON.stringify(result).includes('server-only-test-key'));
    await post(base, profile);
    assert.equal(calls, 1, 'identical search reuses cache');
  });
});

test('AI failure preserves functional local recommendations and hides provider secrets', async () => {
  await withServer({ aiKey: 'secret-never-returned', fetchImpl: async () => new Response('secret provider body', { status: 401 }) }, async base => {
    const result = await (await post(base, profile)).json();
    assert.equal(result.ai.used, false);
    assert.equal(result.totalScore, 258);
    assert(result.recommendations.length > 0);
    assert.match(result.notice, /ключ/);
    assert(!JSON.stringify(result).includes('secret'));
  });
});

test('Telegram launcher validates public HTTPS and responds to /start with Mini App button', async () => {
  assert.equal(validateWebAppUrl('http://localhost:5173'), null);
  assert.equal(validateWebAppUrl('https://user:pass@example.com'), null);
  assert.equal(validateWebAppUrl('https://example.com/app'), 'https://example.com/app');
  const controller = new AbortController();
  const calls = [];
  await runTelegramBot({ token: '123:testtoken', webAppUrl: 'https://example.com/app', signal: controller.signal, fetchImpl: async (url, options) => {
    const method = url.split('/').pop(), body = JSON.parse(options.body);
    calls.push({ method, body });
    if (method === 'sendMessage') controller.abort();
    return new Response(JSON.stringify({ ok: true, result: method === 'getUpdates' ? [{ update_id: 42, message: { chat: { id: 1, type: 'private' }, text: '/start' } }] : {} }));
  } });
  assert(calls.some(c => c.method === 'setChatMenuButton'));
  const sent = calls.find(c => c.method === 'sendMessage');
  assert.equal(sent.body.reply_markup.inline_keyboard[0][0].web_app.url, 'https://example.com/app');
});
