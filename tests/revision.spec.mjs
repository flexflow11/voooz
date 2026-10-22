import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Decoding the embedded photographs can be slow in the managed browser.
// Individual expectations keep their usual timeout; only the scenario gets room.
test.setTimeout(90_000);

async function load(page) {
  await page.goto('/');
  await expect(page.locator('.university-card').first()).toBeVisible();
}

async function openProfile(page) {
  await page.getByRole('button', { name: 'Подобрать мой вуз', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Твой путь в университет' });
  await expect(dialog).toBeVisible();
  return dialog;
}

function scores(dialog) {
  return [
    dialog.getByRole('spinbutton', { name: 'Баллы: Русский язык', exact: true }),
    dialog.getByRole('spinbutton', { name: 'Баллы: Математика (профильная)', exact: true }),
    dialog.getByRole('spinbutton', { name: 'Баллы: Информатика', exact: true }),
  ];
}

async function submit(dialog) {
  await dialog.getByRole('button', { name: 'Подобрать вуз', exact: true }).click();
}

test('empty EGE fields show styled accessible errors, focus the first invalid field and recover to a real 255-point response', async ({ page }) => {
  await load(page);
  const dialog = await openProfile(page);
  const inputs = scores(dialog);
  const normalBorder = await inputs[0].evaluate(input => getComputedStyle(input).borderColor);
  const requests = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/recommendations') && request.method() === 'POST') requests.push(request);
  });
  expect(await dialog.locator('form').evaluate(form => form.noValidate)).toBe(true);
  await submit(dialog);
  await expect(inputs[0]).toBeFocused();
  await expect(dialog.locator('.exam-field-error')).toHaveCount(3);
  for (let index = 0; index < inputs.length; index++) {
    await expect(inputs[index]).toHaveAttribute('aria-invalid', 'true');
    await expect(inputs[index]).toHaveAttribute('aria-describedby', new RegExp(`ege-score-error-${index}`));
    await expect(dialog.locator(`#ege-score-error-${index}`)).toContainText('Укажи балл за этот предмет');
  }
  await expect.poll(() => inputs[0].evaluate(input => getComputedStyle(input).borderColor)).not.toBe(normalBorder);
  expect(requests).toHaveLength(0);
  await dialog.screenshot({ path: '/tmp/voooz-ege-validation.png', animations: 'disabled' });
  await inputs[0].fill('90');
  await expect(dialog.locator('#ege-score-error-0')).not.toBeVisible();
  await expect(inputs[0]).not.toHaveAttribute('aria-invalid', 'true');
  await inputs[1].fill('85');
  await inputs[2].fill('80');
  await expect(dialog.locator('.exam-field-error')).toHaveCount(0);
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/recommendations') && response.request().method() === 'POST');
  await submit(dialog);
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect((await response.json()).totalScore).toBe(255);
  expect(requests).toHaveLength(1);
  const results = page.getByRole('dialog', { name: 'Твоя подборка университетов' });
  await expect(results).toContainText('255 баллов ЕГЭ');
  await expect(results.locator('.recommendation').first()).toBeVisible();
});

test('custom EGE validation distinguishes ranges and fractions, focuses the error and accepts zero', async ({ page }) => {
  await load(page);
  const dialog = await openProfile(page);
  const inputs = scores(dialog);
  let postCount = 0;
  page.on('request', request => {
    if (request.url().endsWith('/api/recommendations') && request.method() === 'POST') postCount++;
  });
  await inputs[0].fill('101');
  await inputs[1].fill('85');
  await inputs[2].fill('80');
  await submit(dialog);
  await expect(inputs[0]).toBeFocused();
  await expect(dialog.locator('#ege-score-error-0')).toContainText('Баллы должны быть от 0 до 100');
  expect(postCount).toBe(0);
  await inputs[0].fill('90');
  await inputs[1].fill('85.5');
  await submit(dialog);
  await expect(inputs[1]).toBeFocused();
  await expect(dialog.locator('#ege-score-error-1')).toContainText('Укажи целое число');
  await expect(dialog.locator('#ege-score-error-0')).not.toBeVisible();
  expect(postCount).toBe(0);
  await inputs[0].fill('0');
  await inputs[1].fill('85');
  await expect(dialog.locator('.exam-field-error')).toHaveCount(0);
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/recommendations') && response.request().method() === 'POST');
  await submit(dialog);
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(result.totalScore).toBe(165);
  expect(result.profile.exams[0].score).toBe(0);
  expect(postCount).toBe(1);
  await expect(page.getByRole('dialog', { name: 'Твоя подборка университетов' })).toContainText('165 баллов ЕГЭ');
});

test('hero has a meaningful three-step journey whose city, profile and catalogue actions work', async ({ page }) => {
  await load(page);
  await expect(page.locator('.hero-avatars')).toHaveCount(0);
  const journey = page.locator('.hero-journey');
  await expect(journey).toBeVisible();
  const buttons = journey.getByRole('button');
  await expect(buttons).toHaveCount(3);
  const labels = (await buttons.allTextContents()).map(label => label.trim());
  expect(labels.every(label => label.length > 3)).toBe(true);
  expect(new Set(labels).size).toBe(3);
  await buttons.nth(0).click();
  const city = page.getByRole('dialog');
  await expect(city.getByRole('textbox', { name: 'Поиск города', exact: true })).toBeVisible();
  await city.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await buttons.nth(1).click();
  const profile = page.getByRole('dialog', { name: 'Твой путь в университет' });
  await expect(profile).toBeVisible();
  await profile.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await buttons.nth(2).click();
  await expect(page.locator('.catalog-heading h2')).toBeInViewport();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(journey).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('standalone HTML shows the same custom EGE validation without native dialogs or networking', async ({ page, context }) => {
  const networkRequests = [];
  await context.route(/^https?:\/\//, route => {
    networkRequests.push(route.request().url());
    return route.abort('internetdisconnected');
  });
  const html = await readFile(resolve(process.cwd(), 'standalone/voooz.html'), 'utf8');
  await page.goto('about:blank');
  await page.setContent(html, { waitUntil: 'load' });
  await expect(page.locator('.university-card').first()).toBeVisible();
  const hse = page.locator('.university-card').filter({ has: page.getByRole('heading', { name: 'НИУ ВШЭ', exact: true }) });
  const campusPhoto = hse.locator('img.card-photo');
  await expect(campusPhoto).toHaveAttribute('src', /^data:image\//);
  await expect.poll(() => campusPhoto.evaluate(image => image.complete && image.naturalWidth > 400)).toBe(true);
  expect(await page.locator('.university-card img.card-photo').count()).toBeGreaterThanOrEqual(6);
  const dialog = await openProfile(page);
  const inputs = scores(dialog);
  expect(await dialog.locator('form').evaluate(form => form.noValidate)).toBe(true);
  await submit(dialog);
  await expect(inputs[0]).toBeFocused();
  await expect(dialog.locator('.exam-field-error')).toHaveCount(3);
  await expect(dialog.locator('#ege-score-error-0')).toContainText('Укажи балл за этот предмет');
  await inputs[0].fill('90');
  await inputs[1].fill('85');
  await inputs[2].fill('80');
  await expect(dialog.locator('.exam-field-error')).toHaveCount(0);
  await submit(dialog);
  await expect(page.getByRole('dialog', { name: 'Твоя подборка университетов' })).toContainText('255 баллов ЕГЭ');
  expect(networkRequests).toEqual([]);
});
