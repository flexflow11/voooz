import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, validateProfile } from '../server/index.mjs';
import { runTelegramBot } from '../server/telegram.mjs';

const catalog = { cities: [], specialties: [], universities: [] };
const baseExams = [{ subject: 'Русский язык', score: 80 }, { subject: 'Математика (профильная)', score: 70 }];

test('every foreign language shown in the profile can be submitted, without double counting foreign-language exams', () => {
  const languages = ['Английский язык', 'Немецкий язык', 'Французский язык', 'Испанский язык', 'Китайский язык'];
  for (const language of languages) {
    const result = validateProfile({ exams: [...baseExams, { subject: language, score: 90 }] }, catalog);
    assert.equal(result.exams[2].subject, 'Иностранный язык');
    assert.equal(result.exams.reduce((sum, exam) => sum + exam.score, 0), 240);
  }
  assert.throws(() => validateProfile({ exams: [...baseExams, { subject: languages[0], score: 90 }, { subject: languages[1], score: 85 }] }, catalog), /не должны повторяться/);
});

test('achievement notes are retained in the submitted profile and bounded', async () => {
  const server = await createServer({ catalog, aiKey: '', cacheDir: false });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/recommendations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exams: baseExams, achievements: { olympiad: 'Призёр' }, notes: '  Призёр олимпиады 2025 года.  ' }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.profile.notes, 'Призёр олимпиады 2025 года.');
    assert.equal(result.achievementPoints, null);
    assert.equal(validateProfile({ exams: baseExams, notes: 'а'.repeat(1200) }, catalog).notes.length, 1000);
    assert.throws(() => validateProfile({ exams: baseExams, notes: { untrusted: true } }, catalog), /Некорректное примечание/);
  } finally {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
});

test('local recommendations remain available after repeated requests from a shared proxy address', async () => {
  const server = await createServer({ catalog, aiKey: '', cacheDir: false });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    for (let index = 0; index < 15; index++) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/recommendations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exams: baseExams }),
      });
      assert.equal(response.status, 200);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
});

test('Telegram retries transient network, 5xx and payload 429 errors with bounded backoff', async () => {
  const controller = new AbortController();
  const waits = [];
  let attempts = 0;
  await runTelegramBot({ token: '123:testtoken', webAppUrl: 'https://example.com', signal: controller.signal,
    waitImpl: async (ms, signal) => { assert.equal(signal, controller.signal); waits.push(ms); },
    fetchImpl: async (url) => {
      const method = url.split('/').at(-1);
      if (method === 'getMe') {
        attempts++;
        if (attempts === 1) throw new Error('sensitive provider request URL');
        if (attempts === 2) return new Response(JSON.stringify({ ok: false }), { status: 503 });
        if (attempts === 3) return new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 99 } }));
      }
      if (method === 'getUpdates') controller.abort();
      return new Response(JSON.stringify({ ok: true, result: method === 'getUpdates' ? [] : {} }));
    },
  });
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [1000, 2000, 30000]);
});

test('Telegram stops immediately on terminal errors, and bounds retries without exposing provider details', async () => {
  for (const status of [401, 409]) {
    let calls = 0;
    await assert.rejects(runTelegramBot({ token: '123:testtoken', webAppUrl: 'https://example.com',
      waitImpl: async () => assert.fail('terminal errors must not be retried'),
      fetchImpl: async () => { calls++; return new Response(JSON.stringify({ ok: false, error_code: status, description: 'private token data' }), { status }); },
    }), error => !error.message.includes('private') && !error.message.includes('testtoken'));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(runTelegramBot({ token: '123:testtoken', webAppUrl: 'https://example.com', maxRetries: 2,
    waitImpl: async () => {}, fetchImpl: async () => { calls++; throw new Error('secret request'); },
  }), error => !error.message.includes('secret'));
  assert.equal(calls, 3);
});

test('Telegram retry backoff can be aborted promptly', { timeout: 500 }, async () => {
  const controller = new AbortController();
  const waiting = runTelegramBot({ token: '123:testtoken', webAppUrl: 'https://example.com', signal: controller.signal,
    fetchImpl: async () => { setTimeout(() => controller.abort(), 10); throw new Error('temporary outage'); },
  });
  await assert.rejects(waiting);
});
