import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.mjs';

const year = new Date().getFullYear();
const examSubjects = ['Русский язык', 'Математика', 'Информатика'];
const catalog = {
  cities: [{ id: 'moscow', name: 'Москва' }],
  specialties: [{ code: '09.03.01', name: 'Информатика и вычислительная техника' }],
  universities: ['alpha', 'beta', 'gamma', 'delta'].map(id => ({
    id, name: `Технический университет ${id}`, shortName: id,
    cityId: 'moscow', website: `https://${id}.example.ru/`,
    description: 'Информатика и программирование', tags: ['Информатика'], images: [],
  })),
};
const profile = {
  city: 'moscow', specialty: '09.03.01',
  exams: [...examSubjects, 'Физика', 'Биология'].map(subject => ({ subject, score: 100 })),
  achievements: { certificate: 'Золотая медаль' },
};

function fixture(id, bonus = 10) {
  const root = `https://${id}.example.ru/admissions`;
  const source = `${root}/${year}/rules`;
  const competitionGroup = '09.03.01 — общий конкурс';
  const campus = 'Москва';
  const seats = (atYear, value = 40) => ({ value, year: atYear, source: `${root}/${atYear}/seats`, competitionGroup, campus });
  const admission = {
    program: 'Информатика и вычислительная техника', code: '09.03.01',
    competitionGroup, campus, year, funding: 'budget', source,
    examOptions: [examSubjects.map(subject => ({ subject, minimum: 50 }))],
    additionalTests: false,
    budgetSeats: seats(year),
    achievementRules: {
      year, source, maxPoints: 10, complete: true,
      items: [{ key: 'certificate', value: 'Золотая медаль', points: bonus,
        description: 'Баллы за золотую медаль', requiresDocuments: false, conditionsComplete: true }],
    },
    history: [1, 2, 3].map((ago, index) => ({
      value: 300 + index * 5, year: year - ago, source: `${root}/${year - ago}/results`,
      type: 'last_admitted', subjects: examSubjects, funding: 'budget',
      competitionGroup, campus, includesAchievements: true, maxScore: 310,
      budgetSeats: seats(year - ago),
    })),
    application: { url: `${root}/apply`, source: `${root}/apply` },
    // Provider prose and unsupported predictions must not bypass the engine.
    competitionScore: 999, chance: 99, probability: 0.99,
  };
  const sources = [source, admission.budgetSeats.source, admission.application.url,
    ...admission.history.flatMap(entry => [entry.source, entry.budgetSeats.source])];
  return { item: { universityId: id, reason: 'Программа соответствует предметам ЕГЭ.', admission, chance: 99 }, sources };
}

function providerResponse(items, sources) {
  return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{
    type: 'output_text', text: JSON.stringify({ recommendations: items }),
    annotations: [...new Set(sources)].map(url => ({ type: 'url_citation', url })),
  }] }] }), { status: 200 });
}

async function withServer(options, action) {
  const server = await createServer({ catalog, aiProvider: 'yandex', aiKey: '', folderId: '', cacheDir: false, ...options });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try { await action(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
const post = (base, body = profile) => fetch(`${base}/api/recommendations`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('Yandex health requires both server credentials and preserves three usable catalog candidates without them', async () => {
  for (const credentials of [{}, { aiKey: 'server-key-only' }, { folderId: 'folder-only' }]) {
    await withServer({ ...credentials, fetchImpl: () => assert.fail('unconfigured AI must not send requests') }, async base => {
      const health = await (await fetch(`${base}/api/health`)).json();
      assert.equal(health.ai.configured, false);
      assert.match(health.ai.provider, /Yandex|Яндекс/);
      const result = await (await post(base)).json();
      assert.equal(result.ai.used, false);
      assert.equal(result.totalScore, 500, 'all-exam summary remains separate from competition score');
      assert.equal(result.recommendations.length, 3);
      assert(result.recommendations.every(row => !row.admission && row.passingScore === null));
      assert(!JSON.stringify(result).includes('server-key-only'));
    });
  }
});

test('Yandex HTTP pipeline verifies program evidence, caps three EGE plus institution bonuses at 310, and returns distinct top three', async () => {
  const records = [fixture('alpha', 10), fixture('beta', 5), fixture('gamma', 2), fixture('delta', 1)];
  const items = [records[0].item, records[0].item, ...records.slice(1).map(entry => entry.item)];
  let requests = 0;
  await withServer({ aiKey: 'server-only-never-public', folderId: 'test-folder', fetchImpl: async (url, options) => {
    requests++;
    assert.equal(url, 'https://ai.api.cloud.yandex.net/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer server-only-never-public');
    assert.equal(options.headers['OpenAI-Project'], 'test-folder');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt://test-folder/yandexgpt/latest');
    assert.equal(body.tools[0].type, 'web_search');
    return providerResponse(items, records.flatMap(entry => entry.sources));
  } }, async base => {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ai.configured, true);
    const response = await post(base);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ai.used, true);
    assert.equal(result.recommendations.length, 3);
    assert.equal(new Set(result.recommendations.map(row => row.university.id)).size, 3);
    const first = result.recommendations.find(row => row.university.id === 'alpha').admission;
    const second = result.recommendations.find(row => row.university.id === 'beta').admission;
    assert.equal(first.examScore, 300);
    assert.equal(first.achievementPoints, 10);
    assert.equal(first.competitionScore, 310);
    assert.equal(second.achievementPoints, 5, 'the same medal follows a different institution rule');
    assert.equal(second.competitionScore, 305);
    assert.equal(first.maxScore, 310);
    assert.equal(first.budgetSeats.value, 40);
    assert.equal(first.budgetSeats.year, year);
    assert.equal(first.chance, null, 'an unsupported model percentage is not a probability');
    assert.equal(first.historicalFit.percent, 100);
    assert.equal(first.historicalFit.isProbability, false);
    assert.equal(first.applyUrl, records[0].item.admission.application.url);
    assert(result.recommendations.every(row => row.admission.competitionScore <= 310));
    assert(!JSON.stringify(result).includes('server-only-never-public'));
    await post(base);
    assert.equal(requests, 1, 'identical evidence requests reuse the provider cache');
  });
});

test('model-authored sources cannot substantiate admission rules or application links absent provider citations', async () => {
  const record = fixture('alpha');
  const item = { ...record.item, sources: record.sources };
  await withServer({ aiKey: 'server-key', folderId: 'test-folder', fetchImpl: async () => providerResponse([item], []) }, async base => {
    const result = await (await post(base)).json();
    const proposed = result.recommendations.find(row => row.university.id === 'alpha');
    assert(!proposed?.admission, 'uncited program metadata must not become verified admissions data');
    assert(!JSON.stringify(result).includes(record.item.admission.application.url));
  });
});

test('Yandex authentication errors fall back to catalog without returning provider body or server key', async () => {
  await withServer({ aiKey: 'server-key-redacted', folderId: 'test-folder', fetchImpl: async () => new Response('private provider body server-key-redacted', { status: 403 }) }, async base => {
    const response = await post(base);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ai.configured, true);
    assert.equal(result.ai.used, false);
    assert.equal(result.recommendations.length, 3);
    assert.match(result.notice, /ключ|доступ|настройк/i);
    assert(!JSON.stringify(result).includes('private provider body'));
    assert(!JSON.stringify(result).includes('server-key-redacted'));
  });
});

test('malformed model rows and explicitly ineligible programs cannot displace a valid candidate or silently become catalog picks', async () => {
  const eligible = fixture('alpha');
  const noBudget = fixture('beta');
  noBudget.item.admission.budgetSeats.value = 0;
  const sources = [...eligible.sources, ...noBudget.sources];
  for (const allIneligible of [false, true]) {
    const proposed = allIneligible
      ? [null, 17, noBudget.item]
      : [null, 'malformed row', noBudget.item, eligible.item, eligible.item];
    await withServer({ aiKey: 'server-key', folderId: 'test-folder', fetchImpl: async () => providerResponse(proposed, sources) }, async base => {
      const response = await post(base);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.ai.used, true, 'a completed evidence check remains visible even when no program is eligible');
      assert.deepEqual(result.recommendations.map(row => row.university.id), allIneligible ? [] : ['alpha']);
      if (allIneligible) {
        assert.match(result.notice, /не|нет/i);
        assert.match(result.notice, /услови|конкурс|миним|ЕГЭ|требован/i);
      }
    });
  }
});
