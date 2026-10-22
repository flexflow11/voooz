import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAdmissionProgram } from '../shared/admissions.mjs';

const university = { id: 'demo', website: 'https://university.ru/', name: 'Университет' };
const sources = new Set(['https://university.ru/admission/rules', 'https://university.ru/admission/seats', 'https://university.ru/admission/achievements', 'https://university.ru/apply', ...[2022, 2023, 2024, 2025, 2026].map(year => `https://university.ru/results/${year}`)]);
const profile = { exams: [{ subject: 'Русский язык', score: 100 }, { subject: 'Математика', score: 100 }, { subject: 'Информатика', score: 100 }, { subject: 'Физика', score: 95 }, { subject: 'Химия', score: 90 }], achievements: { certificate: 'Золотая медаль', gto: 'Золотой' } };
function fixture() {
  return {
    program: 'Информатика и вычислительная техника', code: '09.03.01', competitionGroup: '09.03.01-очная-бюджет', campus: 'Москва', year: 2026, funding: 'budget', source: 'https://university.ru/admission/rules', additionalTests: false,
    examOptions: [[{ subject: 'Русский язык', minimum: 40 }, { subject: 'Математика', minimum: 40 }, { subject: 'Информатика', minimum: 40 }], [{ subject: 'Русский язык', minimum: 40 }, { subject: 'Математика', minimum: 40 }, { subject: 'Физика', minimum: 40 }]],
    budgetSeats: { value: 50, year: 2026, source: 'https://university.ru/admission/seats', competitionGroup: '09.03.01-очная-бюджет', campus: 'Москва' },
    achievementRules: { year: 2026, source: 'https://university.ru/admission/achievements', maxPoints: 10, complete: true, items: [
      { key: 'certificate', value: 'Золотая медаль', points: 8, description: 'Баллы за золотую медаль по заявленным данным.', conditionsComplete: true, requiresDocuments: true },
      { key: 'gto', value: 'Золотой', points: 5, description: 'Баллы за действующий золотой знак ГТО.', conditionsComplete: true, requiresDocuments: true },
    ] },
    history: [2023, 2024, 2025].map((year, index) => ({ value: 280 + index * 10, year, source: `https://university.ru/results/${year}`, type: 'last_admitted', subjects: ['Русский язык', 'Математика', 'Информатика'], funding: 'budget', competitionGroup: '09.03.01-очная-бюджет', campus: 'Москва', maxScore: 310, includesAchievements: true, budgetSeats: { value: 50, year, source: `https://university.ru/results/${year}`, competitionGroup: '09.03.01-очная-бюджет', campus: 'Москва' } })),
    application: { url: 'https://university.ru/apply', source: 'https://university.ru/admission/rules' },
  };
}
const checked = (raw = fixture(), person = profile, cited = sources) => validateAdmissionProgram(raw, cited, university, person, { currentYear: 2026 });

test('chooses required triple from five exams and caps university-specific bonuses at ten', () => {
  const answer = checked();
  assert.equal(answer.examScore, 300);
  assert.equal(answer.achievementPoints, 10);
  assert.equal(answer.competitionScore, 310);
  assert.equal(answer.achievementBasis, 'self_reported');
  assert.deepEqual(answer.subjects, ['Русский язык', 'Математика', 'Информатика']);
  assert.equal(answer.budgetSeats.value, 50);
  const other = fixture(); other.achievementRules.maxPoints = 3;
  assert.equal(checked(other).competitionScore, 303);
});

test('uses lower-scoring eligible exam option when the larger total misses a per-subject minimum', () => {
  const raw = fixture(); raw.examOptions[0][2].minimum = 90;
  const answer = checked(raw, { ...profile, exams: [{ subject: 'Русский язык', score: 100 }, { subject: 'Математика', score: 100 }, { subject: 'Информатика', score: 89 }, { subject: 'Физика', score: 85 }] });
  assert.equal(answer.eligible, true);
  assert.equal(answer.examScore, 285);
  assert.deepEqual(answer.subjects, ['Русский язык', 'Математика', 'Физика']);
});

test('ignores model percentages and shows a descriptive historical share only for three comparable years', () => {
  const raw = fixture(); raw.chance = 99; raw.probability = 99;
  const person = { exams: [{ subject: 'Русский язык', score: 95 }, { subject: 'Математика', score: 95 }, { subject: 'Информатика', score: 95 }], achievements: {} };
  const answer = checked(raw, person);
  assert.equal(answer.chance, null);
  assert.equal(answer.historicalFit.percent, 33);
  assert.equal(answer.historicalFit.matchingYears, 1);
  assert.equal(answer.historicalFit.totalYears, 3);
  assert.equal(answer.historicalFit.isProbability, false);
  raw.budgetSeats.value = 60;
  assert.equal(checked(raw, person).historicalFit, null);
  raw.budgetSeats.value = 50; raw.history.pop();
  assert.equal(checked(raw, person).historicalFit, null);
});

test('requires independent official citations and the precise program, campus and year for all figures', () => {
  const raw = fixture(); raw.source = 'https://university.ru/model-only';
  assert.equal(checked(raw), null);
  raw.source = 'https://university.ru/admission/rules';
  raw.budgetSeats.competitionGroup = 'весь вуз';
  raw.history[0].campus = 'другой город';
  raw.application.url = university.website;
  const answer = checked(raw);
  assert.equal(answer.budgetSeats, null);
  assert.equal(answer.history.length, 2);
  assert.equal(answer.historicalFit, null);
  assert.equal(answer.applyUrl, null);
  raw.achievementRules.source = 'https://other.ru/achievements';
  assert.equal(checked(raw).achievementPoints, null);
});

test('does not award vague or incomplete achievements or double count exclusive categories', () => {
  assert.equal(checked(fixture(), { ...profile, achievements: { gto: true } }).achievementPoints, null);
  const raw = fixture(); raw.achievementRules.items[1].conditionsComplete = false;
  assert.equal(checked(raw).achievementPoints, null);
  raw.achievementRules.items[1].conditionsComplete = true;
  raw.achievementRules.items.forEach(item => { item.exclusiveGroup = 'one_bonus'; });
  assert.equal(checked(raw).achievementPoints, 8);
  const olympiad = checked(raw, { ...profile, achievements: { olympiad: 'Победитель' } });
  assert.equal(olympiad.achievementPoints, 0);
  assert.match(olympiad.olympiadNotice, /отдельно/);
});

test('unknown requirements, additional exams and incompatible historical scales cannot create an admission estimate', () => {
  const raw = fixture(); raw.additionalTests = true;
  const answer = checked(raw);
  assert.equal(answer.competitionScore, null);
  assert.equal(answer.eligible, null);
  assert.equal(answer.historicalFit, null);
  delete raw.additionalTests;
  assert.equal(checked(raw), null);
  raw.additionalTests = false; raw.history[0].maxScore = 410;
  assert.equal(checked(raw).history.length, 2);
  raw.history = [raw.history[1], structuredClone(raw.history[1]), raw.history[2]];
  assert.equal(checked(raw).history.length, 1);
  const missing = checked(fixture(), { exams: profile.exams.slice(0, 2), achievements: {} });
  assert.equal(missing.subjectMatch, false);
  assert.equal(missing.examScore, null);
  assert.equal(missing.competitionScore, null);
  assert.equal(missing.eligible, false);
});

test('a verified zero-seat budget competition is explicitly unavailable', () => {
  const raw = fixture(); raw.budgetSeats.value = 0;
  const answer = checked(raw);
  assert.equal(answer.eligible, false);
  assert.equal(answer.budgetSeats.value, 0);
  assert.match(answer.unmetRequirements.join(' '), /нет бюджетных мест/);
  assert.equal(answer.historicalFit, null);
});
