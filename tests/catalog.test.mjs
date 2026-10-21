import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const catalog = JSON.parse(await readFile(new URL('../data/catalog.json', import.meta.url), 'utf8'));
const { cities, universities, specialties } = catalog;
const cityMap = new Map(cities.map(city => [city.id, city]));

// Broken references would make an apparently selectable city show no results.
test('every city has actual catalog records and an accurate visible count', () => {
  assert.equal(cityMap.size, cities.length, 'city IDs must be unique');
  for (const city of cities) {
    const records = universities.filter(university => university.cityId === city.id);
    assert.ok(records.length > 0, `empty selectable city: ${city.name}`);
    assert.equal(city.universityCount, records.length, `wrong city count: ${city.name}`);
  }
  for (const university of universities) {
    assert.ok(cityMap.has(university.cityId), `missing city for ${university.name}`);
  }
});

// A branch's parent university name must not override its explicit local city.
test('branches in other cities remain separate from the parent university', () => {
  const examples = [
    ['Севастопольский филиал Московского государственного университета', 'Севастополь'],
    ['Ступинский филиал Московского авиационного института', 'Ступино'],
    ['Филиал в г. Миассе Южно-Уральского государственного университета', 'Миасс'],
    ['Филиал в г. Туапсе Ростовского государственного университета', 'Туапсе'],
    ['Набережночелнинский институт КФУ', 'Набережные Челны'],
  ];
  for (const [name, expectedCity] of examples) {
    const university = universities.find(record => record.name.startsWith(name));
    assert.ok(university, `missing explicitly named branch: ${name}`);
    assert.equal(cityMap.get(university.cityId).name, expectedCity);
    assert.equal(university.activeStatus, 'needs_verification', 'old snapshot cannot establish current branch status');
    assert.equal(university.sourceSnapshotYear, 2022);
    assert.ok(university.sources.some(source => source.url.includes('ae2ae0dd')));
  }
  assert.equal(cityMap.get(universities.find(record => record.id === 'msu').cityId).name, 'Москва');
});

test('featured profiles are readable, attributable and open safe official links', async () => {
  assert.equal(new Set(universities.map(university => university.id)).size, universities.length);
  for (const university of universities) {
    assert.ok(university.name.trim());
    assert.ok(university.description.trim());
    assert.ok(['http:', 'https:'].includes(new URL(university.website).protocol));
    assert.ok(university.sources?.some(source => ['http:', 'https:'].includes(new URL(source.url).protocol)));
  }
  for (const id of ['msu', 'hse', 'itmo', 'spbu', 'mipt', 'nsu', 'kfu', 'bmstu']) {
    const university = universities.find(record => record.id === id);
    assert.ok(university?.featured, `lost featured university: ${id}`);
    assert.ok(university.details.length > 150, `missing detailed profile: ${id}`);
    for (const photo of university.images) {
      if (photo.url.startsWith('/images/')) {
        await access(fileURLToPath(new URL(`../public${photo.url}`, import.meta.url)));
      } else {
        assert.equal(new URL(photo.url).protocol, 'https:');
      }
      assert.ok(photo.alt?.trim(), `photo lacks accessible text: ${id}`);
    }
  }
});

test('EGE selector contains unique undergraduate codes and searchable names', () => {
  assert.equal(new Set(specialties.map(specialty => specialty.code)).size, specialties.length);
  for (const specialty of specialties) {
    assert.match(specialty.code, /^\d{2}\.(03|05)\.\d{2}$/);
    assert.ok(specialty.name.trim());
    assert.ok(['Бакалавриат', 'Специалитет'].includes(specialty.level));
  }
  for (const code of ['09.03.01', '31.05.01', '38.03.01', '40.03.01', '54.03.01']) {
    assert.ok(specialties.some(specialty => specialty.code === code), `missing major education field: ${code}`);
  }
});

test('snapshot limitations are retained instead of claiming complete current registry coverage', () => {
  assert.equal(catalog.meta.complete, false);
  assert.ok(catalog.meta.sources.some(source => source.url.includes('hflabs/city')));
  assert.ok(catalog.meta.sources.some(source => source.url.includes('ParceVuzopedia')));
  assert.ok(catalog.meta.admissions.includes('год'));
});
