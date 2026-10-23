import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceCollector } from '../server/evidence.mjs';

const university = { id: 'technical', name: 'Технический университет', website: 'https://technical.example.ru/' };
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const html = (text, headers = {}, status = 200) => new Response(text, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
const paragraph = '<p>Приёмная комиссия университета публикует правила приёма, перечень ЕГЭ и бюджетные места для поступающих.</p>';

function collector(fetchImpl, options = {}) { return createEvidenceCollector({ fetchImpl, lookupImpl: publicDns, ...options }); }

test('legacy HTTP catalog entries are attempted over HTTPS and only the actual HTTPS document becomes evidence', async () => {
  const calls = [];
  const research = collector(async url => { calls.push(url); return html(paragraph); });
  const result = await research.collect([{ ...university, website: 'http://technical.example.ru/' }]);
  assert.deepEqual(calls, ['https://technical.example.ru/']);
  assert.deepEqual([...result.sources], ['https://technical.example.ru/']);
  assert.equal(result.documents[0].universityId, university.id);
});

test('retrieves actual linked official admissions pages, strips executable content and gives only fetched URLs as sources', async () => {
  const calls = [];
  const research = collector(async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.address.address, '93.184.216.34');
    if (url.endsWith('/')) return html(`<title>Университет &amp; образование</title>${paragraph}<a href="/admission">Абитуриентам</a><a href="https://foreign.example.ru/admission">Правила</a><a href="/calendar.pdf">Правила PDF</a><script>SECRET_SCRIPT_CONTENT</script>`);
    if (url.endsWith('/admission')) return html(`<title>Правила приёма</title>${paragraph}<p>Бюджетных мест: 40. &#1045;&#1043;&#1069;: русский язык, математика, информатика.</p><a href="/admission/rules">Индивидуальные достижения</a>`);
    return html(`<h1>Индивидуальные достижения</h1>${paragraph}<p>Золотая медаль: 5 баллов. Не более десяти баллов за все достижения.</p>`);
  });
  const result = await research.collect([university]);
  assert.deepEqual(calls, [university.website, university.website + 'admission', university.website + 'admission/rules']);
  assert.equal(result.documents[0].url, university.website + 'admission/rules', 'admissions documents take priority over the home page');
  assert(result.documents.every(doc => doc.universityId === university.id && doc.retrievedAt && doc.text.length > 60));
  assert(result.documents.some(doc => doc.text.includes('ЕГЭ')));
  assert(result.documents.every(doc => !doc.text.includes('SECRET_SCRIPT_CONTENT')));
  assert.deepEqual(new Set(result.documents.map(doc => doc.url)), result.sources);
  assert(![...result.sources].some(url => url.includes('foreign') || url.endsWith('.pdf')));
});

test('rejects private/reserved DNS addresses and mixed public/private results before sending any request', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.1.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '2001:db8::1', '2001:0db8::1', '2001::1', '2002:ac10:0001::1', '3fff::1']) {
    let called = false;
    const research = collector(async () => { called = true; return html(paragraph); }, { lookupImpl: async () => [{ address, family: address.includes(':') ? 6 : 4 }] });
    const result = await research.collect([university]);
    assert.equal(called, false, address);
    assert.equal(result.sources.size, 0);
    assert.equal(result.failures[0].code, 'UNSAFE_DNS');
  }
  const result = await collector(async () => { throw new Error('must not fetch mixed DNS'); }, { lookupImpl: async () => [...await publicDns(), { address: '10.0.0.1', family: 4 }] }).collect([university]);
  assert.equal(result.failures[0].code, 'UNSAFE_DNS');
});

test('rejects external, local and downgraded redirects; same-organization redirects get fresh DNS validation', async () => {
  for (const location of ['https://evil.example.ru/admissions', 'http://technical.example.ru/admissions', 'https://127.0.0.1/', 'https://user:password@technical.example.ru/admissions']) {
    let requests = 0;
    const result = await collector(async () => { requests++; return html('', { location }, 302); }).collect([university]);
    assert.equal(requests, 1);
    assert.equal(result.sources.size, 0);
    assert.equal(result.failures[0].code, 'UNSAFE_REDIRECT');
  }
  const lookedUp = [], requests = [];
  const result = await collector(async url => {
    requests.push(url);
    return requests.length === 1 ? html('', { location: 'https://admission.technical.example.ru/rules' }, 302) : html(paragraph);
  }, { lookupImpl: async host => { lookedUp.push(host); return publicDns(); } }).collect([university]);
  assert.deepEqual(lookedUp, ['technical.example.ru', 'admission.technical.example.ru']);
  assert.deepEqual([...result.sources], ['https://admission.technical.example.ru/rules']);
  const rebound = await collector(async () => html('', { location: 'https://admission.technical.example.ru/rules' }, 302), { lookupImpl: async host => host.startsWith('admission.') ? [{ address: '10.0.0.1', family: 4 }] : publicDns() }).collect([university]);
  assert.equal(rebound.failures[0].code, 'UNSAFE_DNS');
});

test('bounds page count, body size and total text while spreading context fairly across universities', async () => {
  const universities = ['alpha', 'beta', 'gamma'].map(id => ({ id, website: `https://${id}.example.ru/` }));
  let requests = 0;
  const research = collector(async url => {
    requests++;
    const host = new URL(url).hostname;
    return html(`<title>${host} Приём</title>${paragraph.repeat(30)}${Array.from({ length: 30 }, (_, i) => `<a href="/admissions/${i}">Правила и бюджетные места ${i}</a>`).join('')}`);
  });
  const result = await research.collect(universities);
  assert.equal(requests, 12);
  assert.equal(result.documents.length, 9);
  assert.equal(result.documents.reduce((sum, doc) => sum + doc.text.length, 0) <= 12000, true);
  assert.deepEqual(result.documents.slice(0, 3).map(doc => doc.universityId), ['alpha', 'beta', 'gamma']);
  const oversized = await collector(async () => html('x'.repeat(1024 * 1024 + 1))).collect([university]);
  assert.equal(oversized.sources.size, 0);
  assert.equal(oversized.failures[0].code, 'BODY_TOO_LARGE');
});

test('failed fetches and non-HTML documents do not become evidence or leak error details', async () => {
  for (const fetcher of [async () => { throw new Error('private proxy token and provider credentials'); }, async () => html('not authorized', {}, 403), async () => new Response('document PDF', { headers: { 'Content-Type': 'application/pdf' } }), async () => html('<script>all content is JavaScript</script>')]) {
    const result = await collector(fetcher).collect([university]);
    assert.equal(result.documents.length, 0);
    assert.equal(result.sources.size, 0);
    assert(result.failures.length);
    assert(!JSON.stringify(result).includes('private proxy token'));
  }
});

test('successful pages cache and deduplicate without cross-attributing branches or exposing mutable cached state', async () => {
  let calls = 0;
  const research = collector(async () => { calls++; await new Promise(done => setTimeout(done, 5)); return html(paragraph); });
  const [first, second] = await Promise.all([research.collect([university]), research.collect([university])]);
  assert.equal(calls, 1);
  first.documents[0].text = 'modified by caller';
  first.sources.clear();
  const cached = await research.collect([university]);
  assert.equal(calls, 1);
  assert.notEqual(second.documents[0].text, first.documents[0].text);
  assert.equal(cached.sources.size, 1);
  const branch = await research.collect([{ ...university, id: 'technical-other-campus' }]);
  assert.equal(calls, 2);
  assert.equal(branch.documents[0].universityId, 'technical-other-campus');
});

test('DNS and network timeouts finish promptly without invented sources', async () => {
  const start = Date.now();
  const result = await collector(async () => html(paragraph), { lookupImpl: async () => new Promise(() => {}), timeoutMs: 10, totalTimeoutMs: 30 }).collect([university]);
  assert.equal(result.sources.size, 0);
  assert.equal(result.failures[0].code, 'TIMEOUT');
  assert(Date.now() - start < 1000);
});

test('native transport honors configured HTTPS proxy and keeps proxy credentials out of failures', async () => {
  const { createServer } = await import('node:http');
  const connections = [];
  const proxy = createServer();
  proxy.on('connect', (request, socket) => {
    connections.push({ url: request.url, host: request.headers.host, authenticated: Boolean(request.headers['proxy-authorization']) });
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise(done => proxy.listen(0, '127.0.0.1', done));
  const original = { HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY };
  try {
    process.env.HTTPS_PROXY = `http://user:private-proxy-token@127.0.0.1:${proxy.address().port}`;
    process.env.NO_PROXY = '';
    const result = await createEvidenceCollector({ lookupImpl: publicDns, timeoutMs: 500, totalTimeoutMs: 1000 }).collect([university]);
    assert.deepEqual(connections, [{ url: 'technical.example.ru:443', host: 'technical.example.ru:443', authenticated: true }]);
    assert.equal(result.documents.length, 0);
    assert.equal(result.failures[0].code, 'NETWORK_UNAVAILABLE');
    assert(!JSON.stringify(result).includes('private-proxy-token'));
  } finally {
    for (const [name, value] of Object.entries(original)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    proxy.closeAllConnections();
    await new Promise(done => proxy.close(done));
  }
});
