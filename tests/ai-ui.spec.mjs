import { test, expect } from '@playwright/test';

const year = new Date().getFullYear();
const universities = ['alpha', 'beta', 'gamma'].map((id, index) => ({
  id, name: `Технический университет ${index + 1}`, shortName: `Тех ${index + 1}`,
  cityId: 'moscow', website: `https://${id}.example.ru/`,
  description: 'Информатика и программирование', tags: ['Информатика'], images: [],
}));
const catalog = {
  meta: { source: 'browser test fixture' }, cities: [{ id: 'moscow', name: 'Москва' }],
  specialties: [{ code: '09.03.01', name: 'Информатика и вычислительная техника' }], universities,
  ai: { configured: true, used: false, provider: 'Yandex AI Studio', model: 'gpt://test-folder/yandexgpt/latest' },
};

const admission = {
  program: 'Информатика и вычислительная техника', code: '09.03.01', competitionGroup: 'Общий конкурс',
  campus: 'Москва', year, funding: 'budget', source: `https://alpha.example.ru/admissions/${year}/rules`,
  subjects: ['Русский язык', 'Математика', 'Информатика'], subjectMatch: true,
  examScore: 255, achievementPoints: 10, competitionScore: 265, maxScore: 310,
  eligible: true, unmetRequirements: [],
  budgetSeats: { value: 40, year, source: `https://alpha.example.ru/admissions/${year}/seats` },
  history: [264, 270, 260].map((value, index) => ({ value, year: year - index - 1,
    source: `https://alpha.example.ru/admissions/${year - index - 1}/results` })),
  scoreMargin: 1, applyUrl: 'https://alpha.example.ru/admissions/apply', chance: null,
  chanceReason: 'Нет проверенной модели вероятности зачисления.',
  historicalFit: { percent: 67, matchingYears: 2, totalYears: 3, years: [year - 1, year - 2, year - 3],
    method: 'historical_threshold_share', isProbability: false,
    description: 'В 2 из 3 сопоставимых лет результат был не ниже проходного балла. Это история приёма, не вероятность поступления.' },
  achievementDetails: [],
};

test('AI results distinguish historical percentage from chance, show verified admission action and remain usable on mobile', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/catalog', route => route.fulfill({ json: catalog }));
  await page.route('**/api/recommendations', async route => {
    const profile = route.request().postDataJSON();
    expect(profile.exams.reduce((sum, entry) => sum + entry.score, 0)).toBe(255);
    await route.fulfill({ json: {
      totalScore: 255, achievementPoints: null, profile,
      ai: { ...catalog.ai, used: true },
      notice: 'Правила и результаты приёма найдены в официальных источниках.',
      disclaimer: 'Прошлогодний проходной балл не гарантирует поступление.',
      recommendations: universities.map((university, index) => ({ university,
        reason: 'Программа соответствует предметам ЕГЭ.', passingScore: null,
        admission: index === 0 ? admission : null,
      })),
    } });
  });
  await page.route('**/api/universities/alpha*', route => route.fulfill({ json: { university: universities[0], ai: catalog.ai } }));
  await page.goto('/');
  await expect(page.locator('.university-card')).toHaveCount(3);
  await page.getByRole('button', { name: 'Подобрать мой вуз' }).click();
  const profile = page.getByRole('dialog', { name: 'Твой путь в университет' });
  await profile.getByRole('spinbutton', { name: 'Баллы: Русский язык', exact: true }).fill('90');
  await profile.getByRole('spinbutton', { name: 'Баллы: Математика (профильная)', exact: true }).fill('85');
  await profile.getByRole('spinbutton', { name: 'Баллы: Информатика', exact: true }).fill('80');
  await profile.getByRole('button', { name: 'Подобрать вуз', exact: true }).click();
  const results = page.getByRole('dialog', { name: 'Твоя подборка университетов' });
  await expect(results).toBeVisible();
  await expect(results.locator('.recommendation')).toHaveCount(3);
  await expect(results.locator('.analysis-status')).toContainText(/Yandex|Яндекс/);
  const checked = results.locator('.admissions-card').first();
  await expect(checked.locator('.chance-dial')).toContainText('67');
  await expect(checked).toContainText(/истори|прошл|сопоставим/i);
  await expect(checked.locator('.admission-score')).toContainText('265');
  await expect(checked).toContainText('310');
  await expect(checked).toContainText('40');
  const apply = checked.locator('.admission-apply');
  await expect(apply).toHaveAttribute('href', admission.applyUrl);
  await expect(apply).toHaveAttribute('target', '_blank');
  await expect(apply).toHaveAttribute('rel', 'noopener noreferrer');
  expect(await results.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await results.getByRole('button', { name: `Ознакомиться: ${universities[0].name}` }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: universities[0].shortName, exact: true })).toBeVisible();
});
