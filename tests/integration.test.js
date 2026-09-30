import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { executeTask, runScheduled } from '../src/scheduler.js';

let mf, db, csrf, cookie;
const base = 'http://localhost';
const env = () => ({ DB: db, APP_TIMEZONE: 'Asia/Shanghai' });
async function req(path, method = 'GET', body, custom = {}) {
  const headers = {
    Cookie: cookie || '',
    Origin: base,
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrf || '',
    ...custom,
  };
  return mf.dispatchFetch(base + path, {
    method,
    headers,
    ...(method !== 'GET' ? { body: JSON.stringify(body || {}) } : {}),
  });
}
async function data(path, method = 'GET', body) {
  const response = await req(path, method, body);
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
}
before(async () => {
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
          d1Databases: { DB: 'test-db' },
          bindings: {
            APP_TIMEZONE: 'Asia/Shanghai',
            INITIAL_ADMIN_USERNAME: 'test-admin',
            INITIAL_ADMIN_PASSWORD: 'correct-test-password-123',
          },
          serviceBindings: { ASSETS: async () => new Response('asset') },
        },
      ],
    }),
  );
  db = await mf.getD1Database('DB');
  const schema = await readFile('migrations/0001_initial.sql', 'utf8');
  await db.batch(
    schema
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => db.prepare(s)),
  );
});
after(async () => {
  await mf?.dispose();
});

test('login, cookie, session, CSRF and unauthorized export', async () => {
  assert.equal((await req('/api/tasks/export')).status, 401);
  assert.equal(
    (await req('/api/login', 'POST', { username: 'test-admin', password: 'wrong' })).status,
    401,
  );
  const response = await req('/api/login', 'POST', {
    username: 'test-admin',
    password: 'correct-test-password-123',
  });
  assert.equal(response.status, 200);
  const login = await response.json();
  csrf = login.csrf;
  cookie = response.headers.get('set-cookie').split(';')[0];
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await req('/api/tasks', 'POST', {}, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal(
    (await req('/api/tasks', 'POST', {}, { Origin: 'https://evil.example' })).status,
    403,
  );
  assert.equal((await data('/api/session')).username, 'test-admin');
  assert.ok(!(await data('/api/settings')).auth.password);
});
let taskId;
test('CRUD, filtering, atomic import, batches, referential integrity and default target', async () => {
  const task = {
    title: '生产样式任务',
    message: '本月第 {{var_monthly_count}} 次',
    cron_expression: '0 10,21 28 * *',
    enabled: true,
    tags: ['finance'],
  };
  taskId = (await data('/api/tasks', 'POST', task)).id;
  let list = await data('/api/tasks?q=生产&tag=finance');
  assert.equal(list.total, 1);
  assert.equal(list.tasks[0].webhook_name, 'Server酱³');
  await data('/api/tasks/' + taskId, 'PUT', { ...task, title: '更新任务' });
  assert.equal((await data('/api/tasks/' + taskId)).title, '更新任务');
  assert.equal((await req('/api/tasks', 'POST', { ...task, channel: 'email' })).status, 400);
  assert.equal(
    (await req('/api/tasks/import', 'POST', [task, { ...task, cron_expression: 'bad' }])).status,
    400,
  );
  assert.equal((await data('/api/tasks')).total, 1);
  await data('/api/tasks/import', 'POST', [
    { ...task, channel: 'email', group_id: 999, webhook_id: 999 },
  ]);
  assert.equal((await data('/api/tasks')).total, 2);
  await data('/api/tasks/batch', 'POST', { ids: [taskId], action: 'disable' });
  assert.equal((await data('/api/tasks?enabled=0')).total, 1);
  await data('/api/tasks/' + taskId + '/toggle', 'POST');
  assert.ok((await data('/api/tasks/' + taskId)).enabled);
  await data('/api/groups', 'POST', { name: '测试分组', icon: '📘', sort_order: 1 });
  const group = (await data('/api/groups')).find((g) => g.name === '测试分组');
  await data('/api/tasks/' + taskId, 'PUT', { ...task, group_id: group.id });
  assert.equal((await req('/api/groups/' + group.id, 'DELETE')).status, 409);
  assert.equal((await req('/api/webhooks/1', 'DELETE')).status, 400);
  const saved = await db.prepare('SELECT * FROM webhook_targets WHERE id=1').first();
  await data('/api/webhooks/1', 'PUT', {
    ...saved,
    url: 'https://123.push.ft07.com/send/key.send',
  });
  await data('/api/webhooks', 'POST', {
    name: '测试通道',
    method: 'post_form',
    url: 'https://example.com',
    template: 'title={{title}}',
  });
  const target = (await data('/api/settings')).targets.find((t) => t.name === '测试通道');
  await data('/api/webhooks/' + target.id, 'PUT', { ...target, note: 'saved note' });
  assert.equal(
    (await data('/api/settings')).targets.find((t) => t.id === target.id).note,
    'saved note',
  );
});
test('simultaneous scheduled events claim one delivery and record one outcome', async () => {
  const task = await db.prepare('SELECT * FROM tasks WHERE id=?').bind(taskId).first();
  let sends = 0;
  const fetcher = async (_, options) => {
    sends++;
    assert.match(JSON.parse(options.body).desp, /本月第 1 次/);
    return Response.json({ code: 0 });
  };
  const scheduled = '2026-09-28T02:00:00.000Z';
  const outcomes = await Promise.all(
    Array.from({ length: 3 }, () =>
      executeTask(task, env(), 'scheduled', scheduled, Date.parse(scheduled), fetcher),
    ),
  );
  assert.equal(sends, 1);
  assert.equal(outcomes.filter((x) => x.skipped).length, 2);
  const history = await data('/api/tasks/' + taskId + '/history');
  assert.equal(history.history.length, 1);
  assert.equal(history.history[0].status, 'success');
  const failed = await executeTask(
    task,
    env(),
    'manual',
    null,
    Date.parse('2026-09-28T02:01:00Z'),
    async () => new Response('', { status: 500 }),
  );
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /HTTP 500/);
  let message;
  await executeTask(
    task,
    env(),
    'manual',
    null,
    Date.parse('2026-09-28T02:02:00Z'),
    async (_, options) => {
      message = JSON.parse(options.body).desp;
      return Response.json({ code: 0 });
    },
  );
  assert.match(message, /本月第 3 次/);
});
test('Cron event catches delayed minutes and does not replay after completion', async () => {
  await db.prepare('UPDATE tasks SET enabled=0').run();
  const created = await data('/api/tasks', 'POST', {
    title: '每分钟任务',
    message: 'test',
    cron_expression: '* * * * *',
  });
  await db
    .prepare("INSERT OR REPLACE INTO scheduler_state(key,value) VALUES('last_scan',?)")
    .bind(String(Date.parse('2026-10-01T02:00:00Z')))
    .run();
  let sends = 0;
  const fetcher = async () => {
    sends++;
    return Response.json({ code: 0 });
  };
  await runScheduled(env(), Date.parse('2026-10-01T02:03:00Z'), fetcher);
  assert.equal(sends, 3);
  await runScheduled(env(), Date.parse('2026-10-01T02:03:00Z'), fetcher);
  assert.equal(sends, 3);
  await db.prepare('UPDATE tasks SET enabled=0 WHERE id=?').bind(created.id).run();
  await runScheduled(env(), Date.parse('2026-10-01T02:04:00Z'), fetcher);
  assert.equal(sends, 3);
});
test('ambiguous interrupted execution is retained as failure and never resent', async () => {
  await db
    .prepare('INSERT INTO execution_claims(task_id,scheduled_for,claimed_at) VALUES(?,?,?)')
    .bind(taskId, '2026-01-01T00:00:00Z', Date.now() - 1300000)
    .run();
  await runScheduled(env(), Date.parse('2026-10-01T02:05:00Z'), async () => {
    throw new Error('must not send');
  });
  const record = await db
    .prepare("SELECT * FROM execution_history WHERE scheduled_for='2026-01-01T00:00:00Z'")
    .first();
  assert.equal(record.status, 'failed');
  assert.match(record.error, /结果未知/);
});
test('calendar, cron previews, statistics and deletion retain historical rows', async () => {
  assert.ok(Array.isArray((await data('/api/calendar?month=2026-10')).entries));
  assert.equal((await req('/api/calendar?month=invalid')).status, 400);
  assert.ok(
    (await data('/api/cron/preview', 'POST', { expression: '0 9 * * mon-fri' })).next.length,
  );
  const statistics = await data('/api/statistics');
  assert.ok(statistics.executions.total >= 6);
  await data('/api/tasks/' + taskId, 'DELETE');
  assert.equal((await req('/api/tasks/' + taskId)).status, 404);
  assert.ok((await data('/api/statistics')).recent.some((h) => h.title.startsWith('已删除任务')));
});
test('account changes require current password and revoke every existing session', async () => {
  assert.equal(
    (await req('/api/settings/auth', 'PUT', { username: 'new-admin', current_password: 'wrong' }))
      .status,
    403,
  );
  await data('/api/settings/auth', 'PUT', {
    username: 'new-admin',
    current_password: 'correct-test-password-123',
    password: 'new-test-password-123',
  });
  assert.equal((await req('/api/session')).status, 401);
});
