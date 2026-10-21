import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const artifactPath = resolve(process.cwd(), 'standalone/voooz.html');

async function offlinePage(page, context) {
  const networkRequests = [];
  await context.route(/^https?:\/\//, route => {
    networkRequests.push(route.request().url());
    return route.abort('internetdisconnected');
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  return { networkRequests, errors };
}

async function openFile(page) {
  // Managed Chromium disallows file:// navigation. Render the exact artifact
  // bytes in an opaque-origin viewer instead; all HTTP(S) remains blocked.
  await page.goto('about:blank');
  await page.setContent(await readFile(artifactPath, 'utf8'), { waitUntil: 'load' });
  await expect(page.locator('.university-card')).toHaveCount(9);
}

test('single HTML file renders its catalogue, bundled styles and data-URI photos without a server', async ({ page, context }) => {
  const { networkRequests, errors } = await offlinePage(page, context);
  await openFile(page);
  expect(await page.evaluate(() => typeof process)).toBe('undefined');
  await expect(page.getByRole('heading', { name: 'Ведущие вузы России.' })).toBeVisible();
  await expect(page.locator('script[src]')).toHaveCount(0);
  await expect(page.locator('link[rel="stylesheet"][href]')).toHaveCount(0);
  expect(await page.locator('.hero-photo').evaluate(element => getComputedStyle(element).borderTopLeftRadius)).not.toBe('0px');
  const hero = page.locator('.hero-photo img');
  await expect(hero).toBeVisible();
  await expect(hero).toHaveAttribute('src', /^data:image\//);
  await expect.poll(() => hero.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  await page.evaluate(() => document.fonts.ready);
  const photos = await page.locator('img').evaluateAll(images => images.map(image => ({ src: image.getAttribute('src'), loaded: image.complete && image.naturalWidth > 0 })));
  expect(photos.length).toBeGreaterThan(0);
  expect(photos.every(image => image.src?.startsWith('data:image/'))).toBe(true);
  const html = await readFile(artifactPath, 'utf8');
  expect(html).not.toContain('src="/src/main.jsx"');
  expect(networkRequests).toEqual([]);
  expect(errors).toEqual([]);
  await page.screenshot({ path: '/tmp/voooz-standalone-desktop.png', fullPage: true });
});

test('offline file supports city search and restricts universities to Kazan', async ({ page, context }) => {
  const { networkRequests, errors } = await offlinePage(page, context);
  await openFile(page);
  await page.getByRole('button', { name: 'Город', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Поиск города', exact: true }).fill('Казан');
  await dialog.locator('.city-list .city-option').filter({ hasText: /^Казань/ }).click();
  await expect(page.locator('.catalog-heading h2')).toContainText('Казань');
  const locations = await page.locator('.card-location').allTextContents();
  expect(locations.length).toBeGreaterThan(0);
  expect(locations.every(location => location.trim() === 'Казань')).toBe(true);
  expect(networkRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('offline file calculates 255 EGE points and produces specialty recommendations without API calls', async ({ page, context }) => {
  const { networkRequests, errors } = await offlinePage(page, context);
  await openFile(page);
  await page.getByRole('button', { name: 'Подобрать мой вуз', exact: true }).click();
  const profile = page.getByRole('dialog', { name: 'Твой путь в университет' });
  await expect(profile.getByRole('spinbutton')).toHaveCount(3);
  await profile.getByRole('spinbutton', { name: 'Баллы: Русский язык', exact: true }).fill('90');
  await profile.getByRole('spinbutton', { name: 'Баллы: Математика (профильная)', exact: true }).fill('85');
  await profile.getByRole('spinbutton', { name: 'Баллы: Информатика', exact: true }).fill('80');
  await expect(profile.locator('.score-total')).toHaveText('255баллов ЕГЭ');
  await profile.getByRole('button', { name: 'Специальность', exact: true }).click();
  await profile.getByRole('textbox', { name: 'Поиск специальности', exact: true }).fill('09.03.01');
  await profile.locator('.specialty-list button').filter({ hasText: '09.03.01' }).click();
  await expect(profile.locator('.accordion-trigger')).toContainText('Информатика');
  await profile.getByRole('button', { name: 'Подобрать вуз', exact: true }).click();
  const results = page.getByRole('dialog', { name: 'Твоя подборка университетов' });
  await expect(results).toBeVisible();
  await expect(results).toContainText('255 баллов ЕГЭ');
  await expect(results.locator('.recommendation').first()).toBeVisible();
  await expect(results.locator('.unverified-label').first()).toHaveText('Проходной балл требует проверки');
  expect(networkRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('offline file bookmarks universities and opens complete local details', async ({ page, context }) => {
  const { networkRequests, errors } = await offlinePage(page, context);
  await openFile(page);
  const first = page.locator('.university-card').first();
  const name = await first.locator('h3').innerText();
  await first.getByRole('button', { name: /^Сохранить/ }).click();
  await expect(first.locator('.save-button')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.header-saved').click();
  await expect(page.locator('.university-card')).toHaveCount(1);
  await expect(page.locator('.university-card h3')).toHaveText(name);
  await page.locator('.university-card').getByRole('button', { name: 'Подробнее', exact: true }).click();
  const detail = page.getByRole('dialog');
  await expect(detail.locator('.detail-main h3')).not.toBeEmpty();
  await expect(detail.locator('.detail-main .detail-lead')).not.toBeEmpty();
  await expect(detail.getByRole('link', { name: 'На сайт вуза' })).toHaveAttribute('href', /^https?:\/\//);
  expect(networkRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('HTML remains interactive with unavailable browser storage in an opaque-origin viewer', async ({ page, context }) => {
  const { networkRequests, errors } = await offlinePage(page, context);
  await page.setViewportSize({ width: 390, height: 844 });
  const html = await readFile(artifactPath, 'utf8');
  await page.goto('about:blank');
  const storageUnavailable = await page.evaluate(() => {
    try { localStorage.setItem('voooz-storage-check', '1'); return false; } catch { return true; }
  });
  expect(storageUnavailable).toBe(true);
  await page.setContent(html, { waitUntil: 'load' });
  await expect(page.locator('.university-card')).toHaveCount(9);
  await page.getByRole('button', { name: 'Подобрать мой вуз', exact: true }).click();
  const profile = page.getByRole('dialog', { name: 'Твой путь в университет' });
  await expect(profile).toBeVisible();
  await profile.getByRole('spinbutton', { name: 'Баллы: Русский язык', exact: true }).fill('70');
  await expect(profile.locator('.score-total')).toHaveText('70баллов ЕГЭ');
  await profile.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.locator('.university-card').first().getByRole('button', { name: /^Сохранить/ }).click();
  await expect(page.locator('.university-card').first().locator('.save-button')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: '/tmp/voooz-standalone-mobile.png', fullPage: true });
  expect(networkRequests).toEqual([]);
  expect(errors).toEqual([]);
});
