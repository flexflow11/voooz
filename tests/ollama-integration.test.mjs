import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.mjs';

const year = new Date().getUTCFullYear();
const model = 'qwen2.5:0.5b';
const subjects = ['Русский язык', 'Математика', 'Информатика'];
const catalog = {
  cities: [{ id: 'moscow', name: 'Москва' }],
  specialties: [{ code: '09.03.01', name: 'Информатика и вычислительная техника' }],
  universities: ['alpha', 'beta', 'gamma', 'delta'].map(id => ({
    id, name: `Технический университет ${id}`, shortName: id, cityId: 'moscow',
    website: `https://${id}.example.ru/`, description: 'Информатика и программирование',
    tags: ['Информатика'], images: [],
  })),
};
const profile = {
  city: 'moscow', specialty: '09.03.01', achievements: { certificate: 'Золотая медаль' },
  exams: [...subjects, 'Физика', 'Биология'].map(subject => ({ subject, score: 100 })),
};

function fixture(id, bonus = 10) {
  const source = `https://${id}.example.ru/admissions/rules`;
  const applyUrl = `https://${id}.example.ru/admissions/apply`;
  const competitionGroup = '09.03.01 — общий конкурс';
  const campus = 'Москва';
  const seats = atYear => ({ value: 40, year: atYear, source, competitionGroup, campus });
  const admission = {
    program: 'Информатика и вычислительная техника', code: '09.03.01',
    competitionGroup, campus, year, funding: 'budget', source,
    examOptions: [subjects.map(subject => ({ subject, minimum: 50 }))],
    additionalTests: false, budgetSeats: seats(year),
    achievementRules: { year, source, complete: true, maxPoints: 10,
      items: [{ key: 'certificate', value: 'Золотая медаль', points: bonus,
        description: 'Баллы за заявленную золотую медаль', requiresDocuments: true, conditionsComplete: true }] },
    history: [1, 2, 3].map((ago, index) => ({
      value: 290 + index * 5, year: year - ago, source, type: 'last_admitted',
      subjects, funding: 'budget', competitionGroup, campus,
      includesAchievements: true, maxScore: 310, budgetSeats: seats(year - ago),
    })),
    application: { url: applyUrl, source: applyUrl },
    chance: 99, competitionScore: 999,
  };
  const retrievedAt = new Date().toISOString();
  return {
    item: { universityId: id, reason: 'Программа соответствует предметам ЕГЭ.', admission, chance: 99 },
    documents: [
      { url: source, title: 'Правила приёма и результаты конкурса', universityId: id, retrievedAt,
        text: `Официальные правила программы. Русский язык, математика, информатика: минимум 50. Бюджетных мест 40. За золотую медаль ${bonus} баллов. Исторические проходные баллы 290, 295 и 300.` },
      { url: applyUrl, title: 'Подача документов', universityId: id, retrievedAt,
        text: 'Официальный личный кабинет абитуриента. Подать документы на выбранную программу.' },
    ],
  };
}

const records = [fixture('alpha', 10), fixture('beta', 5), fixture('gamma', 2)];
const documents = records.flatMap(record => record.documents);
const evidence = (docs = documents) => ({
  documents: structuredClone(docs), sources: new Set(docs.map(doc => doc.url)), failures: [], notice: undefined,
});
const reply = items => new Response(JSON.stringify({
  model, done: true, message: { role: 'assistant', content: JSON.stringify({ recommendations: items }) },
}), { status: 200 });
const tags = models => new Response(JSON.stringify({ models: models.map(name => ({ name, model: name })) }), { status: 200 });

async function withServer(options, action) {
  const server = await createServer({ catalog, aiProvider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434',
    model, cacheDir: false, evidenceCollector: { collect: async () => evidence() }, ...options });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try { await action(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
const post = base => fetch(`${base}/api/recommendations`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile),
});

test('local Qwen pipeline uses no cloud API or key, reads supplied official evidence and retains per-university 310-point calculations', async () => {
  const requests = [];
  let collected = 0;
  await withServer({ aiKey: 'unused-cloud-credential-must-stay-private', folderId: 'unused-cloud-folder', evidenceCollector: { collect: async universities => {
    collected++;
    assert.equal(universities.length, 3, 'the CPU model receives a bounded shortlist');
    return evidence();
  } }, fetchImpl: async (url, options = {}) => {
    requests.push(String(url));
    assert.equal(new URL(url).origin, 'http://127.0.0.1:11434');
    assert(!Object.keys(options.headers || {}).some(key => key.toLowerCase() === 'authorization'));
    if (String(url).endsWith('/api/tags')) return tags([model]);
    assert(String(url).endsWith('/api/chat'));
    const body = JSON.parse(options.body);
    assert.equal(body.model, model);
    assert.equal(body.stream, false);
    assert.match(JSON.stringify(body.messages), /Официальные правила программы/);
    assert(!body.tools, 'a local model must not claim a provider-native web-search tool');
    return reply([null, records[0].item, records[0].item, records[1].item, records[2].item]);
  } }, async base => {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ai.configured, true);
    assert.match(health.ai.provider, /Qwen|Ollama/);
    assert.equal(health.ollama.available, true);
    assert.equal(health.ollama.modelInstalled, true);
    const response = await post(base);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.totalScore, 500);
    assert.equal(result.ai.used, true);
    assert.equal(result.recommendations.length, 3);
    assert.deepEqual(result.recommendations.map(row => row.university.id), ['alpha', 'beta', 'gamma']);
    assert.deepEqual(result.recommendations.map(row => row.admission.competitionScore), [310, 305, 302]);
    assert(result.recommendations.every(row => row.admission.examScore === 300 && row.admission.chance === null));
    assert.equal(result.recommendations[0].admission.budgetSeats.value, 40);
    assert.equal(result.recommendations[0].admission.applyUrl, records[0].item.admission.application.url);
    assert.equal(collected, 1);
    assert.equal(requests.filter(url => url.endsWith('/api/chat')).length, 1);
    assert(!JSON.stringify(result.ai).includes('Yandex'));
    assert(!JSON.stringify(result).includes('unused-cloud-credential'));
  });
});

test('unreachable Ollama and a missing local model retain catalog recommendations without attempting inference or evidence requests', async () => {
  for (const missingModel of [false, true]) {
    await withServer({ evidenceCollector: { collect: async () => assert.fail('unavailable model must not crawl sites') },
      fetchImpl: async url => {
        assert(String(url).endsWith('/api/tags'));
        if (missingModel) return tags(['some-other-model:latest']);
        throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
      } }, async base => {
      const health = await (await fetch(`${base}/api/health`)).json();
      assert.equal(health.ai.configured, false);
      assert.equal(health.ollama.available, missingModel);
      assert.equal(health.ollama.modelInstalled, false);
      const result = await (await post(base)).json();
      assert.equal(result.ai.used, false);
      assert.equal(result.recommendations.length, 3);
      assert(result.recommendations.every(row => row.admission === null));
      assert.match(result.notice, /Ollama|модел|нейросет|Qwen/i);
      assert(!JSON.stringify(result).includes('ECONNREFUSED'));
    });
  }
});

test('unavailable official documents skip Qwen rather than substituting its training memory for admissions sources', async () => {
  await withServer({ evidenceCollector: { collect: async () => ({ ...evidence([]),
    failures: [{ universityId: 'alpha', code: 'FETCH_FAILED' }], notice: 'Официальные страницы сейчас недоступны.' }) },
    fetchImpl: async url => { assert(String(url).endsWith('/api/tags')); return tags([model]); } }, async base => {
    const result = await (await post(base)).json();
    assert.equal(result.ai.configured, true);
    assert.equal(result.ai.used, false);
    assert.equal(result.recommendations.length, 3);
    assert(result.recommendations.every(row => row.admission === null && row.passingScore === null));
    assert.match(result.notice, /источник|страниц|данны|сайт/i);
  });
});

test('a model-authored official-looking source does not become evidence merely because it appears in generated JSON', async () => {
  const item = structuredClone(records[0].item);
  const fakeSource = 'https://alpha.example.ru/not-fetched';
  item.admission.source = fakeSource;
  item.sources = [fakeSource];
  await withServer({ fetchImpl: async url => String(url).endsWith('/api/tags') ? tags([model]) : reply([item]) }, async base => {
    const result = await (await post(base)).json();
    assert.equal(result.ai.used, true);
    assert.equal(result.recommendations[0].university.id, 'alpha');
    assert.equal(result.recommendations[0].admission, null);
    assert(!JSON.stringify(result).includes(fakeSource));
  });
});

test('local Qwen cannot bypass the three-exam admissions engine with a legacy four-exam passing score', async () => {
  const source = records[0].documents[0].url;
  const item = {
    universityId: 'alpha', reason: 'Программа требует отдельной проверки условий конкурса.', admission: null,
    passingScore: { value: 400, year: year - 1, source, type: 'last_admitted', funding: 'budget',
      program: 'Информатика и вычислительная техника', subjects: [...subjects, 'Физика'] },
  };
  let inferenceCalls = 0;
  await withServer({ fetchImpl: async url => {
    if (String(url).endsWith('/api/tags')) return tags([model]);
    assert(String(url).endsWith('/api/chat'));
    inferenceCalls++;
    return reply([item]);
  } }, async base => {
    const response = await post(base);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(inferenceCalls, 1, 'the model actually answered with supplied source evidence');
    assert.equal(result.ai.used, true);
    assert.equal(result.recommendations[0].university.id, 'alpha');
    assert.equal(result.recommendations[0].admission, null);
    assert.equal(result.recommendations[0].passingScore, null,
      'a four-exam legacy number must not appear in the local three-exam/310-point product');
    assert(!JSON.stringify(result).includes('"value":400'), 'the UI payload must not expose the rejected score');
  });
});

test('local inference failures stay local and preserve the usable catalog instead of calling a paid fallback', async () => {
  await withServer({ fetchImpl: async url => {
    assert.equal(new URL(url).origin, 'http://127.0.0.1:11434');
    return String(url).endsWith('/api/tags') ? tags([model]) : new Response('private model diagnostic', { status: 500 });
  } }, async base => {
    const response = await post(base);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ai.used, false);
    assert.equal(result.recommendations.length, 3);
    assert(!JSON.stringify(result).includes('private model diagnostic'));
    assert.match(result.notice, /модел|нейросет|Ollama|Qwen/i);
  });
});
