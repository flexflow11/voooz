/** Optional Telegram launcher. The Mini App itself also works in a normal browser. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export function validateWebAppUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || url.hostname === 'localhost' || url.hostname.endsWith('.local') || /^\d+(\.\d+){3}$/.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

export async function runTelegramBot({ token = process.env.TELEGRAM_BOT_TOKEN, webAppUrl = process.env.TELEGRAM_WEBAPP_URL, fetchImpl = fetch, signal, waitImpl = (ms, signal) => delay(ms, undefined, { signal }), maxRetries = 6 } = {}) {
  if (!token) throw new Error('Добавьте TELEGRAM_BOT_TOKEN в серверные настройки. Не публикуйте токен.');
  const appUrl = validateWebAppUrl(webAppUrl);
  if (!appUrl) throw new Error('Укажите публичный HTTPS-адрес приложения в TELEGRAM_WEBAPP_URL.');
  if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Неверный формат TELEGRAM_BOT_TOKEN.');
  const retries = Number.isInteger(maxRetries) ? Math.max(0, Math.min(maxRetries, 8)) : 6;
  const failure = (message, transient = false, retryAfterMs = 0) => Object.assign(new Error(message), { transient, retryAfterMs });
  const request = async (method, payload) => {
    let response;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40_000)]) : AbortSignal.timeout(40_000),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw failure('Telegram недоступен. Проверьте подключение и разрешённый домен api.telegram.org.', true);
    }
    let result;
    try { result = await response.json(); }
    catch {
      if (signal?.aborted) throw signal.reason;
      throw failure('Telegram вернул некорректный ответ. Попробуйте запустить бота позже.', response.ok || response.status === 429 || response.status >= 500);
    }
    const code = response.ok ? Number(result?.error_code) : response.status;
    const retryAfterMs = Number(result?.parameters?.retry_after) * 1000;
    if (!response.ok || !result?.ok) throw failure(
      'Telegram не выполнил запрос. Проверьте токен, доступность сервиса и отсутствие другого запущенного экземпляра бота.',
      code === 429 || code >= 500,
      Number.isFinite(retryAfterMs) ? retryAfterMs : 0,
    );
    return result.result;
  };
  const api = async (method, payload) => {
    for (let attempt = 0; ; attempt++) {
      try { return await request(method, payload); }
      catch (error) {
        if (signal?.aborted || !error.transient || attempt >= retries) throw error;
        const waitMs = Math.min(30_000, Math.max(1000 * 2 ** attempt, error.retryAfterMs || 0));
        await waitImpl(waitMs, signal);
      }
    }
  };
  await api('getMe', {});
  await api('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Открыть VOOOZ', web_app: { url: appUrl } } });
  await api('setMyCommands', { commands: [{ command: 'start', description: 'Подобрать вуз' }, { command: 'help', description: 'Как пользоваться VOOOZ' }] });
  console.log('VOOOZ Telegram: команды и меню настроены; ожидание сообщений.');
  let offset = 0;
  while (!signal?.aborted) {
    const updates = await api('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1);
      const message = update.message;
      if (!message?.text || message.chat?.type !== 'private') continue;
      const command = message.text.split(/\s/)[0].split('@')[0];
      if (command === '/start' || command === '/help') await api('sendMessage', {
        chat_id: message.chat.id,
        text: 'Привет! Это VOOOZ — навигатор по вузам. Выберите город, изучите университеты и укажите предметы ЕГЭ для тематического подбора. Проходные баллы и правила приёма проверяйте на официальных сайтах вузов.',
        reply_markup: { inline_keyboard: [[{ text: 'Найти свой вуз ↗', web_app: { url: appUrl } }]] },
      });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
  runTelegramBot({ signal: controller.signal }).catch(e => {
    if (!controller.signal.aborted) { console.error(e.message); process.exitCode = 1; }
  });
}
