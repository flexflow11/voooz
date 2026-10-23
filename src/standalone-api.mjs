import catalog from '../data/catalog.json';
import { createCatalogRecommendations, filterUniversities } from '../shared/catalog.mjs';

const ai = { configured: false, used: false, provider: 'Qwen · Ollama' };

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function standaloneFetch(input, options = {}) {
  if (options.signal?.aborted) throw new DOMException('Запрос отменён', 'AbortError');
  const url = new URL(String(input), 'https://voooz.local');
  const method = (options.method || 'GET').toUpperCase();
  try {
    if (url.pathname === '/api/catalog' && method === 'GET') return response({ ...catalog, ai });
    if (url.pathname === '/api/health' && method === 'GET') return response({ ok: true, ai, standalone: true, telegram: { configured: false } });
    if (url.pathname === '/api/universities' && method === 'GET') {
      return response({ universities: filterUniversities(catalog, Object.fromEntries(url.searchParams)), ai });
    }
    if (url.pathname.startsWith('/api/universities/') && method === 'GET') {
      const id = decodeURIComponent(url.pathname.slice('/api/universities/'.length));
      const university = catalog.universities.find(u => u.id === id);
      return university ? response({ university, ai }) : response({ error: 'Вуз не найден.' }, 404);
    }
    if (url.pathname === '/api/recommendations' && method === 'POST') {
      let body;
      try { body = JSON.parse(options.body); } catch { return response({ error: 'Некорректный JSON.' }, 400); }
      return response(createCatalogRecommendations(body, catalog));
    }
    return response({ error: 'Адрес не найден.' }, 404);
  } catch (error) {
    return response({ error: error.message || 'Не удалось обработать запрос.' }, error.status || 400);
  }
}
