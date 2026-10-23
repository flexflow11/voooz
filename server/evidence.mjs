/** Bounded retrieval from catalogued official websites; this is not a web-search service. */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

const MAX_BODY = 1024 * 1024;
const TTL = 24 * 60 * 60 * 1000;
const RELEVANT = /при[её]м|поступ|абитури|бакалав|специалитет|индивидуаль|достижен|бюджет|балл|конкурс|abitur|admiss|priem|postup|enroll|apply/i;
const fail = code => Object.assign(new Error(code), { code });
const FAILURE_CODES = new Set(['UNSAFE_URL', 'UNSAFE_DNS', 'UNSAFE_REDIRECT', 'TOO_MANY_REDIRECTS', 'HTTP_UNAVAILABLE', 'NOT_HTML', 'NO_READABLE_TEXT', 'BODY_TOO_LARGE', 'UNSUPPORTED_ENCODING', 'PROXY_UNSUPPORTED', 'TIMEOUT', 'NETWORK_UNAVAILABLE']);

function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 88 && c === 99) || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) !== 6) return false;
  const [firstText, secondText = '0'] = address.toLowerCase().split(':');
  const first = parseInt(firstText, 16), second = parseInt(secondText || '0', 16);
  // Accept global-unicast IPv6 only, excluding documentation, tunnels and ORCHID.
  return first >= 0x2000 && first < 0x4000 && first !== 0x2002 && first !== 0x3fff
    && !(first === 0x2001 && (second === 0 || second === 2 || second === 0xdb8 || second >= 0x10 && second <= 0x2f));
}

function safeOfficialUrl(value, website) {
  try {
    const url = new URL(value), base = new URL(website);
    const host = url.hostname.toLowerCase(), organization = base.hostname.toLowerCase().replace(/^www\./, '');
    if (url.href.length > 4096 || url.protocol !== 'https:' || url.port || url.username || url.password || !host.includes('.') || isIP(host) || host.includes(':') || /\.(?:local|internal|localhost|invalid|test)$/.test(host)) return null;
    const normalized = host.replace(/^www\./, '');
    if (normalized !== organization && !normalized.endsWith(`.${organization}`)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', laquo: '«', raquo: '»' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|ndash|mdash|laquo|raquo);/gi, (whole, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] || whole;
    const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : ' ';
  });
}

function plainText(html) {
  return decodeEntities(html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|template|iframe|noscript|svg|nav|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<\/(?:p|div|section|article|tr|li|h[1-6])\s*>|<br\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, ' ')).replace(/[\t\r ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function relevantText(text, limit) {
  if (text.length <= limit) return text;
  const chunks = [text.slice(0, Math.min(350, limit))];
  const matcher = new RegExp(RELEVANT.source, 'gi');
  let match, previousEnd = chunks[0].length;
  while ((match = matcher.exec(text)) && chunks.join('\n').length < limit) {
    const start = Math.max(previousEnd, match.index - 160), end = Math.min(text.length, match.index + 450);
    if (end <= previousEnd) continue;
    chunks.push(text.slice(start, end)); previousEnd = end;
  }
  return chunks.join('\n[…]\n').slice(0, limit);
}

function linksFrom(html, url, website) {
  const found = new Map();
  const pattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
  let match;
  while ((match = pattern.exec(html)) && found.size < 80) {
    const href = decodeEntities(match[1] ?? match[2] ?? match[3] ?? '');
    let target;
    try { target = safeOfficialUrl(new URL(href, url).href, website); } catch { continue; }
    if (!target || /\.(?:png|jpe?g|gif|webp|svg|zip|docx?|xlsx?|pdf)(?:[?#]|$)/i.test(target)) continue;
    const label = plainText(match[4]).slice(0, 240);
    if (!RELEVANT.test(`${target} ${label}`)) continue;
    const priority = /балл|результ|мест|достижен|правил|конкурс|result|rule|seat/i.test(`${target} ${label}`) ? 2 : 1;
    found.set(target, { url: target, priority });
  }
  return [...found.values()].sort((a, b) => b.priority - a.priority);
}

function proxyFor(hostname) {
  const exceptions = process.env.NO_PROXY ?? process.env.no_proxy ?? '';
  if (exceptions.split(',').some(raw => {
    const token = raw.trim().toLowerCase().replace(/:443$/, '').replace(/^\./, '');
    return token === '*' || token && (hostname === token || hostname.endsWith(`.${token}`));
  })) return undefined;
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
}

async function proxySocket(proxyValue, target, signal) {
  const proxy = new URL(proxyValue);
  if (!['http:', 'https:'].includes(proxy.protocol)) throw fail('PROXY_UNSUPPORTED');
  const headers = { Host: `${target.hostname}:443` };
  if (proxy.username || proxy.password) headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
  const socket = await new Promise((done, reject) => {
    const request = (proxy.protocol === 'https:' ? https : http).request({ protocol: proxy.protocol, hostname: proxy.hostname, port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80), method: 'CONNECT', path: `${target.hostname}:443`, headers, signal });
    request.once('error', () => reject(fail('NETWORK_UNAVAILABLE')));
    request.once('connect', (response, connection, head) => {
      if (response.statusCode !== 200 || head.length) { connection.destroy(); reject(fail('NETWORK_UNAVAILABLE')); return; }
      done(connection);
    });
    request.end();
  });
  return new Promise((done, reject) => {
    const secure = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: true, signal });
    secure.once('secureConnect', () => done(secure));
    secure.once('error', () => { socket.destroy(); reject(fail('NETWORK_UNAVAILABLE')); });
  });
}

/** Direct connections pin checked DNS; an explicitly configured proxy remains in the route. */
async function requestHtml(url, { signal, address }) {
  const target = new URL(url), proxy = proxyFor(target.hostname);
  let agent;
  if (proxy) {
    const socket = await proxySocket(proxy, target, signal);
    agent = new https.Agent({ keepAlive: false });
    agent.createConnection = () => socket;
  }
  return new Promise((done, reject) => {
    const request = https.request(target, {
      method: 'GET', signal, agent: agent || false, servername: target.hostname,
      ...(proxy ? {} : { family: address.family, autoSelectFamily: false, lookup: (_host, options, callback) => options?.all ? callback(null, [address]) : callback(null, address.address, address.family) }),
      headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Encoding': 'identity', 'User-Agent': 'VOOOZ-admissions-research/1.0' },
    }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_BODY) { response.destroy(fail('BODY_TOO_LARGE')); return; }
        chunks.push(chunk);
      });
      response.once('error', () => { agent?.destroy(); reject(fail('NETWORK_UNAVAILABLE')); });
      response.once('end', () => {
        const status = response.statusCode || 500;
        const headers = Object.fromEntries(Object.entries(response.headers).filter(([, value]) => value !== undefined).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value]));
        agent?.destroy();
        done(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
      });
    });
    request.once('error', () => { agent?.destroy(); reject(fail('NETWORK_UNAVAILABLE')); });
    request.end();
  });
}

async function limitedText(response) {
  if (Number(response.headers.get('content-length')) > MAX_BODY) throw fail('BODY_TOO_LARGE');
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw fail('BODY_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
    const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(response.headers.get('content-type') || '')?.[1] || 'utf-8';
    try { return new TextDecoder(charset).decode(Buffer.concat(chunks)); } catch { throw fail('UNSUPPORTED_ENCODING'); }
  } finally { reader.releaseLock(); }
}

async function withinSignal(operation, signal) {
  if (signal.aborted) throw fail('TIMEOUT');
  let abort;
  try {
    return await Promise.race([operation, new Promise((_, reject) => { abort = () => reject(fail('TIMEOUT')); signal.addEventListener('abort', abort, { once: true }); })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

export function createEvidenceCollector({ fetchImpl = requestHtml, lookupImpl = lookup, timeoutMs = 7000, totalTimeoutMs = 20000, maxUniversities = 3, maxPagesPerUniversity = 4, maxDocuments = 9, maxTextChars = 12000, now = Date.now } = {}) {
  const cache = new Map(), pending = new Map();
  async function page(url, website, totalSignal) {
    const signal = AbortSignal.any([totalSignal, AbortSignal.timeout(timeoutMs)]);
    let current = url;
    for (let count = 0; count < 4; count++) {
      const safe = safeOfficialUrl(current, website);
      if (!safe) throw fail('UNSAFE_URL');
      const records = await withinSignal(Promise.resolve(lookupImpl(new URL(safe).hostname, { all: true, verbatim: true })), signal);
      if (!Array.isArray(records) || !records.length || records.some(record => !publicAddress(record.address))) throw fail('UNSAFE_DNS');
      const address = records.find(record => record.family === 4) || records[0];
      const response = await withinSignal(Promise.resolve(fetchImpl(safe, { signal, redirect: 'manual', address })), signal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        try { current = new URL(location, safe).href; } catch { throw fail('UNSAFE_REDIRECT'); }
        if (!location || !safeOfficialUrl(current, website)) throw fail('UNSAFE_REDIRECT');
        try { await response.body?.cancel(); } catch { /* no response content is trusted */ }
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw fail('HTTP_UNAVAILABLE');
      if (!/^(?:text\/html|application\/xhtml\+xml)\b/i.test(response.headers.get('content-type') || '')) throw fail('NOT_HTML');
      if (!['', 'identity'].includes(response.headers.get('content-encoding') || '')) throw fail('UNSUPPORTED_ENCODING');
      const html = await withinSignal(limitedText(response), signal), text = plainText(html);
      if (text.length < 60) throw fail('NO_READABLE_TEXT');
      return { url: safe, title: plainText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').slice(0, 240), text, links: linksFrom(html, safe, website) };
    }
    throw fail('TOO_MANY_REDIRECTS');
  }

  async function collectUniversity(university, signal) {
    // Legacy catalog snapshots often contain HTTP homepages. Try their HTTPS
    // equivalent; evidence is granted only after a real successful HTTPS fetch.
    let startUrl = university?.website;
    try { const candidate = new URL(startUrl); if (candidate.protocol === 'http:' && !candidate.port) { candidate.protocol = 'https:'; startUrl = candidate.href; } } catch { /* rejected below */ }
    const website = safeOfficialUrl(startUrl, university?.website);
    if (!website || typeof university?.id !== 'string') return { documents: [], failures: [{ universityId: university?.id || '', code: 'UNSAFE_URL' }] };
    const cacheKey = `${university.id}\0${website}`;
    const cached = cache.get(cacheKey);
    if (cached && now() - cached.time < TTL) return structuredClone(cached.value);
    if (pending.has(cacheKey)) return structuredClone(await pending.get(cacheKey));
    const operation = (async () => {
      const queue = [{ url: website, priority: 0, depth: 0 }], seen = new Set(), documents = [], failures = [];
      while (queue.length && seen.size < maxPagesPerUniversity && !signal.aborted) {
        queue.sort((a, b) => b.priority - a.priority);
        const next = queue.shift();
        if (seen.has(next.url)) continue;
        seen.add(next.url);
        try {
          const result = await page(next.url, website, signal);
          documents.push({ url: result.url, title: result.title, text: result.text.slice(0, 16000), universityId: university.id, retrievedAt: new Date(now()).toISOString(), priority: next.priority });
          if (next.depth < 2) for (const link of result.links) if (!seen.has(link.url) && !queue.some(item => item.url === link.url)) queue.push({ ...link, depth: next.depth + 1 });
        } catch (error) { failures.push({ universityId: university.id, code: FAILURE_CODES.has(error?.code) ? error.code : 'NETWORK_UNAVAILABLE' }); }
      }
      const value = { documents: documents.sort((a, b) => b.priority - a.priority).slice(0, 3), failures };
      // A network failure is retried on the next request; successful pages may be cached.
      if (documents.length) { cache.set(cacheKey, { time: now(), value }); while (cache.size > 128) cache.delete(cache.keys().next().value); }
      return value;
    })();
    pending.set(cacheKey, operation);
    try { return structuredClone(await operation); } finally { pending.delete(cacheKey); }
  }

  async function collect(universities) {
    const signal = AbortSignal.timeout(totalTimeoutMs);
    const input = Array.isArray(universities) ? universities.slice(0, Math.min(5, maxUniversities)) : [];
    const results = await Promise.all(input.map(university => collectUniversity(university, signal)));
    const documents = [];
    // Round-robin selection gives each university a share of the small local-model context.
    for (let round = 0; round < 3 && documents.length < maxDocuments; round++) for (const result of results) if (result.documents[round] && documents.length < maxDocuments) documents.push(result.documents[round]);
    const perDocument = documents.length ? Math.min(2200, Math.floor(maxTextChars / documents.length)) : 0;
    const selected = documents.map(({ priority, ...document }) => ({ ...document, text: relevantText(document.text, perDocument) }));
    return {
      documents: selected, sources: new Set(selected.map(document => document.url)), failures: results.flatMap(result => result.failures),
      notice: selected.length ? 'Получены фрагменты официальных HTML-страниц вузов. Это ограниченный обход связанных страниц, не полный поиск по сайтам и PDF.' : 'Официальные страницы не удалось прочитать. Проходные баллы, места и вероятность не подтверждены.',
    };
  }
  return { collect };
}
