import { test, expect } from '@playwright/test';

const universities = ['alpha', 'beta', 'gamma'].map((id, index) => ({
  id, name: `Технический университет ${index + 1}`, shortName: `Тех ${index + 1}`,
  cityId: 'moscow', website: `https://${id}.example.ru/`, images: [],
  description: 'Информатика и программирование', tags: ['Информатика'],
}));
const ai = { configured: true, used: false, provider: 'Qwen · Ollama', model: 'qwen2.5:0.5b' };
const catalog = {
  meta: { source: 'browser test fixture' }, cities: [{ id: 'moscow', name: 'Москва' }],
  specialties: [{ code: '09.03.01', name: 'Информатика и вычислительная техника' }],
  universities, ai,
};

test('local-model UI identifies Qwen, keeps score arithmetic and does not describe a paid cloud provider', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/catalog', route => route.fulfill({ json: catalog }));
  await page.route('**/api/recommendations', async route => {
    const profile = route.request().postDataJSON();
    expect(profile.exams.reduce((sum, exam) => sum + exam.score, 0)).toBe(300);
    await route.fulfill({ json: {
      totalScore: 300, achievementPoints: null, profile, ai: { ...ai, used: true },
      recommendations: universities.map(university => ({ university,
        reason: 'Нужно уточнить условия конкретной программы по официальным страницам.',
        passingScore: null, admission: null,
      })),
      notice: 'Qwen обработала найденные страницы. Для конкурсного балла пока недостаточно данных.',
      disclaimer: 'Прошлогодний проходной балл не гарантирует поступление.',
    } });
  });
  await page.goto('/');
  await expect(page.locator('.university-card')).toHaveCount(3);
  await page.getByRole('button', { name: 'Подобрать мой вуз' }).click();
  const form = page.getByRole('dialog', { name: 'Твой путь в университет' });
  await expect(form.locator('.privacy-note')).not.toContainText(/Yandex|Яндекс|OpenAI/);
  await expect(form.locator('.privacy-note')).toContainText(/сервер|Qwen|Ollama/i);
  for (const name of ['Русский язык', 'Математика (профильная)', 'Информатика']) {
    await form.getByRole('spinbutton', { name: `Баллы: ${name}`, exact: true }).fill('100');
  }
  await form.getByRole('button', { name: 'Подобрать вуз', exact: true }).click();
  const results = page.getByRole('dialog', { name: 'Твоя подборка университетов' });
  await expect(results).toBeVisible();
  await expect(results.locator('.analysis-status')).toContainText(/Qwen|Ollama/);
  await expect(results.locator('.analysis-status')).not.toContainText(/Yandex|Яндекс|OpenAI/);
  await expect(results.locator('.recommendation')).toHaveCount(3);
  await expect(results.locator('.chance-dial').first()).toContainText('—');
  await expect(results.locator('.admission-apply')).toHaveCount(0);
  expect(await results.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await results.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.getByRole('button', { name: 'О проекте' }).click();
  const about = page.getByRole('dialog', { name: 'ВОООЗ — пространство выбора' });
  await expect(about).toContainText(/Qwen|Ollama/);
  await expect(about).not.toContainText(/Yandex|Яндекс|OpenAI/);
});
