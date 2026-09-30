'use strict';
const $ = (selector) => document.querySelector(selector);
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const state = {
  auth: null,
  groups: [],
  targets: [],
  tasks: [],
  page: 1,
  month: '',
  selected: new Set(),
  busy: false,
};
const main = $('#main'),
  dialog = $('#dialog');
let toastTimer,
  renderVersion = 0;
const datetime = (timestamp) =>
  timestamp
    ? new Intl.DateTimeFormat('sv-SE', {
        timeZone: state.auth?.timezone || 'Asia/Shanghai',
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(timestamp))
    : '暂无';
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('#toast').hidden = true;
  }, 4500);
}
function showLogin() {
  state.auth = null;
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  if (dialog.open) dialog.close();
}
async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: {} };
  if (init.method !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    init.headers['X-CSRF-Token'] = state.auth?.csrf || '';
    init.body = JSON.stringify(options.body ?? {});
  }
  const response = await fetch(path, init),
    data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') showLogin();
    throw new Error(data.error || '请求失败');
  }
  return data;
}
async function guarded(action, element) {
  if (element?.disabled) return;
  if (element) element.disabled = true;
  try {
    await action();
  } catch (e) {
    toast(e.message);
  } finally {
    if (element) element.disabled = false;
  }
}
function heading(eyebrow, title, subtitle, actions = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${subtitle}</p></div><div class="actions">${actions}</div></div>`;
}
const badge = (status) =>
  `<span class="badge ${status === 'failed' ? 'failed' : status ? '' : 'neutral'}">${status === 'success' ? '成功' : status === 'failed' ? '失败' : '尚未执行'}</span>`;
const taskActions = (id) =>
  `<div class="row-actions"><button data-action="edit-task" data-id="${id}">编辑</button><button data-action="history" data-id="${id}">历史</button><button data-action="run" data-id="${id}">执行</button><button data-action="delete-task" data-id="${id}" class="danger">删除</button></div>`;
async function metadata() {
  const [groups, settings] = await Promise.all([api('/api/groups'), api('/api/settings')]);
  state.groups = groups;
  state.targets = settings.targets;
  return settings;
}
function targetNotice(settings) {
  const defaultTarget = state.targets.find((t) => t.provider === 'serverchan3');
  return defaultTarget && !defaultTarget.url && !settings.serverchan_secrets_configured
    ? '<div class="notice warn">Server酱³ 尚未配置推送地址。请到 <a href="/settings" data-page="settings">设置</a> 填写地址，或配置 Worker 的 UID / SendKey secrets。</div>'
    : '';
}
const currentPage = () =>
  ({
    '/': 'dashboard',
    '/tasks': 'tasks',
    '/calendar': 'calendar',
    '/groups': 'groups',
    '/monitoring': 'monitoring',
    '/settings': 'settings',
  })[location.pathname] || 'dashboard';
async function renderPage() {
  if (!state.auth) return;
  const version = ++renderVersion,
    page = currentPage();
  document
    .querySelectorAll('nav [data-page]')
    .forEach((a) => a.classList.toggle('active', a.dataset.page === page));
  document.title =
    {
      dashboard: '概览',
      tasks: '任务管理',
      calendar: '任务日历',
      groups: '分组管理',
      monitoring: '运行监控',
      settings: '设置',
    }[page] + ' · Taskly';
  main.innerHTML = '<p class="loading">正在加载…</p>';
  try {
    const html = await {
      dashboard,
      tasksPage,
      calendarPage,
      groupsPage,
      monitoringPage,
      settingsPage,
    }[
      {
        tasks: 'tasksPage',
        calendar: 'calendarPage',
        groups: 'groupsPage',
        monitoring: 'monitoringPage',
        settings: 'settingsPage',
      }[page] || page
    ]();
    if (version !== renderVersion || !state.auth) return;
    main.innerHTML = html;
  } catch (e) {
    if (version === renderVersion && state.auth)
      main.innerHTML = `<div class="notice warn">${escape(e.message)}</div><button data-action="refresh">重试</button>`;
  }
}
async function navigate(path) {
  history.pushState({}, '', path);
  state.selected.clear();
  $('.sidebar').classList.remove('open');
  await renderPage();
}

async function dashboard() {
  const [stats, taskData, settings] = await Promise.all([
    api('/api/statistics'),
    api('/api/tasks'),
    metadata(),
  ]);
  const total = stats.tasks.total,
    max = Math.max(1, ...stats.daily.map((d) => d.success + d.failed));
  const days = Array.from({ length: 14 }, (_, i) => {
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: state.auth.timezone }).format(
      new Date(Date.now() - (13 - i) * 86400000),
    );
    return { day, success: 0, failed: 0, ...stats.daily.find((d) => d.day === day) };
  });
  const recent = taskData.tasks
    .slice(0, 6)
    .map(
      (t) =>
        `<tr><td><a href="/tasks" data-page="tasks" class="title">${escape(t.title)}</a><small>${escape(t.group_name)} · ${escape(t.webhook_name)}</small></td><td><code>${escape(t.cron_expression)}</code></td><td>${datetime(t.next_run)}</td><td>${badge(t.last_status)}</td></tr>`,
    )
    .join('');
  // SVG uses presentation attributes supported by CSP, with no inline CSS.
  const svgBars = days
    .map(
      (d, i) =>
        `<g><rect x="${i * 40 + 6}" y="${145 - (d.success / max) * 125}" width="10" height="${Math.max(2, (d.success / max) * 125)}" rx="3" fill="#73ab94"/><rect x="${i * 40 + 19}" y="${145 - (d.failed / max) * 125}" width="10" height="${Math.max(2, (d.failed / max) * 125)}" rx="3" fill="#df9b89"/><text x="${i * 40 + 16}" y="168" text-anchor="middle" fill="#778781" font-size="9">${d.day.slice(5).replace('-', '/')}</text></g>`,
    )
    .join('');
  return (
    heading(
      'OVERVIEW',
      '今天，也有条不紊',
      '管理你的提醒，让每件重要的事如期发生。',
      '<button class="primary" data-action="new-task">＋ 新建任务</button>',
    ) +
    targetNotice(settings) +
    `<div class="cards"><div class="card"><div class="label">全部任务</div><div class="number">${total}</div><div class="detail">${state.groups.length} 个分组</div></div><div class="card accent"><div class="label">启用中的任务</div><div class="number">${stats.tasks.enabled}</div><div class="detail">通过 Webhook 自动提醒</div></div><div class="card"><div class="label">近 14 天执行</div><div class="number">${stats.executions.total}</div><div class="detail">成功 ${stats.executions.success} 次</div></div><div class="card"><div class="label">近 14 天失败</div><div class="number">${stats.executions.failed}</div><div class="detail">${stats.executions.failed ? '可在运行监控查看原因' : '一切井然有序'}</div></div></div>
    <div class="two-column"><section class="panel"><div class="panel-head"><h2>执行趋势</h2><div class="legend"><span>成功</span><span>失败</span></div></div><svg class="trend-chart" viewBox="0 0 560 180" role="img" aria-label="近十四天执行趋势">${svgBars}</svg></section><section class="panel"><div class="panel-head"><h2>任务分布</h2><small>按分组</small></div>${state.groups.map((g) => `<div class="group-bar"><div><span>${escape(g.name)}</span><span>${g.task_count}</span></div><progress max="${Math.max(1, total)}" value="${g.task_count}"></progress></div>`).join('') || '<p class="empty">暂无分组</p>'}</section></div>
    <section class="panel"><div class="panel-head"><h2>最近添加的任务</h2><a href="/tasks" data-page="tasks">查看全部 →</a></div><div class="table-wrap"><table><thead><tr><th>任务</th><th>计划</th><th>下次执行</th><th>最近结果</th></tr></thead><tbody>${recent || '<tr><td colspan="4" class="empty">还没有任务，创建第一个提醒吧。</td></tr>'}</tbody></table></div></section>`
  );
}
async function tasksPage() {
  const settings = await metadata(),
    query = new URLSearchParams(location.search),
    data = await api('/api/tasks?' + query);
  state.tasks = data.tasks;
  state.page = data.page;
  const option = (value, label, selected) =>
    `<option value="${escape(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${escape(label)}</option>`;
  const rows = data.tasks
    .map(
      (t) =>
        `<tr><td><input type="checkbox" aria-label="选择 ${escape(t.title)}" data-select="${t.id}" ${state.selected.has(t.id) ? 'checked' : ''}></td><td><span class="title">${escape(t.title)}</span><small>${escape(t.message)}</small>${t.tags.map((tag) => `<span class="tag">${escape(tag)}</span>`).join('')}</td><td><span class="badge neutral">${escape(t.group_name)}</span><small>${escape(t.webhook_name)}</small></td><td><code>${escape(t.cron_expression)}</code><small>${datetime(t.next_run)}</small></td><td><button class="switch ${t.enabled ? 'on' : ''}" role="switch" aria-checked="${t.enabled}" aria-label="启停 ${escape(t.title)}" data-action="toggle" data-id="${t.id}"></button></td><td>${badge(t.last_status)}<small>${escape(t.last_run_at || '—')}</small></td><td>${taskActions(t.id)}</td></tr>`,
    )
    .join('');
  return (
    heading(
      'TASKS',
      '任务管理',
      `共 ${data.total} 个任务 · 所有提醒均通过 Webhook 发送`,
      '<button data-action="export">导出</button><button data-action="import">导入</button><button class="primary" data-action="new-task">＋ 新建任务</button>',
    ) +
    targetNotice(settings) +
    `<section class="panel"><form id="filters" class="toolbar"><input name="q" placeholder="搜索标题或内容…" aria-label="搜索任务" value="${escape(query.get('q') || '')}"><select name="group_id" aria-label="筛选分组">${option('', '全部分组', query.get('group_id'))}${state.groups.map((g) => option(g.id, g.name, query.get('group_id'))).join('')}</select><select name="enabled" aria-label="筛选启用状态">${option('', '全部状态', query.get('enabled'))}${option('1', '已启用', query.get('enabled'))}${option('0', '已停用', query.get('enabled'))}</select><select name="last_status" aria-label="筛选执行结果">${option('', '全部结果', query.get('last_status'))}${option('success', '最近成功', query.get('last_status'))}${option('failed', '最近失败', query.get('last_status'))}</select><input name="tag" placeholder="标签" aria-label="筛选标签" class="tag-filter" value="${escape(query.get('tag') || '')}"><button type="submit">筛选</button><button type="button" data-action="clear-filters">重置</button></form>
    <div class="actions batch-toolbar"><small id="selected-count">已选择 ${state.selected.size} 个</small><button data-action="batch" data-value="enable">批量启用</button><button data-action="batch" data-value="disable">批量停用</button><button class="danger" data-action="batch" data-value="delete">批量删除</button></div>
    <div class="table-wrap"><table><thead><tr><th><input type="checkbox" id="select-all" aria-label="选择当前页所有任务"></th><th>任务</th><th>分组 / 通道</th><th>计划 / 下次执行</th><th>启用</th><th>最近结果</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="empty">没有找到任务。</td></tr>'}</tbody></table></div><div class="pagination"><span>共 ${data.total} 个任务 · 第 ${data.page} / ${data.pages} 页</span><div class="actions"><button data-action="page" data-value="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''}>上一页</button><button data-action="page" data-value="${data.page + 1}" ${data.page >= data.pages ? 'disabled' : ''}>下一页</button></div></div></section>`
  );
}
async function calendarPage() {
  await metadata();
  if (!state.month)
    state.month = new Intl.DateTimeFormat('sv-SE', { timeZone: state.auth.timezone })
      .format(new Date())
      .slice(0, 7);
  const data = await api('/api/calendar?month=' + state.month),
    [year, month] = state.month.split('-').map(Number);
  const first = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7,
    days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: state.auth.timezone }).format(
    new Date(),
  );
  const cells = Array.from({ length: Math.ceil((first + days) / 7) * 7 }, (_, i) => {
    const day = i - first + 1;
    if (day < 1 || day > days) return '<div class="calendar-day outside"></div>';
    const date = state.month + '-' + String(day).padStart(2, '0'),
      events = data.entries.filter((e) => e.when.startsWith(date));
    return `<div class="calendar-day ${today === date ? 'today' : ''}"><span class="day-number">${day}</span>${events
      .slice(0, 5)
      .map(
        (e) =>
          `<button class="calendar-entry" data-action="edit-task" data-id="${e.task_id}" title="${escape(e.title)}">${e.when.slice(11, 16)} ${escape(e.title)}</button>`,
      )
      .join('')}${events.length > 5 ? `<small>还有 ${events.length - 5} 项</small>` : ''}</div>`;
  }).join('');
  return (
    heading(
      'CALENDAR',
      '任务日历',
      '查看启用任务的未来提醒计划。',
      '<button data-action="month" data-value="-1">←</button><input class="month-input" type="month" id="calendar-month" min="2000-01" max="2100-12" aria-label="选择月份" value="' +
        state.month +
        '"><button data-action="month" data-value="1">→</button>',
    ) +
    (data.overflow
      ? '<div class="notice warn">当前月份展示前 600 个提醒。可按任务的 Cron 表达式确认完整计划。</div>'
      : '') +
    `<section class="panel"><div class="calendar-grid">${['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((d) => `<div class="calendar-weekday">${d}</div>`).join('')}${cells}</div></section><section class="panel"><h2>本月接下来的提醒</h2><div class="table-wrap"><table><thead><tr><th>时间</th><th>任务</th><th></th></tr></thead><tbody>${
      data.entries
        .slice(0, 100)
        .map(
          (e) =>
            `<tr><td>${e.when}</td><td>${escape(e.title)}</td><td><button data-action="edit-task" data-id="${e.task_id}">查看</button></td></tr>`,
        )
        .join('') || '<tr><td colspan="3" class="empty">这个月没有更多提醒了。</td></tr>'
    }</tbody></table></div></section>`
  );
}
async function groupsPage() {
  await metadata();
  return (
    heading(
      'GROUPS',
      '分组管理',
      '给任务一个清晰的归属。',
      '<button class="primary" data-action="new-group">＋ 新建分组</button>',
    ) +
    `<div class="group-grid">${state.groups.map((g) => `<section class="group-card"><div class="group-icon">${escape(g.icon.startsWith('ph-') ? '📁' : g.icon)}</div><h2>${escape(g.name)}</h2><p class="muted">${g.task_count} 个任务 · 排序 ${g.sort_order}</p><div class="actions"><button data-action="group-tasks" data-id="${g.id}">查看任务</button><button data-action="edit-group" data-id="${g.id}">编辑</button>${g.name === '默认' ? '' : `<button data-action="delete-group" data-id="${g.id}" class="danger">删除</button>`}</div></section>`).join('')}</div>`
  );
}
function executionTable(history) {
  return `<div class="table-wrap"><table><thead><tr><th>执行时间</th><th>任务</th><th>结果</th><th>来源 / 详情</th></tr></thead><tbody>${history.map((h) => `<tr><td>${escape(h.executed_at)}</td><td>${escape(h.title || '')}</td><td>${badge(h.status)}</td><td><small>${h.source === 'manual' ? '手动执行' : '定时执行'}</small>${h.error ? `<div class="history-error">${escape(h.error)}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">暂无执行记录</td></tr>'}</tbody></table></div>`;
}
async function monitoringPage() {
  const stats = await api('/api/statistics?days=30');
  const scan = stats.scheduler.last_completed,
    stale =
      stats.scheduler.last_completed_epoch &&
      Number(stats.scheduler.last_completed_epoch) < Date.now() - 600000;
  return (
    heading(
      'MONITORING',
      '运行监控',
      '跟踪每一次提醒，以及任务调度的运行状态。',
      '<button data-action="refresh">刷新</button>',
    ) +
    `<div class="monitor-grid"><div class="card"><div class="label">上次调度完成</div><div class="number">${escape(scan || '等待首次触发')}</div><div class="detail">${stale ? '超过 10 分钟，请检查 Cloudflare Cron' : '每分钟扫描一次到期任务'}</div></div><div class="card"><div class="label">近 30 天执行</div><div class="number">${stats.executions.total} 次</div><div class="detail">成功 ${stats.executions.success} · 失败 ${stats.executions.failed}</div></div><div class="card"><div class="label">执行中的任务</div><div class="number">${stats.pending_claims}</div><div class="detail">异常中断将在 20 分钟后记录失败</div></div></div><div class="notice">提醒按分钟触发。调度延迟时补扫最近 5 分钟；投递失败记录原因，可在任务页手动重试。</div><section class="panel"><h2>最近执行记录</h2>${executionTable(stats.recent)}</section>`
  );
}
async function settingsPage() {
  const settings = await metadata();
  const cards = settings.targets
    .map(
      (t) =>
        `<form class="webhook-card" data-target-form="${t.id}"><div class="panel-head"><h3>${escape(t.name)}</h3><span class="badge neutral">${t.provider === 'serverchan3' ? '默认通道' : '自定义 Webhook'}</span></div><div class="field-grid"><label>通道名称<input name="name" value="${escape(t.name)}" ${t.provider === 'serverchan3' ? 'readonly' : ''} required></label><label>请求方式<select name="method">${[
          ['get', 'GET'],
          ['post_json', 'POST · JSON'],
          ['post_form', 'POST · 表单'],
        ]
          .map(([v, n]) => `<option value="${v}" ${v === t.method ? 'selected' : ''}>${n}</option>`)
          .join(
            '',
          )}</select></label><label class="full">${t.provider === 'serverchan3' ? 'Server酱³ 推送地址' : '请求地址'}<input name="url" value="${escape(t.url)}" placeholder="${t.provider === 'serverchan3' ? 'https://UID.push.ft07.com/send/SENDKEY.send' : 'https://example.com/webhook'}" autocomplete="off"><small>${t.provider === 'serverchan3' ? '留空时使用 Worker secrets：SERVERCHAN_UID / SERVERCHAN_SENDKEY。' : 'GET 地址可使用占位符。'}</small></label><label class="full">请求模板<textarea name="template" spellcheck="false">${escape(t.template)}</textarea><small>可用变量：{{title}}、{{content}}、{{url}}、{{time}}；JSON 中的变量需置于双引号内。</small></label><label class="full">备注<input name="note" value="${escape(t.note)}"></label></div><div class="actions"><button class="primary" type="submit">保存通道</button><button type="button" data-action="test-target" data-id="${t.id}">测试已保存通道</button>${t.provider === 'generic' ? `<button type="button" class="danger" data-action="delete-target" data-id="${t.id}">删除通道</button>` : ''}</div><input type="hidden" name="provider" value="${t.provider}"></form>`,
    )
    .join('');
  return (
    heading('SETTINGS', '设置', '配置你的登录账号与 Webhook 提醒通道。') +
    `<div class="settings-stack"><section class="panel"><h2>登录账号</h2><form id="auth-settings"><div class="field-grid"><label>账号<input name="username" value="${escape(settings.auth.username)}" autocomplete="username" required></label><label>当前密码<input name="current_password" type="password" autocomplete="current-password" required></label><label>新密码<input name="password" type="password" autocomplete="new-password" minlength="12" placeholder="留空保持当前密码"></label><label>备注<input name="note" value="${escape(settings.auth.note)}"></label></div><div class="actions"><button class="primary" type="submit">保存账号设置</button><small>保存后所有登录会话失效，请重新登录。</small></div></form></section><section class="panel"><div class="panel-head"><h2>Webhook 通道</h2><button data-action="new-target">＋ 添加通道</button></div><p class="muted">${settings.serverchan_secrets_configured ? 'Server酱³ Worker secrets 已配置。' : 'Server酱³ 可在下方填写完整地址，也可通过 Worker secrets 配置。'} <a href="https://sc3.ft07.com/" target="_blank" rel="noopener noreferrer">获取 UID / SendKey ↗</a></p>${cards}</section></div>`
  );
}

function showDialog(title, content, footer = '') {
  $('#dialog-content').innerHTML =
    `<div class="dialog-head"><h2>${escape(title)}</h2><button class="text-button" data-action="close-dialog" aria-label="关闭">✕</button></div><div class="dialog-body">${content}</div>${footer ? `<div class="dialog-foot">${footer}</div>` : ''}`;
  if (!dialog.open) dialog.showModal();
}
function confirmAction(message, action) {
  return new Promise((resolve) => {
    showDialog(
      '确认操作',
      `<p>${escape(message)}</p>`,
      '<button id="confirm-cancel">取消</button><button class="primary" id="confirm-ok">' +
        escape(action) +
        '</button>',
    );
    const cancel = () => resolve(false);
    dialog.addEventListener('close', cancel, { once: true });
    $('#confirm-cancel').onclick = () => dialog.close();
    $('#confirm-ok').onclick = () => {
      dialog.removeEventListener('close', cancel);
      dialog.close();
      resolve(true);
    };
  });
}
async function editTask(taskId) {
  await metadata();
  const task = taskId
    ? await api('/api/tasks/' + taskId)
    : {
        title: '',
        message: '',
        url: '',
        cron_expression: '0 9 * * *',
        enabled: true,
        tags: [],
        group_id: state.groups.find((g) => g.name === '默认')?.id,
        webhook_id: state.targets.find((t) => t.provider === 'serverchan3')?.id,
      };
  showDialog(
    taskId ? '编辑任务' : '新建任务',
    `<form id="task-form" data-id="${taskId || ''}"><div class="field-grid"><label class="full">任务标题<input name="title" value="${escape(task.title)}" maxlength="200" required autofocus></label><label class="full">提醒内容<textarea name="message" maxlength="20000">${escape(task.message)}</textarea><small>在正文中使用 {{var_monthly_count}} 显示本月执行序号（包含本次）。</small></label><label class="full">相关链接<input name="url" value="${escape(task.url)}" placeholder="https://"></label><label>所属分组<select name="group_id">${state.groups.map((g) => `<option value="${g.id}" ${g.id === task.group_id ? 'selected' : ''}>${escape(g.name)}</option>`).join('')}</select></label><label>Webhook 通道<select name="webhook_id">${state.targets.map((t) => `<option value="${t.id}" ${t.id === task.webhook_id ? 'selected' : ''}>${escape(t.name)}</option>`).join('')}</select></label><label class="full">Cron 表达式<input name="cron_expression" value="${escape(task.cron_expression)}" maxlength="200" required><small>分钟 小时 日期 月份 星期 · ${escape(state.auth.timezone)} · 星期 0=周一，6=周日</small><button class="text-button" type="button" data-action="preview-cron">预览下次执行</button><div id="cron-preview" class="cron-preview" role="status"></div></label><label class="full">标签<input name="tags" value="${escape(task.tags.join(', '))}" placeholder="用逗号分隔"></label><label class="check-label full"><input type="checkbox" name="enabled" ${task.enabled ? 'checked' : ''}> 启用定时提醒</label></div><div class="help"><p><code>0 9 * * *</code> 每天 09:00</p><p><code>0 10,21 28 * *</code> 每月 28 日 10:00 和 21:00</p><p><code>0 9 * * mon-fri</code> 工作日 09:00</p><p>日期与星期同时匹配才执行，沿用旧应用的 APScheduler 规则。最小精度为分钟。</p></div></form>`,
    '<button data-action="close-dialog">取消</button><button class="primary" type="submit" form="task-form">保存任务</button>',
  );
}
function editGroup(groupId) {
  const g = state.groups.find((g) => g.id === groupId) || {
    name: '',
    icon: '📁',
    sort_order: state.groups.length,
  };
  showDialog(
    groupId ? '编辑分组' : '新建分组',
    `<form id="group-form" data-id="${groupId || ''}"><div class="field-grid"><label class="full">名称<input name="name" value="${escape(g.name)}" ${g.name === '默认' ? 'readonly' : ''} required maxlength="100"></label><label>图标 / Emoji<input name="icon" value="${escape(g.icon)}" maxlength="80"></label><label>排序<input type="number" name="sort_order" value="${g.sort_order}" required></label></div></form>`,
    '<button data-action="close-dialog">取消</button><button class="primary" form="group-form" type="submit">保存分组</button>',
  );
}
function newTarget() {
  showDialog(
    '添加 Webhook 通道',
    '<form id="target-form"><div class="field-grid"><label class="full">名称<input name="name" required maxlength="100"></label><label class="full">请求地址<input name="url" placeholder="https://example.com/webhook" required></label><label class="full">请求方式<select name="method"><option value="post_json">POST · JSON</option><option value="get">GET</option><option value="post_form">POST · 表单</option></select></label><label class="full">请求模板<textarea name="template">{"title":"{{title}}","content":"{{content}}","url":"{{url}}"}</textarea><small>GET / 表单模板示例：title={{title}}&amp;text={{content}}</small></label><label class="full">备注<input name="note"></label></div></form>',
    '<button data-action="close-dialog">取消</button><button class="primary" form="target-form" type="submit">添加通道</button>',
  );
}
async function showHistory(taskId, page = 1) {
  const data = await api('/api/tasks/' + taskId + '/history?page=' + page);
  showDialog(
    '执行历史 · ' + data.task.title,
    `<div class="history-list">${executionTable(data.history)}</div><div class="pagination"><span>共 ${data.total} 条记录 · 第 ${page} 页</span><div class="actions"><button data-action="history-page" data-id="${taskId}" data-value="${page - 1}" ${page <= 1 ? 'disabled' : ''}>上一页</button><button data-action="history-page" data-id="${taskId}" data-value="${page + 1}" ${page * 100 >= data.total ? 'disabled' : ''}>下一页</button></div></div>`,
    '<button data-action="close-dialog">关闭</button>',
  );
}
const handlers = {
  refresh: () => renderPage(),
  'close-dialog': () => dialog.close(),
  'new-task': () => editTask(),
  'edit-task': (b) => editTask(Number(b.dataset.id)),
  'new-group': () => editGroup(),
  'edit-group': (b) => editGroup(Number(b.dataset.id)),
  'new-target': () => newTarget(),
  history: (b) => showHistory(Number(b.dataset.id)),
  'history-page': (b) => showHistory(Number(b.dataset.id), Number(b.dataset.value)),
  'group-tasks': (b) => navigate('/tasks?group_id=' + b.dataset.id),
  'clear-filters': () => navigate('/tasks'),
  page: (b) => {
    const query = new URLSearchParams(location.search);
    query.set('page', b.dataset.value);
    return navigate('/tasks?' + query);
  },
  toggle: async (b) => {
    await api('/api/tasks/' + b.dataset.id + '/toggle', { method: 'POST' });
    await renderPage();
  },
  run: async (b) => {
    if (!(await confirmAction('立即执行此任务并发送一次 Webhook 提醒？', '立即执行'))) return;
    const result = await api('/api/tasks/' + b.dataset.id + '/run', { method: 'POST' });
    toast(result.status === 'success' ? '提醒发送成功' : '发送失败：' + result.error);
    await renderPage();
  },
  'delete-task': async (b) => {
    if (!(await confirmAction('删除此任务？执行历史将保留，定时提醒将停止。', '删除任务'))) return;
    await api('/api/tasks/' + b.dataset.id, { method: 'DELETE' });
    toast('任务已删除');
    await renderPage();
  },
  'delete-group': async (b) => {
    if (!(await confirmAction('删除此分组？分组内仍有任务时不能删除。', '删除分组'))) return;
    await api('/api/groups/' + b.dataset.id, { method: 'DELETE' });
    toast('分组已删除');
    await renderPage();
  },
  'delete-target': async (b) => {
    if (!(await confirmAction('删除此 Webhook 通道？仍被任务使用的通道不能删除。', '删除通道')))
      return;
    await api('/api/webhooks/' + b.dataset.id, { method: 'DELETE' });
    toast('通道已删除');
    await renderPage();
  },
  'test-target': async (b) => {
    await api('/api/webhooks/' + b.dataset.id + '/test', { method: 'POST' });
    toast('测试消息发送成功');
  },
  'preview-cron': async () => {
    const data = await api('/api/cron/preview', {
      method: 'POST',
      body: { expression: $('#task-form [name=cron_expression]').value },
    });
    $('#cron-preview').textContent = data.next.length
      ? '接下来：' + data.next.join(' · ')
      : '未来八年内无执行时刻';
  },
  batch: async (b) => {
    if (!state.selected.size) throw new Error('请先选择任务');
    const action = b.dataset.value;
    if (
      action === 'delete' &&
      !(await confirmAction(`删除所选 ${state.selected.size} 个任务？`, '批量删除'))
    )
      return;
    const data = await api('/api/tasks/batch', {
      method: 'POST',
      body: { action, ids: [...state.selected] },
    });
    state.selected.clear();
    toast(`已处理 ${data.count} 个任务`);
    await renderPage();
  },
  export: async () => {
    const data = await api('/api/tasks/export'),
      blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'taskly-export.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('任务已导出');
  },
  import: () =>
    showDialog(
      '导入任务',
      '<form id="import-form"><p class="muted">支持旧应用或 Taskly 导出的任务 JSON 数组。原邮件任务自动使用 Server酱³；每次最多 100 个任务，导入会创建新任务。</p><input class="file-input" type="file" name="file" accept=".json,application/json" required></form>',
      '<button data-action="close-dialog">取消</button><button class="primary" form="import-form" type="submit">导入</button>',
    ),
  month: async (b) => {
    const [y, m] = state.month.split('-').map(Number),
      d = new Date(Date.UTC(y, m - 1 + Number(b.dataset.value), 1));
    if (d.getUTCFullYear() < 2000 || d.getUTCFullYear() > 2100) return;
    state.month = d.toISOString().slice(0, 7);
    await renderPage();
  },
};
document.addEventListener('click', (event) => {
  const nav = event.target.closest('a[data-page]');
  if (nav && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    guarded(() => navigate(nav.getAttribute('href')));
    return;
  }
  const button = event.target.closest('[data-action]');
  if (button && handlers[button.dataset.action]) {
    event.preventDefault();
    guarded(() => handlers[button.dataset.action](button), button);
  }
});
document.addEventListener('change', (event) => {
  if (event.target.dataset.select) {
    const id = Number(event.target.dataset.select);
    event.target.checked ? state.selected.add(id) : state.selected.delete(id);
    $('#selected-count').textContent = `已选择 ${state.selected.size} 个`;
  }
  if (event.target.id === 'select-all') {
    document.querySelectorAll('[data-select]').forEach((el) => {
      el.checked = event.target.checked;
      el.checked
        ? state.selected.add(Number(el.dataset.select))
        : state.selected.delete(Number(el.dataset.select));
    });
    $('#selected-count').textContent = `已选择 ${state.selected.size} 个`;
  }
  if (event.target.id === 'calendar-month' && event.target.value) {
    state.month = event.target.value;
    guarded(renderPage);
  }
});
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (form.id === 'login-form') return;
  event.preventDefault();
  guarded(async () => {
    const data = Object.fromEntries(new FormData(form));
    if (form.id === 'filters') {
      const query = new URLSearchParams(Object.entries(data).filter(([, v]) => v));
      await navigate('/tasks?' + query);
      return;
    }
    if (form.id === 'task-form') {
      data.enabled = form.elements.enabled.checked;
      data.tags = data.tags
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter(Boolean);
      data.group_id = Number(data.group_id);
      data.webhook_id = Number(data.webhook_id);
      await api('/api/tasks' + (form.dataset.id ? '/' + form.dataset.id : ''), {
        method: form.dataset.id ? 'PUT' : 'POST',
        body: data,
      });
      toast('任务已保存');
    } else if (form.id === 'group-form') {
      data.sort_order = Number(data.sort_order);
      await api('/api/groups' + (form.dataset.id ? '/' + form.dataset.id : ''), {
        method: form.dataset.id ? 'PUT' : 'POST',
        body: data,
      });
      toast('分组已保存');
    } else if (form.id === 'target-form') {
      await api('/api/webhooks', { method: 'POST', body: data });
      toast('通道已添加');
    } else if (form.dataset.targetForm) {
      await api('/api/webhooks/' + form.dataset.targetForm, { method: 'PUT', body: data });
      toast('通道已保存');
    } else if (form.id === 'auth-settings') {
      await api('/api/settings/auth', { method: 'PUT', body: data });
      showLogin();
      toast('账号设置已保存，请重新登录');
      return;
    } else if (form.id === 'import-form') {
      const file = form.elements.file.files[0];
      if (file.size > 2000000) throw new Error('文件超过 2 MB');
      let tasks;
      try {
        tasks = JSON.parse(await file.text());
      } catch {
        throw new Error('文件不是合法 JSON');
      }
      const result = await api('/api/tasks/import', { method: 'POST', body: tasks });
      toast(`已导入 ${result.count} 个任务`);
    } else return;
    if (dialog.open) dialog.close();
    await renderPage();
  }, event.submitter);
});
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target,
    button = form.querySelector('button');
  button.disabled = true;
  $('#login-error').textContent = '';
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: Object.fromEntries(new FormData(form)),
    });
    form.elements.password.value = '';
    await signedIn(data);
  } catch (e) {
    $('#login-error').textContent = e.message;
  } finally {
    button.disabled = false;
  }
});
$('#logout').addEventListener('click', () =>
  guarded(async () => {
    await api('/api/logout', { method: 'POST' });
    showLogin();
  }),
);
$('#mobile-menu').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
window.addEventListener('popstate', () => guarded(renderPage));
async function signedIn(auth) {
  state.auth = auth;
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  $('#username').textContent = auth.username;
  $('#timezone-label').textContent = auth.timezone;
  $('#footer-timezone').textContent = auth.timezone;
  await renderPage();
}
(async () => {
  try {
    await signedIn(await api('/api/session'));
  } catch {
    showLogin();
  }
})();
