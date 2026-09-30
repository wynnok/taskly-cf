import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendWebhook, validateTarget } from '../src/webhook.js';
const task = {
  title: '报价 "你好" & +',
  message: '本月第 {{var_monthly_count}} 次\n\\line',
  url: 'https://example.com/?a=1&b=2',
};
const env = { APP_TIMEZONE: 'Asia/Shanghai' };
test('JSON rendering safely escapes user content and includes monthly execution count', async () => {
  let received;
  await sendWebhook(
    task,
    {
      method: 'post_json',
      url: 'https://example.com/hook',
      template: '{"title":"{{title}}","text":"{{content}}","link":"{{url}}"}',
    },
    env,
    7,
    Date.now(),
    async (url, options) => {
      received = JSON.parse(options.body);
      return new Response('{}');
    },
  );
  assert.equal(received.title, task.title);
  assert.equal(received.text, task.message.replace('{{var_monthly_count}}', '7'));
  assert.equal(received.link, task.url);
});
test('GET and form placeholders encode unicode and reserved characters', async () => {
  let received;
  await sendWebhook(
    task,
    {
      method: 'get',
      url: 'https://example.com/{{title}}',
      template: 'text={{content}}&url={{url}}',
    },
    env,
    2,
    Date.now(),
    async (url) => {
      received = new URL(url);
      return new Response();
    },
  );
  assert.equal(decodeURIComponent(received.pathname.slice(1)), task.title);
  assert.equal(received.searchParams.get('url'), task.url);
  await sendWebhook(
    task,
    {
      method: 'post_form',
      url: 'https://example.com',
      template: 'title={{title}}&text={{content}}',
    },
    env,
    3,
    Date.now(),
    async (_, options) => {
      assert.equal(new URLSearchParams(options.body).get('title'), task.title);
      return new Response();
    },
  );
});
test('Server酱³ business errors fail even on HTTP 200; secrets supply the endpoint', async () => {
  const target = {
      provider: 'serverchan3',
      url: '',
      method: 'post_json',
      template: '{"title":"{{title}}"}',
    },
    secrets = { ...env, SERVERCHAN_UID: '123', SERVERCHAN_SENDKEY: 'key' };
  await assert.rejects(
    sendWebhook(task, target, secrets, 1, Date.now(), async () => Response.json({ code: 400 })),
    /拒绝/,
  );
  await sendWebhook(task, target, secrets, 1, Date.now(), async (url) => {
    assert.equal(url, 'https://123.push.ft07.com/send/key.send');
    return Response.json({ code: 0 });
  });
  await assert.rejects(
    sendWebhook(
      task,
      { ...target, url: 'https://example.com' },
      env,
      1,
      Date.now(),
      async () => new Response('bad'),
    ),
    /无效 JSON/,
  );
  await assert.rejects(
    sendWebhook(task, { ...target, url: 'https://example.com' }, env, 1, Date.now(), async () => {
      throw new Error('secret-url');
    }),
    /网络请求/,
  );
});
test('target validation rejects malformed bodies and unsupported methods', () => {
  assert.throws(
    () =>
      validateTarget({
        name: 'x',
        method: 'post_json',
        url: 'https://example.com',
        template: '{"x":{{title}}}',
      }),
    /JSON/,
  );
  assert.throws(() => validateTarget({ name: 'x', method: 'bad' }), /请求方式/);
});
