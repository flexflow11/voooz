import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterUniversities, createCatalogRecommendations } from '../shared/catalog.mjs';
import { createServer } from '../server/index.mjs';

const catalog = {
  cities: [{ id: 'moscow', name: 'Москва' }, { id: 'kazan', name: 'Казань' }],
  specialties: [{ code: '09.03.01', name: 'Информатика и вычислительная техника' }],
  universities: [
    { id: 'med', name: 'Медицинский университет', shortName: 'Мед', cityId: 'moscow', categories: ['medicine'], description: 'Медицина и биология', tags: ['Медицина'], aliases: ['Медицинская академия'], images: [] },
    { id: 'it', name: 'Технический университет', shortName: 'Тех', cityId: 'moscow', categories: ['tech'], description: 'Информатика и программирование', tags: ['Информатика'], aliases: ['Политех'], images: [] },
    { id: 'kazan-u', name: 'Казанский университет', shortName: 'КазУ', cityId: 'kazan', categories: ['tech'], description: 'Инженерия', tags: [], images: [] },
  ],
};
const profile = { exams: [{ subject: 'Русский язык', score: 80 }, { subject: 'Математика (профильная)', score: 70 }, { subject: 'Информатика', score: 90 }], specialty: '09.03.01', achievements: { gto: 'Золотой' }, city: 'moscow', notes: 'Достижения уточнить у вуза' };

test('shared filtering combines city, aliases and category while preserving catalog order', () => {
  const before = structuredClone(catalog);
  assert.deepEqual(filterUniversities(catalog, { city: 'moscow', q: 'ПОЛИТЕХ', category: 'tech' }).map(u => u.id), ['it']);
  assert.deepEqual(filterUniversities(catalog, { category: 'all' }).map(u => u.id), ['med', 'it', 'kazan-u']);
  assert.deepEqual(filterUniversities(catalog, { city: 'kazan' }).map(u => u.id), ['kazan-u']);
  assert.throws(() => filterUniversities(catalog, { city: 'missing' }), error => error.status === 404);
  assert.deepEqual(catalog, before);
});

test('offline catalog recommendation response matches the server response and does not invent admissions data', async () => {
  const local = createCatalogRecommendations(profile, catalog);
  assert.equal(local.totalScore, 240);
  assert.deepEqual(local.ai, { configured: false, used: false });
  assert.equal(local.achievementPoints, null);
  assert.equal(local.recommendations[0].university.id, 'it');
  assert.equal(local.profile.notes, profile.notes);
  assert(local.recommendations.every(r => r.passingScore === null && r.subjectMatch === null));
  assert.match(local.disclaimer, /не гарантирует/);
  assert.throws(() => createCatalogRecommendations({ ...profile, exams: [{ subject: 'Русский язык', score: 101 }, ...profile.exams.slice(1)] }, catalog), error => error.status === 400);

  const server = await createServer({ catalog, aiProvider: 'yandex', aiKey: '', cacheDir: false });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/recommendations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile),
    });
    assert.equal(response.status, 200);
    const remote = await response.json();
    const { provider, model, ...publicAi } = remote.ai;
    assert.deepEqual({ ...remote, ai: publicAi }, local);
  } finally {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
});
