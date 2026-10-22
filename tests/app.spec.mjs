import { test, expect } from '@playwright/test';

async function loaded(page) {
  await page.goto('/');
  await expect(page.locator('.university-card').first()).toBeVisible();
}

async function openProfile(page) {
  await page.getByRole('button', { name: 'Подобрать мой вуз' }).click();
  return page.getByRole('dialog', { name: 'Твой путь в университет' });
}

async function screenshot(page, path) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800); // Finish entrance animations before visual review.
  await page.screenshot({ path, fullPage: true });
}

test('catalogue, city search and city restriction work together', async ({ page }) => {
  await loaded(page);
  await expect(page.getByRole('heading', { name: 'Ведущие вузы России.' })).toBeVisible();
  await screenshot(page, '/tmp/voooz-desktop.png');
  await page.getByRole('button', { name: 'Город', exact: true }).click();
  const cityDialog = page.getByRole('dialog');
  await cityDialog.getByRole('textbox', { name: 'Поиск города' }).fill('Казан');
  const choice = cityDialog.locator('.city-list .city-option').filter({ hasText: /^Казань/ });
  await expect(choice).toHaveCount(1);
  await choice.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.catalog-heading h2')).toContainText('Казань');
  const locations = await page.locator('.card-location').allTextContents();
  expect(locations.length).toBeGreaterThan(0);
  expect(locations.every(text => text.trim() === 'Казань')).toBe(true);
  await page.reload();
  await expect(page.locator('.catalog-heading h2')).toContainText('Казань');
  await page.getByRole('textbox', { name: 'Поиск вуза', exact: true }).fill('КФУ');
  await expect(page.locator('.university-card')).toHaveCount(1);
  await expect(page.locator('.university-card')).toContainText('Казанский');
});

test('bookmark survives reload and detailed card opens an official website', async ({ page }) => {
  await loaded(page);
  const card = page.locator('.university-card').first();
  const title = await card.locator('h3').innerText();
  const save = card.getByRole('button', { name: /^Сохранить/ });
  await save.click();
  await expect(card.locator('.save-button')).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.locator('.university-card').first().locator('.save-button')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.header-saved').click();
  await expect(page.locator('.university-card')).toHaveCount(1);
  await expect(page.locator('.university-card h3')).toHaveText(title);
  await page.locator('.university-card').getByRole('button', { name: 'Подробнее', exact: true }).click();
  const detail = page.getByRole('dialog');
  await expect(detail.locator('.detail-main h3')).not.toBeEmpty();
  const website = detail.getByRole('link', { name: 'На сайт вуза' });
  await expect(website).toHaveAttribute('href', /^https?:\/\//);
  await expect(website).toHaveAttribute('target', '_blank');
  await expect(website).toHaveAttribute('rel', 'noopener noreferrer');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('category and text filters have useful empty and reset states', async ({ page }) => {
  await loaded(page);
  await page.getByRole('button', { name: 'Медицина', exact: true }).click();
  await expect(page.locator('.university-card').first()).toBeVisible();
  await expect(page.locator('.category-tabs .active')).toHaveText('Медицина');
  await page.getByRole('textbox', { name: 'Поиск вуза', exact: true }).fill('несуществующий-университет-123');
  await expect(page.locator('.university-card')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'По этим условиям вузов пока нет' })).toBeVisible();
  await page.getByRole('button', { name: 'Смотреть все вузы' }).click();
  await expect(page.locator('.university-card').first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Поиск вуза', exact: true })).toHaveValue('');
});

test('profile sums scores, searches specialty, includes achievements and obtains honest recommendations', async ({ page }) => {
  await loaded(page);
  const form = await openProfile(page);
  await form.getByRole('spinbutton', { name: 'Баллы: Русский язык', exact: true }).fill('90');
  await form.getByRole('spinbutton', { name: 'Баллы: Математика (профильная)', exact: true }).fill('85');
  await form.getByRole('spinbutton', { name: 'Баллы: Информатика', exact: true }).fill('80');
  await expect(form.locator('.score-total')).toHaveText('255баллов ЕГЭ');
  await form.getByRole('button', { name: 'Специальность', exact: true }).click();
  await form.getByRole('textbox', { name: 'Поиск специальности', exact: true }).fill('09.03.01');
  await form.locator('.specialty-list button').filter({ hasText: '09.03.01' }).click();
  await expect(form.locator('.accordion-trigger')).toContainText('Информатика');
  await form.locator('summary').filter({ hasText: 'Знак ГТО' }).click();
  await form.getByRole('combobox', { name: 'Знак ГТО', exact: true }).selectOption('Золотой');
  await form.getByRole('textbox', { name: 'Примечание к достижениям' }).fill('Золотой знак ГТО; документы проверю в вузе');
  const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/recommendations') && r.request().method() === 'POST');
  await form.getByRole('button', { name: 'Подобрать вуз', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.totalScore).toBe(255);
  expect(body.achievementPoints).toBeNull();
  expect(body.profile.specialty).toBe('09.03.01');
  expect(body.profile.achievements.gto).toBe('Золотой');
  expect(body.profile.notes).toContain('Золотой знак ГТО');
  expect(body.recommendations.length).toBeGreaterThan(0);
  expect(body.recommendations.every(r => r.passingScore === null)).toBe(true);
  const results = page.getByRole('dialog', { name: 'Твоя подборка университетов' });
  await expect(results).toContainText('255 баллов ЕГЭ');
  await expect(results.locator('.recommendation').first()).toBeVisible();
  await expect(results.locator('.unverified-label').first()).toHaveText('Проходной балл требует проверки');
  await results.getByRole('button', { name: 'Изменить анкету' }).click();
  await expect(page.getByRole('dialog', { name: 'Твой путь в университет' })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Баллы: Русский язык', exact: true })).toHaveValue('90');
});

test('out-of-range scores cannot submit and additional exams prevent repeated language selection', async ({ page }) => {
  await loaded(page);
  const form = await openProfile(page);
  await form.getByRole('spinbutton', { name: 'Баллы: Русский язык', exact: true }).fill('101');
  await form.getByRole('spinbutton', { name: 'Баллы: Математика (профильная)', exact: true }).fill('85');
  await form.getByRole('spinbutton', { name: 'Баллы: Информатика', exact: true }).fill('80');
  expect(await form.getByRole('spinbutton', { name: 'Баллы: Русский язык', exact: true }).evaluate(input => input.checkValidity())).toBe(false);
  let submissions = 0;
  page.on('request', request => { if (request.url().endsWith('/api/recommendations') && request.method() === 'POST') submissions++; });
  await form.getByRole('button', { name: 'Подобрать вуз', exact: true }).click();
  await expect(form).toBeVisible();
  await expect(form.locator('#ege-score-error-0')).toContainText('Баллы должны быть от 0 до 100');
  await expect(form.getByRole('spinbutton', { name: 'Баллы: Русский язык', exact: true })).toHaveAttribute('aria-invalid', 'true');
  expect(submissions).toBe(0);
  await form.getByRole('button', { name: 'Добавить предмет' }).click();
  await form.getByRole('combobox', { name: 'Предмет 4', exact: true }).selectOption('Немецкий язык');
  await form.getByRole('button', { name: 'Добавить предмет' }).click();
  const fifth = form.getByRole('combobox', { name: 'Предмет 5', exact: true });
  await expect(fifth.locator('option', { hasText: 'Английский язык' })).toBeDisabled();
  await expect(fifth.locator('option', { hasText: 'Китайский язык' })).toBeDisabled();
  await expect(form.getByRole('button', { name: 'Добавить предмет' })).toHaveCount(0);
  await form.getByRole('button', { name: 'Удалить предмет 5' }).click();
  await expect(form.getByRole('combobox', { name: 'Предмет 5', exact: true })).toHaveCount(0);
  await expect(form.getByRole('button', { name: 'Добавить предмет' })).toBeVisible();
});

for (const width of [375, 390]) {
  test(`mobile ${width}px has no horizontal overflow and navigation opens usable forms`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await loaded(page);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(await overflow()).toBe(false);
    const nav = page.getByRole('navigation', { name: 'Мобильная навигация' });
    await expect(nav).toBeVisible();
    if (width === 390) await screenshot(page, '/tmp/voooz-mobile.png');
    await nav.getByRole('button', { name: 'Подбор', exact: true }).click();
    const profile = page.getByRole('dialog', { name: 'Твой путь в университет' });
    await expect(profile).toBeVisible();
    expect(await overflow()).toBe(false);
    await expect(profile.getByRole('spinbutton', { name: 'Баллы: Русский язык', exact: true })).toBeVisible();
    await profile.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await nav.getByRole('button', { name: 'Избранное', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Сохранено на будущее.' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Твоё будущее пока на чистом листе' })).toBeVisible();
    expect(await overflow()).toBe(false);
  });
}

test('old or malformed saved JSON recovers to a usable catalogue and profile', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('voooz-profile', '{}');
    localStorage.setItem('voooz-saved', '{}');
    localStorage.setItem('voooz-city', '[]');
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await loaded(page);
  await expect(page.getByRole('button', { name: 'Город', exact: true })).toBeVisible();
  const profile = await openProfile(page);
  await expect(profile.getByRole('combobox', { name: 'Предмет 1', exact: true })).toHaveValue('Русский язык');
  await expect(profile.getByRole('spinbutton')).toHaveCount(3);
  expect(errors).toEqual([]);
});
