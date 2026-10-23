import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createResearch, safeUrl, sameOrganization, validatePassingScore, publicAiError } from './ai.mjs';
import { createYandexResearch } from './yandex.mjs';
import { createOllamaResearch } from './ollama.mjs';
import { createEvidenceCollector } from './evidence.mjs';
import { validateAdmissionProgram } from '../shared/admissions.mjs';
import { admissionsRequest } from './admissions-prompt.mjs';
import { localAdmissionsRequest } from './local-admissions-prompt.mjs';
import { createCatalogRecommendations, filterUniversities, localRecommendations, localReason, noKeyNotice } from '../shared/catalog.mjs';
export { validateProfile } from '../shared/catalog.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function str(v, max = 200) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); }
function error(message, status = 400) { return Object.assign(new Error(message), { status }); }


function safeUniversity(raw, sources, cityId) {
  if (!raw || typeof raw !== 'object') return null;
  const website = safeUrl(raw.website);
  if (!website || ![...sources].some(s => sameOrganization(s, website))) return null;
  const name = str(raw.name, 240);
  if (name.length < 4) return null;
  return {
    id: `ai-${createHash('sha256').update(website).digest('hex').slice(0, 12)}`,
    name, shortName: str(raw.shortName, 80) || name,
    cityId, description: str(raw.description, 800), details: str(raw.details, 3000), website,
    images: [], tags: Array.isArray(raw.tags) ? raw.tags.filter(t => typeof t === 'string').map(t => str(t, 80)).slice(0, 12) : [],
    sources: [...sources].filter(s => sameOrganization(s, website)).slice(0, 5), aiGenerated: true,
  };
}


async function readBody(req) {
  let size = 0, body = '';
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32_768) throw error('Слишком большой запрос.', 413);
    body += chunk;
  }
  try { return JSON.parse(body); } catch { throw error('Некорректный JSON.'); }
}

export async function createServer(options = {}) {
  const catalog = options.catalog || JSON.parse(await readFile(resolve(root, 'data/catalog.json'), 'utf8'));
  const provider = options.aiProvider ?? process.env.VOOOZ_AI_PROVIDER ?? 'ollama';
  if (!['ollama', 'yandex', 'openai'].includes(provider)) throw new Error('Неизвестный провайдер AI.');
  const aiOptions = {
    key: options.aiKey ?? (provider === 'yandex' ? process.env.YANDEX_API_KEY : process.env.VOOOZ_AI_API_KEY ?? process.env.OPENAI_API_KEY),
    folderId: options.folderId ?? process.env.YANDEX_FOLDER_ID,
    model: options.model ?? (provider === 'ollama' ? process.env.OLLAMA_MODEL : provider === 'yandex' ? process.env.YANDEX_MODEL : process.env.VOOOZ_AI_MODEL),
    baseUrl: options.ollamaUrl ?? process.env.OLLAMA_BASE_URL,
    fetchImpl: options.fetchImpl,
    cacheDir: options.cacheDir === false ? undefined : options.cacheDir ?? resolve(root, '.cache/research'),
  };
  const ai = provider === 'ollama' ? createOllamaResearch(aiOptions) : provider === 'yandex' ? createYandexResearch(aiOptions) : createResearch(aiOptions);
  const evidenceCollector = provider === 'ollama' ? options.evidenceCollector ?? createEvidenceCollector({ fetchImpl: options.evidenceFetchImpl, maxTextChars: 6000 }) : null;
  let localStatus = { available: false, modelInstalled: false };
  let healthCheckedAt = 0, healthPending;
  async function refreshLocalStatus() {
    if (provider !== 'ollama' || Date.now() - healthCheckedAt < 10_000) return;
    if (healthPending) return healthPending;
    healthPending = (async () => {
      try { localStatus = await ai.checkHealth(); }
      catch { localStatus = { available: false, modelInstalled: false }; }
      healthCheckedAt = Date.now();
    })();
    try { await healthPending; } finally { healthPending = undefined; }
  }
  const aiAvailable = () => ai.configured && (provider !== 'ollama' || localStatus.available && localStatus.modelInstalled);
  const unavailableNotice = () => provider !== 'ollama' ? noKeyNotice
    : localStatus.available ? 'Модель Qwen ещё не загружена на сервер. Пока доступен подбор по каталогу.'
      : 'Локальная нейросеть пока не запущена. Показан подбор по каталогу.';
  const researchError = e => provider !== 'ollama' ? publicAiError(e)
    : e.message === 'AI_EVIDENCE' ? 'Не удалось загрузить официальные страницы вузов. Показан каталог; баллы и места без источников не оцениваются.'
      : e.name === 'TimeoutError' || e.name === 'AbortError' ? 'Локальная модель не успела ответить. Пока показан подбор по каталогу.'
        : 'Локальная Qwen сейчас недоступна или вернула неполный ответ. Показан подбор по каталогу.';
  const dynamic = new Map();
  const requests = new Map();
  const aiInfo = used => ({ configured: aiAvailable(), used, provider: provider === 'ollama' ? 'Qwen · Ollama' : provider === 'yandex' ? 'Yandex AI Studio' : 'OpenAI', model: ai.model });
  const allUniversities = () => [...catalog.universities, ...dynamic.values()];
  const rateLimit = req => {
    const ip = req.socket.remoteAddress;
    const now = Date.now();
    const previous = requests.get(ip);
    if (!previous || now - previous.start > 60_000) { requests.set(ip, { start: now, count: 1 }); return; }
    if (++previous.count > 12) throw error('Слишком много запросов. Попробуйте через минуту.', 429);
    // Bound memory independently of untrusted proxy headers.
    if (requests.size > 500) for (const [key, value] of requests) if (now - value.start > 60_000) requests.delete(key);
  };

  async function searchCity(cityId) {
    // The local model cannot discover arbitrary websites without a search service.
    if (provider === 'ollama') return [];
    const city = catalog.cities.find(c => c.id === cityId);
    const answer = await ai.research('universities_in_city', {
      city: city.name,
      request: 'Найди до 12 действующих вузов в этом городе России. Не включай вузы из других городов. Сначала известные исследовательские университеты; не выдумывай числовой рейтинг. Формат: {"universities":[{"name":"полное название","shortName":"название","website":"официальный HTTPS URL","description":"кратко","details":"подробнее","tags":["направление"]}]}. Подтверди официальные сайты поисковыми источниками.',
    });
    const universities = (answer?.result.universities || []).slice(0, 12).map(u => safeUniversity(u, answer.sources, cityId)).filter(Boolean);
    for (const u of universities) {
      const local = catalog.universities.find(v => sameOrganization(u.website, v.website));
      if (!local) dynamic.set(u.id, u);
    }
    return universities;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (path.startsWith('/api/')) await refreshLocalStatus();
      if (path === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, ai: aiInfo(false), ...(provider === 'ollama' ? { ollama: { available: Boolean(localStatus.available), modelInstalled: Boolean(localStatus.modelInstalled) } } : {}), telegram: { configured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_WEBAPP_URL) } });
      if (path === '/api/catalog' && req.method === 'GET') return json(res, 200, { ...catalog, ai: aiInfo(false) });
      if (path === '/api/universities' && req.method === 'GET') {
        const city = str(url.searchParams.get('city'), 100);
        const q = str(url.searchParams.get('q'), 100).toLocaleLowerCase('ru');
        const category = str(url.searchParams.get('category'), 100).toLocaleLowerCase('ru');
        if (city && !catalog.cities.some(c => c.id === city)) throw error('Город не найден.', 404);
        let notice = aiAvailable() ? undefined : unavailableNotice(), used = false;
        if (city && provider !== 'ollama' && aiAvailable() && !allUniversities().some(u => u.cityId === city)) {
          rateLimit(req);
          try { const found = await searchCity(city); used = true; if (!found.length) notice = 'В проверенных источниках вузы не найдены. Попробуйте другой город или повторите поиск позже.'; }
          catch (e) { notice = researchError(e); }
        }
        const universities = filterUniversities({ ...catalog, universities: allUniversities() }, { city, q, category });
        return json(res, 200, { universities, ai: aiInfo(used), notice });
      }
      if (/^\/api\/universities\/[^/]+$/.test(path) && req.method === 'GET') {
        const id = decodeURIComponent(path.split('/').pop());
        let university = allUniversities().find(u => u.id === id);
        if (!university) throw error('Вуз не найден.', 404);
        let used = false, notice = aiAvailable() ? undefined : unavailableNotice();
        if (aiAvailable() && url.searchParams.get('research') === '1') {
          rateLimit(req);
          try {
            const evidence = provider === 'ollama' ? (await evidenceCollector.collect([university])).documents : undefined;
            if (provider === 'ollama' && !evidence?.length) throw new Error('AI_EVIDENCE');
            const answer = await ai.research('university_details', { university: university.name, website: university.website, ...(evidence ? { evidence } : {}), request: 'Подготовь описание, сильные направления и особенности обучения по официальному сайту. Формат {"description":"кратко","details":"2-3 абзаца","tags":["направление"]}. Не возвращай непроверенные баллы или цены.' });
            if ([...answer.sources].some(s => sameOrganization(s, university.website))) {
              university = { ...university, description: str(answer.result.description, 800) || university.description, details: str(answer.result.details, 3000) || university.details, sources: [...answer.sources].filter(s => sameOrganization(s, university.website)).slice(0, 5), aiGenerated: true };
              used = true;
            } else notice = 'В официальных источниках нет подтверждения для обновления описания. Показана справочная карточка.';
          } catch (e) { notice = researchError(e); }
        }
        return json(res, 200, { university, ai: aiInfo(used), notice });
      }
      if (path === '/api/recommendations' && req.method === 'POST') {
        const localResult = createCatalogRecommendations(await readBody(req), { ...catalog, universities: allUniversities() });
        const { profile } = localResult;
        let candidates = filterUniversities({ ...catalog, universities: allUniversities() }, { city: profile.city });
        let recommendations = localResult.recommendations;
        let used = false, notice = aiAvailable() ? undefined : unavailableNotice();
        if (aiAvailable()) {
          rateLimit(req);
          try {
            if (profile.city && !candidates.length) { await searchCity(profile.city); candidates = allUniversities().filter(u => u.cityId === profile.city); recommendations = localRecommendations(candidates, profile, catalog); }
            // Limit research to a relevant shortlist. Each search covers up to five official domains.
            const shortlist = localRecommendations(candidates, profile, catalog, provider === 'ollama' ? 3 : 5).map(r => r.university);
            const evidence = provider === 'ollama' ? (await evidenceCollector.collect(shortlist)).documents : undefined;
            if (provider === 'ollama' && !evidence?.length) throw new Error('AI_EVIDENCE');
            const answer = await ai.research('admissions_recommendations', {
              profile,
              universities: shortlist.map(u => ({ id: u.id, name: u.name, website: u.website })),
              ...(evidence ? { evidence } : {}),
              request: provider === 'ollama' ? localAdmissionsRequest : admissionsRequest,
            });
            const proposed = answer?.result.recommendations;
            if (Array.isArray(proposed)) {
              const seen = new Set();
              const checked = proposed.slice(0, 12).flatMap(item => {
                if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
                const university = shortlist.find(u => u.id === item.universityId);
                if (!university || seen.has(university.id)) return [];
                seen.add(university.id);
                const admission = validateAdmissionProgram(item.admission, answer.sources, university, profile);
                // Legacy alternative provider data remains source checked; it never becomes a chance.
                const passingScore = provider === 'openai' ? validatePassingScore(item.passingScore, answer.sources, university, profile.exams) : null;
                return [{ university, reason: str(item.reason, 1000) || localReason(university, profile.specialty), admission, passingScore, subjectMatch: admission?.subjectMatch ?? passingScore?.subjectMatch ?? null }];
              }).sort((a, b) => {
                const priority = r => r.admission?.eligible === true ? 2 : r.admission?.eligible === false ? 0 : 1;
                return priority(b) - priority(a);
              });
              if (checked.length) {
                recommendations = checked.filter(r => r.admission?.eligible !== false).slice(0, 3); used = true;
                notice = !recommendations.length
                  ? 'Найденные программы не подходят по минимумам ЕГЭ или не имеют бюджетных мест. Измени условия поиска или проверь другие программы.'
                  : recommendations.some(r => r.admission)
                  ? 'Правила найдены нейросетью по официальным источникам. Баллы рассчитаны по указанной программе; достижения — по анкете, с последующей проверкой документов вузом.'
                  : 'Нейросеть предложила направления, но полные условия конкурса не подтверждены. Это варианты для изучения; оценка поступления пока недоступна.';
              }
              else notice = 'Не удалось подтвердить рекомендации по официальным источникам. Показаны вузы справочного каталога.';
            } else notice = 'Ответ нейросети не содержит проверяемых рекомендаций. Показан справочный каталог.';
          } catch (e) { notice = researchError(e); }
        }
        return json(res, 200, {
          ...localResult, recommendations, ai: aiInfo(used), notice,
        });
      }
      if (path.startsWith('/api/')) throw error('Метод или адрес API не найден.', 404);
      if (!['GET', 'HEAD'].includes(req.method)) throw error('Метод не поддерживается.', 405);
      // Production serving; Vite handles assets and HMR in development.
      const dist = resolve(root, 'dist');
      let target = resolve(dist, `.${decodeURIComponent(path)}`);
      if (!target.startsWith(dist + sep) && target !== dist) throw error('Недопустимый путь.', 400);
      try { if (!(await stat(target)).isFile()) target = resolve(dist, 'index.html'); } catch { target = resolve(dist, 'index.html'); }
      let content;
      try { content = await readFile(target); } catch { throw error('Приложение ещё не собрано. Выполните npm run build или запустите npm run dev.', 503); }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };
      res.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (e) {
      const status = Number.isInteger(e.status) && e.status >= 400 && e.status <= 599 ? e.status : 500;
      json(res, status, { error: status === 500 ? 'Не удалось обработать запрос. Попробуйте ещё раз.' : e.message });
    }
  });
  server.requestTimeout = 240_000;
  return server;
}

export async function startServer(options = {}) {
  const server = await createServer(options);
  const port = options.port ?? Number(process.env.API_PORT || process.env.PORT || 3001);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, host, done); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().then(server => {
    console.log(`VOOOZ API: port ${server.address().port}`);
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => process.exit(0)));
  }).catch(() => { console.error('Не удалось запустить сервер. Проверьте каталог и свободный порт.'); process.exitCode = 1; });
}
