import { parseCron, nextRun, occurrences, localText } from './cron.js';
import {
  randomToken,
  digest,
  equal,
  hashPassword,
  verifyPassword,
  session,
  cookie,
} from './auth.js';
import { validateTarget, sendWebhook } from './webhook.js';
import { runScheduled, executeTask } from './scheduler.js';

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
};
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });
const fail = (message, status = 400) => {
  const e = new Error(message);
  e.status = status;
  throw e;
};
const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);
const rows = async (db, sql, ...args) => (await stmt(db, sql, ...args).all()).results;
const id = (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) fail('ID 无效');
  return n;
};
const TASK_FIELDS =
  'title,message,url,cron_expression,channel,enabled,tags,group_id,webhook_id,created_at,updated_at';
function taskValues(t, time) {
  return [
    t.title,
    t.message,
    t.url,
    t.cron_expression,
    'webhook',
    t.enabled,
    JSON.stringify(t.tags),
    t.group_id,
    t.webhook_id,
    time,
    time,
  ];
}
const decodeTask = (t) => ({ ...t, tags: JSON.parse(t.tags || '[]'), enabled: Boolean(t.enabled) });

async function body(request) {
  if (Number(request.headers.get('Content-Length') || 0) > 2000000) fail('请求内容超过 2 MB', 413);
  const reader = request.body?.getReader();
  if (!reader) fail('请求内容不能为空');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 2000000) {
      await reader.cancel();
      fail('请求内容超过 2 MB', 413);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(merged));
  } catch {
    fail('请求必须是合法 JSON');
  }
}
async function setting(db, key) {
  const r = await stmt(db, 'SELECT value FROM settings WHERE key=?', key).first();
  if (!r) return null;
  try {
    return JSON.parse(r.value);
  } catch {
    return r.value;
  }
}
function setSetting(db, key, value, time) {
  return stmt(
    db,
    'INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
    key,
    JSON.stringify(value),
    time,
  );
}
async function bootstrap(env) {
  if (await setting(env.DB, 'auth.password')) return;
  if (!env.INITIAL_ADMIN_PASSWORD || env.INITIAL_ADMIN_PASSWORD.length < 12)
    fail('请先配置至少 12 位 INITIAL_ADMIN_PASSWORD，或导入生产 SQL', 503);
  const time = localText(Date.now(), env.APP_TIMEZONE),
    password = await hashPassword(env.INITIAL_ADMIN_PASSWORD);
  await env.DB.batch([
    stmt(
      env.DB,
      'INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES(?,?,?)',
      'auth.username',
      JSON.stringify(env.INITIAL_ADMIN_USERNAME || 'admin'),
      time,
    ),
    stmt(
      env.DB,
      'INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES(?,?,?)',
      'auth.password',
      JSON.stringify(password),
      time,
    ),
  ]);
}

async function login(request, env) {
  const db = env.DB,
    data = await body(request),
    now = Date.now();
  if (
    typeof data.username !== 'string' ||
    typeof data.password !== 'string' ||
    data.password.length > 1024
  )
    fail('账号或密码格式无效');
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const bucket = `${await digest(ip)}:${Math.floor(now / 900000)}`;
  const attempt = await stmt(
    db,
    'INSERT INTO login_attempts(bucket,attempts,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts',
    bucket,
    now + 900000,
  ).first();
  if (attempt.attempts > 20) fail('尝试次数过多，请 15 分钟后再试', 429);
  await bootstrap(env);
  const username = await setting(db, 'auth.username'),
    stored = await setting(db, 'auth.password');
  const verified = await verifyPassword(stored, data.password);
  if (!equal(String(username), data.username) || !verified) fail('账号或密码错误', 401);
  const token = randomToken(),
    csrf = randomToken();
  await stmt(
    db,
    'INSERT INTO sessions(token_hash,csrf,username,expires_at) VALUES(?,?,?,?)',
    await digest(token),
    csrf,
    username,
    now + 1800000,
  ).run();
  return json({ username, csrf, timezone: env.APP_TIMEZONE || 'Asia/Shanghai' }, 200, {
    'Set-Cookie': cookie(request, token),
  });
}
async function validateTask(db, input, importing = false) {
  if (!input || typeof input !== 'object') fail('任务格式无效');
  if (!importing && input.channel && input.channel !== 'webhook') fail('仅支持 Webhook 渠道');
  const title = String(input.title || '').trim(),
    message = String(input.message || ''),
    url = String(input.url || '').trim();
  if (!title || title.length > 200) fail('标题不能为空或超过 200 字');
  if (message.length > 20000) fail('正文超过 20000 字');
  if (url && !/^https?:\/\//i.test(url)) fail('相关链接必须是 HTTP(S) URL');
  const cron_expression = parseCron(input.cron_expression).normalized;
  if (!nextRun(cron_expression)) fail('Cron 在未来八年内没有执行时刻');
  let tags = input.tags || [];
  if (typeof tags === 'string') {
    try {
      tags = JSON.parse(tags);
    } catch {
      tags = tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    }
  }
  if (
    !Array.isArray(tags) ||
    tags.length > 20 ||
    tags.some((t) => typeof t !== 'string' || t.length > 50)
  )
    fail('标签最多 20 个，每个最多 50 字');
  const defaultGroup = await stmt(db, "SELECT id FROM groups WHERE name='默认'").first();
  const defaultTarget = await stmt(
    db,
    "SELECT id FROM webhook_targets WHERE provider='serverchan3' ORDER BY id LIMIT 1",
  ).first();
  let group_id = input.group_id ? id(input.group_id) : defaultGroup?.id;
  let webhook_id =
    importing && input.channel !== 'webhook'
      ? defaultTarget?.id
      : input.webhook_id
        ? id(input.webhook_id)
        : defaultTarget?.id;
  if (!(await stmt(db, 'SELECT id FROM groups WHERE id=?', group_id || 0).first())) {
    if (importing) group_id = defaultGroup?.id;
    else fail('分组不存在');
  }
  if (!(await stmt(db, 'SELECT id FROM webhook_targets WHERE id=?', webhook_id || 0).first())) {
    if (importing) webhook_id = defaultTarget?.id;
    else fail('Webhook 通道不存在');
  }
  if (!group_id || !webhook_id) fail('请先创建默认分组和 Server酱³ 通道');
  if (input.enabled !== undefined && ![true, false, 0, 1].includes(input.enabled))
    fail('启用状态必须是布尔值');
  return {
    title,
    message,
    url,
    cron_expression,
    tags,
    group_id,
    webhook_id,
    enabled: input.enabled === false || input.enabled === 0 ? 0 : 1,
  };
}

async function api(request, env) {
  const db = env.DB,
    u = new URL(request.url),
    path = u.pathname,
    method = request.method;
  const mutation = !['GET', 'HEAD'].includes(method);
  if (mutation && request.headers.get('Origin') !== u.origin) fail('请求来源校验失败', 403);
  if (mutation && !request.headers.get('Content-Type')?.startsWith('application/json'))
    fail('请求必须使用 application/json', 415);
  if (path === '/api/login' && method === 'POST') return login(request, env);
  const auth = await session(request, db);
  if (!auth) fail('请先登录', 401);
  if (mutation && !equal(request.headers.get('X-CSRF-Token') || '', auth.csrf))
    fail('CSRF 校验失败', 403);
  const time = localText(Date.now(), env.APP_TIMEZONE);
  if (path === '/api/session' && method === 'GET')
    return json({
      username: auth.username,
      csrf: auth.csrf,
      timezone: env.APP_TIMEZONE || 'Asia/Shanghai',
    });
  if (path === '/api/logout' && method === 'POST') {
    await stmt(db, 'DELETE FROM sessions WHERE token_hash=?', auth.token_hash).run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, '', 0) });
  }
  if (path === '/api/tasks/export' && method === 'GET') {
    const tasks = (await rows(db, 'SELECT * FROM tasks ORDER BY id')).map(decodeTask);
    return json(tasks, 200, { 'Content-Disposition': 'attachment; filename="taskly-export.json"' });
  }
  if (path === '/api/tasks/import' && method === 'POST') {
    const inputs = await body(request);
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 100)
      fail('请导入 1–100 个任务；较大的文件请拆分');
    const tasks = [];
    for (let i = 0; i < inputs.length; i++) {
      try {
        tasks.push(await validateTask(db, inputs[i], true));
      } catch (e) {
        fail(`第 ${i + 1} 个任务：${e.message}`);
      }
    }
    await db.batch(
      tasks.map((t) =>
        stmt(
          db,
          `INSERT INTO tasks(${TASK_FIELDS}) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          ...taskValues(t, time),
        ),
      ),
    );
    return json({ count: tasks.length }, 201);
  }
  if (path === '/api/tasks/batch' && method === 'POST') {
    const data = await body(request);
    if (!Array.isArray(data.ids) || !data.ids.length || data.ids.length > 100)
      fail('请选择 1–100 个任务');
    const ids = [...new Set(data.ids.map(id))];
    if (!['enable', 'disable', 'delete'].includes(data.action)) fail('批量操作无效');
    const sql =
      data.action === 'delete'
        ? 'DELETE FROM tasks WHERE id=?'
        : 'UPDATE tasks SET enabled=?,updated_at=? WHERE id=?';
    const result = await db.batch(
      ids.map((taskId) =>
        stmt(
          db,
          sql,
          ...(data.action === 'delete'
            ? [taskId]
            : [data.action === 'enable' ? 1 : 0, time, taskId]),
        ),
      ),
    );
    return json({ count: result.reduce((sum, r) => sum + r.meta.changes, 0) });
  }
  if (path === '/api/tasks' && method === 'GET') {
    const filter = [],
      args = [];
    if (u.searchParams.get('q')) {
      filter.push('(t.title LIKE ? OR t.message LIKE ?)');
      args.push(`%${u.searchParams.get('q')}%`, `%${u.searchParams.get('q')}%`);
    }
    for (const key of ['group_id', 'webhook_id'])
      if (u.searchParams.get(key)) {
        filter.push(`t.${key}=?`);
        args.push(id(u.searchParams.get(key)));
      }
    if (['0', '1'].includes(u.searchParams.get('enabled'))) {
      filter.push('t.enabled=?');
      args.push(Number(u.searchParams.get('enabled')));
    }
    if (u.searchParams.get('tag')) {
      filter.push('EXISTS(SELECT 1 FROM json_each(t.tags) WHERE value=?)');
      args.push(u.searchParams.get('tag'));
    }
    const status = u.searchParams.get('last_status');
    if (['success', 'failed'].includes(status)) {
      filter.push(
        '(SELECT status FROM execution_history WHERE task_id=t.id ORDER BY id DESC LIMIT 1)=?',
      );
      args.push(status);
    }
    const where = filter.length ? ' WHERE ' + filter.join(' AND ') : '';
    const total = (await stmt(db, 'SELECT COUNT(*) AS n FROM tasks t' + where, ...args).first()).n;
    const page = Math.max(
      1,
      Math.min(Math.ceil(total / 20) || 1, Number.parseInt(u.searchParams.get('page'), 10) || 1),
    );
    const tasks = await rows(
      db,
      `SELECT t.*,g.name AS group_name,w.name AS webhook_name,
      (SELECT status FROM execution_history WHERE task_id=t.id ORDER BY id DESC LIMIT 1) AS last_status,
      (SELECT executed_at FROM execution_history WHERE task_id=t.id ORDER BY id DESC LIMIT 1) AS last_run_at
      FROM tasks t JOIN groups g ON g.id=t.group_id JOIN webhook_targets w ON w.id=t.webhook_id${where} ORDER BY t.id DESC LIMIT 20 OFFSET ?`,
      ...args,
      (page - 1) * 20,
    );
    return json({
      tasks: tasks.map((t) => ({
        ...decodeTask(t),
        next_run: nextRun(t.cron_expression, Date.now(), env.APP_TIMEZONE),
      })),
      total,
      page,
      pages: Math.ceil(total / 20) || 1,
    });
  }
  if (path === '/api/tasks' && method === 'POST') {
    const t = await validateTask(db, await body(request));
    const r = await stmt(
      db,
      `INSERT INTO tasks(${TASK_FIELDS}) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      ...taskValues(t, time),
    ).run();
    return json({ id: r.meta.last_row_id }, 201);
  }
  const taskRoute = path.match(/^\/api\/tasks\/(\d+)(?:\/(run|history|toggle))?$/);
  if (taskRoute) {
    const taskId = id(taskRoute[1]),
      action = taskRoute[2],
      t = await stmt(db, 'SELECT * FROM tasks WHERE id=?', taskId).first();
    if (!t) fail('任务不存在', 404);
    if (method === 'GET' && !action) return json(decodeTask(t));
    if (method === 'PUT' && !action) {
      const updated = await validateTask(db, await body(request));
      await stmt(
        db,
        'UPDATE tasks SET title=?,message=?,url=?,cron_expression=?,channel=?,enabled=?,tags=?,group_id=?,webhook_id=?,updated_at=? WHERE id=?',
        ...taskValues(updated, time).slice(0, 9),
        time,
        taskId,
      ).run();
      return json({ ok: true });
    }
    if (method === 'DELETE' && !action) {
      await stmt(db, 'DELETE FROM tasks WHERE id=?', taskId).run();
      return json({ ok: true });
    }
    if (method === 'POST' && action === 'toggle') {
      await stmt(
        db,
        'UPDATE tasks SET enabled=1-enabled,updated_at=? WHERE id=?',
        time,
        taskId,
      ).run();
      return json({ ok: true });
    }
    if (method === 'POST' && action === 'run') return json(await executeTask(t, env));
    if (method === 'GET' && action === 'history') {
      const page = Math.max(1, Number.parseInt(u.searchParams.get('page'), 10) || 1);
      const total = (
        await stmt(
          db,
          'SELECT COUNT(*) AS n FROM execution_history WHERE task_id=?',
          taskId,
        ).first()
      ).n;
      return json({
        task: decodeTask(t),
        history: await rows(
          db,
          'SELECT * FROM execution_history WHERE task_id=? ORDER BY id DESC LIMIT 100 OFFSET ?',
          taskId,
          (page - 1) * 100,
        ),
        total,
        page,
      });
    }
  }
  if (path === '/api/groups' && method === 'GET')
    return json(
      await rows(
        db,
        'SELECT g.*,COUNT(t.id) AS task_count FROM groups g LEFT JOIN tasks t ON t.group_id=g.id GROUP BY g.id ORDER BY g.sort_order,g.id',
      ),
    );
  const groupRoute = path.match(/^\/api\/groups\/(\d+)$/);
  if ((path === '/api/groups' && method === 'POST') || (groupRoute && method === 'PUT')) {
    const data = await body(request),
      name = String(data.name || '').trim();
    if (!name || name.length > 100) fail('分组名称不能为空或超过 100 字');
    const sort = Number(data.sort_order || 0);
    if (!Number.isSafeInteger(sort)) fail('排序必须是整数');
    if (groupRoute) {
      const group = await stmt(db, 'SELECT * FROM groups WHERE id=?', id(groupRoute[1])).first();
      if (!group) fail('分组不存在', 404);
      if (group.name === '默认' && name !== '默认') fail('默认分组不能改名');
      await stmt(
        db,
        'UPDATE groups SET name=?,icon=?,sort_order=?,updated_at=? WHERE id=?',
        name,
        String(data.icon || '📁').slice(0, 80),
        sort,
        time,
        group.id,
      ).run();
    } else
      await stmt(
        db,
        'INSERT INTO groups(name,icon,sort_order,created_at,updated_at) VALUES(?,?,?,?,?)',
        name,
        String(data.icon || '📁').slice(0, 80),
        sort,
        time,
        time,
      ).run();
    return json({ ok: true });
  }
  if (groupRoute && method === 'DELETE') {
    const groupId = id(groupRoute[1]),
      group = await stmt(db, 'SELECT name FROM groups WHERE id=?', groupId).first();
    if (!group) fail('分组不存在', 404);
    if (group.name === '默认') fail('默认分组不能删除');
    if (await stmt(db, 'SELECT id FROM tasks WHERE group_id=? LIMIT 1', groupId).first())
      fail('请先移动或删除分组内的任务', 409);
    await stmt(db, 'DELETE FROM groups WHERE id=?', groupId).run();
    return json({ ok: true });
  }
  if (path === '/api/settings' && method === 'GET')
    return json({
      auth: {
        username: await setting(db, 'auth.username'),
        note: (await setting(db, 'auth.note')) || '',
      },
      targets: await rows(db, 'SELECT * FROM webhook_targets ORDER BY id'),
      serverchan_secrets_configured: Boolean(env.SERVERCHAN_UID && env.SERVERCHAN_SENDKEY),
    });
  if (path === '/api/settings/auth' && method === 'PUT') {
    const data = await body(request),
      username = String(data.username || '').trim();
    if (!username || username.length > 100) fail('账号不能为空或超过 100 字');
    if (
      !(await verifyPassword(
        await setting(db, 'auth.password'),
        String(data.current_password || ''),
      ))
    )
      fail('当前密码不正确', 403);
    const changes = [
      setSetting(db, 'auth.username', username, time),
      setSetting(db, 'auth.note', String(data.note || '').slice(0, 1000), time),
    ];
    if (data.password) {
      if (
        typeof data.password !== 'string' ||
        data.password.length < 12 ||
        data.password.length > 1024
      )
        fail('新密码应为 12–1024 位');
      changes.push(setSetting(db, 'auth.password', await hashPassword(data.password), time));
    }
    changes.push(stmt(db, 'DELETE FROM sessions'));
    await db.batch(changes);
    return json({ ok: true, login_required: true }, 200, { 'Set-Cookie': cookie(request, '', 0) });
  }
  const targetRoute = path.match(/^\/api\/webhooks\/(\d+)(?:\/(test))?$/);
  if (
    (path === '/api/webhooks' && method === 'POST') ||
    (targetRoute && !targetRoute[2] && method === 'PUT')
  ) {
    const target = validateTarget(await body(request));
    if (targetRoute) {
      const old = await stmt(
        db,
        'SELECT * FROM webhook_targets WHERE id=?',
        id(targetRoute[1]),
      ).first();
      if (!old) fail('通道不存在', 404);
      if (
        old.provider === 'serverchan3' &&
        (target.provider !== 'serverchan3' || target.name !== 'Server酱³')
      )
        fail('默认 Server酱³ 通道不能改名或更换类型');
      await stmt(
        db,
        'UPDATE webhook_targets SET name=?,method=?,url=?,template=?,note=?,provider=? WHERE id=?',
        ...Object.values(target),
        old.id,
      ).run();
    } else
      await stmt(
        db,
        'INSERT INTO webhook_targets(name,method,url,template,note,provider) VALUES(?,?,?,?,?,?)',
        ...Object.values(target),
      ).run();
    return json({ ok: true });
  }
  if (targetRoute) {
    const targetId = id(targetRoute[1]),
      target = await stmt(db, 'SELECT * FROM webhook_targets WHERE id=?', targetId).first();
    if (!target) fail('通道不存在', 404);
    if (method === 'POST' && targetRoute[2] === 'test') {
      await sendWebhook(
        { title: 'Taskly · 通道测试', message: `测试消息发送时间：${time}`, url: '' },
        target,
        env,
      );
      return json({ ok: true });
    }
    if (method === 'DELETE' && !targetRoute[2]) {
      if (target.provider === 'serverchan3') fail('默认 Server酱³ 通道不能删除');
      if (await stmt(db, 'SELECT id FROM tasks WHERE webhook_id=? LIMIT 1', targetId).first())
        fail('通道仍被任务使用', 409);
      await stmt(db, 'DELETE FROM webhook_targets WHERE id=?', targetId).run();
      return json({ ok: true });
    }
  }
  if (path === '/api/statistics' && method === 'GET') {
    const days = Math.max(1, Math.min(365, Number.parseInt(u.searchParams.get('days'), 10) || 14));
    const since =
      localText(Date.now() - (days - 1) * 86400000, env.APP_TIMEZONE).slice(0, 10) + ' 00:00:00';
    const summary = await stmt(
      db,
      'SELECT COUNT(*) AS total,SUM(enabled) AS enabled FROM tasks',
    ).first();
    const counts = await stmt(
      db,
      "SELECT COUNT(*) AS total,SUM(status='success') AS success,SUM(status='failed') AS failed FROM execution_history WHERE executed_at>=?",
      since,
    ).first();
    const daily = await rows(
      db,
      "SELECT substr(executed_at,1,10) AS day,SUM(status='success') AS success,SUM(status='failed') AS failed FROM execution_history WHERE executed_at>=? GROUP BY day ORDER BY day",
      since,
    );
    return json({
      tasks: { total: summary.total, enabled: summary.enabled || 0 },
      executions: { total: counts.total, success: counts.success || 0, failed: counts.failed || 0 },
      daily,
      recent: await rows(
        db,
        `SELECT h.*,COALESCE(t.title,'已删除任务 #' || COALESCE(h.legacy_task_id,h.task_id,0)) AS title FROM execution_history h LEFT JOIN tasks t ON t.id=h.task_id ORDER BY h.id DESC LIMIT 12`,
      ),
      scheduler: Object.fromEntries(
        (await rows(db, 'SELECT * FROM scheduler_state')).map((s) => [s.key, s.value]),
      ),
      pending_claims: (
        await stmt(db, 'SELECT COUNT(*) AS n FROM execution_claims WHERE finished=0').first()
      ).n,
    });
  }
  if (path === '/api/calendar' && method === 'GET') {
    const month = u.searchParams.get('month') || time.slice(0, 7);
    if (!/^(20\d\d|2100)-(0[1-9]|1[012])$/.test(month)) fail('月份格式无效');
    const [year, m] = month.split('-').map(Number);
    const start = Date.UTC(year, m - 1, 1) - 86400000,
      end = Date.UTC(year, m, 1) + 86400000;
    const tasks = await rows(
      db,
      'SELECT id,title,cron_expression,group_id FROM tasks WHERE enabled=1',
    );
    let entries = [],
      overflow = false;
    for (const t of tasks) {
      const found = occurrences(
        t.cron_expression,
        Math.max(start, Date.now()),
        end,
        env.APP_TIMEZONE,
        601,
      ).filter((ts) => localText(ts, env.APP_TIMEZONE).startsWith(month));
      if (found.length > 600) overflow = true;
      entries.push(
        ...found.slice(0, 600).map((ts) => ({
          task_id: t.id,
          title: t.title,
          when: localText(ts, env.APP_TIMEZONE),
          timestamp: ts,
        })),
      );
    }
    entries.sort((a, b) => a.timestamp - b.timestamp);
    return json({
      month,
      entries: entries.slice(0, 600),
      overflow: overflow || entries.length > 600,
    });
  }
  if (path === '/api/cron/preview' && method === 'POST') {
    const data = await body(request),
      c = parseCron(data.expression);
    return json({
      normalized: c.normalized,
      next: occurrences(
        c.normalized,
        Date.now() + 60000,
        Date.now() + 366 * 8 * 86400000,
        env.APP_TIMEZONE,
        5,
      ).map((ts) => localText(ts, env.APP_TIMEZONE)),
    });
  }
  fail('接口不存在', 404);
}

export default {
  async fetch(request, env) {
    let response;
    try {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/api/')) response = await api(request, env);
      else {
        if (!['GET', 'HEAD'].includes(request.method)) fail('请求方式不支持', 405);
        // Assets serves index.html at / and redirects /index.html back to /.
        const assetPath = [
          '/',
          '/tasks',
          '/calendar',
          '/groups',
          '/settings',
          '/monitoring',
          '/login',
        ].includes(path)
          ? '/'
          : path;
        const url = new URL(request.url);
        url.pathname = assetPath;
        response = await env.ASSETS.fetch(new Request(url, request));
      }
    } catch (exc) {
      const message = exc.message || '';
      const constraint = /UNIQUE constraint|FOREIGN KEY constraint/.test(message);
      const validation = message.startsWith('Cron') || /通道|模板|Webhook|Server酱/.test(message);
      const status = exc.status || (constraint ? 409 : validation ? 400 : 500);
      if (status === 500) console.error('Request failed', exc.name);
      response = json(
        {
          error:
            status === 500
              ? '服务暂时不可用，请检查 D1 绑定和数据库迁移'
              : constraint
                ? '名称重复或记录仍被引用'
                : message,
        },
        status,
      );
    }
    const secure = new Response(response.body, response);
    for (const [key, value] of Object.entries(SECURITY)) secure.headers.set(key, value);
    return secure;
  },
  async scheduled(controller, env) {
    await runScheduled(env, controller.scheduledTime);
  },
};
