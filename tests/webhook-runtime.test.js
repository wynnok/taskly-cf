import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let mf, requests, upstreamStatus;
before(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'webhook-runtime',
          modules: [
            {
              type: 'ESModule',
              path: 'tests/webhook-runtime-worker.js',
              contents: `
                import { sendWebhook } from '../src/webhook.js';
                export default {
                  async fetch(request) {
                    try {
                      await sendWebhook(
                        { title: '运行时测试', message: '正文', url: '' },
                        await request.json(),
                        { APP_TIMEZONE: 'Asia/Shanghai', SERVERCHAN_UID: '123', SERVERCHAN_SENDKEY: 'test-key' },
                      );
                      return Response.json({ ok: true });
                    } catch (error) {
                      return Response.json({ error: error.message }, { status: 502 });
                    }
                  },
                };
              `,
            },
            ...['webhook', 'cron'].map((name) => ({
              type: 'ESModule',
              path: `src/${name}.js`,
            })),
          ],
          compatibilityDate: '2026-09-30',
          // Use the runtime's real fetch, but never send a production notification.
          outboundService: async (request) => {
            requests.push({
              url: request.url,
              method: request.method,
              body: await request.text(),
            });
            return new Response(JSON.stringify({ code: 0 }), {
              status: upstreamStatus,
              headers: { Location: 'https://example.com/redirected' },
            });
          },
        },
      ],
    }),
  );
});
after(async () => {
  await mf?.dispose();
});

async function send(target) {
  return mf.dispatchFetch('http://localhost/send', {
    method: 'POST',
    body: JSON.stringify(target),
  });
}

for (const method of ['get', 'post_json', 'post_form']) {
  test(`Workers fetch sends ${method} webhooks without an immediate network error`, async () => {
    requests = [];
    upstreamStatus = 200;
    const response = await send({
      method,
      url: 'https://example.com/hook',
      template: method === 'post_json' ? '{"title":"{{title}}"}' : 'title={{title}}',
    });
    const result = await response.json();
    assert.equal(response.status, 200, result.error);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, method === 'get' ? 'GET' : 'POST');
    const title =
      method === 'get'
        ? new URL(requests[0].url).searchParams.get('title')
        : method === 'post_json'
          ? JSON.parse(requests[0].body).title
          : new URLSearchParams(requests[0].body).get('title');
    assert.equal(title, '运行时测试');
  });
}

test('Workers fetch sends the default Server酱³ channel using secrets', async () => {
  requests = [];
  upstreamStatus = 200;
  const response = await send({
    provider: 'serverchan3',
    method: 'post_json',
    url: '',
    template: '{"title":"{{title}}"}',
  });
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://123.push.ft07.com/send/test-key.send');
});

test('Workers fetch reports redirects as HTTP failures without following them', async () => {
  requests = [];
  upstreamStatus = 302;
  const response = await send({
    method: 'post_json',
    url: 'https://example.com/hook',
    template: '{}',
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'Webhook 返回 HTTP 302' });
  assert.equal(requests.length, 1);
});
