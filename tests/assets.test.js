import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let mf;
before(() => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'main',
          modules: ['index', 'auth', 'cron', 'webhook', 'scheduler'].map((name) => ({
            type: 'ESModule',
            path: `src/${name}.js`,
          })),
          compatibilityDate: '2026-09-30',
          assets: {
            directory: './public',
            binding: 'ASSETS',
            run_worker_first: true,
            routerConfig: { has_user_worker: true },
          },
        },
      ],
    }),
  );
});
after(async () => {
  await mf?.dispose();
});

test('page routes serve real HTML without redirect loops for GET and HEAD', async () => {
  for (const path of [
    '/',
    '/tasks',
    '/calendar',
    '/groups',
    '/settings',
    '/monitoring',
    '/login',
  ]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await mf.dispatchFetch(`http://localhost${path}?view=test`, {
        method,
        redirect: 'manual',
      });
      assert.equal(response.status, 200, `${method} ${path}`);
      assert.equal(response.headers.get('location'), null);
      assert.match(response.headers.get('content-type'), /text\/html/);
      const html = await response.text();
      if (method === 'GET') assert.match(html, /id="login-form"/);
      else assert.equal(html, '');
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
    }
  }
});

test('scripts and styles load while missing assets stay 404', async () => {
  for (const [path, type] of [
    ['/app.js', /javascript/],
    ['/style.css', /text\/css/],
  ]) {
    const response = await mf.dispatchFetch(`http://localhost${path}`, { redirect: 'manual' });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), type);
    assert.ok((await response.text()).length > 0);
  }
  assert.equal((await mf.dispatchFetch('http://localhost/missing.js')).status, 404);
});
