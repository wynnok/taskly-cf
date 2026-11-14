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
  chartData: null,
  calendarEntries: [],
};
const charts = [];
const icon = (name, extra = '') =>
  `<i class="ph ph-${escape(name)} ${escape(extra)}" aria-hidden="true"></i>`;
const actionButton = (action, label, name, extra = '') =>
  `<button class="${extra}" data-action="${action}">${icon(name)} ${label}</button>`;
const groupIcons = [
  ['folder', '文件夹'],
  ['briefcase', '公文包'],
  ['calendar', '日历'],
  ['bell', '提醒铃'],
  ['check-square', '清单'],
  ['chart-bar', '图表'],
  ['gear', '齿轮'],
  ['globe', '地球'],
  ['tag', '标签'],
];
function groupIcon(value, extra = '') {
  const aliases = {
    '📁': 'folder',
    '📂': 'folder-open',
    '💼': 'briefcase',
    '🔔': 'bell',
    '📅': 'calendar',
    '🏷️': 'tag',
  };
  const name = String(aliases[value] || value || 'folder').replace(/^ph(?:\s+ph)?-/, '');
  return /^[a-z]+(?:-[a-z0-9]+)*$/.test(name)
    ? icon(name, extra)
    : `<span class="group-emoji ${escape(extra)}" aria-hidden="true">${escape(value || '📁')}</span>`;
}
function closeMenu() {
  $('#mobile-nav').classList.remove('active');
  $('#mobile-menu').classList.remove('active');
  $('#mobile-menu').setAttribute('aria-expanded', 'false');
}
function disposeCharts() {
  for (const chart of charts.splice(0)) chart.dispose();
}
function setSidebarCollapsed(collapsed) {
  document.documentElement.classList.toggle('sidebar-collapsed', collapsed);
  const button = $('#sidebar-toggle'),
    label = collapsed ? '展开侧栏' : '收起侧栏';
  button.setAttribute('aria-expanded', String(!collapsed));
  button.setAttribute('aria-label', label);
  button.title = label;
}
try {
  setSidebarCollapsed(localStorage.getItem('taskly.sidebarCollapsed') === 'true');
} catch {
  setSidebarCollapsed(false);
}
document.querySelectorAll('.sidebar-nav a, .sidebar-brand').forEach((link) => {
  link.title = link.textContent.trim();
});
const main = $('#main'),
  dialog = $('#dialog'),
  pageLoadingMarkup = $('#page-loading-template').innerHTML;
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
/* ---------- Select menus ----------
   The popup a <select> opens is drawn by the OS and cannot follow the page, so
   each select keeps its value and its form behaviour while a listbox we own
   draws the menu. The native control stays in the DOM for FormData and
   validation; the button carries the name and the current value. */
let openSelectState = null;
let selectSequence = 0;

function closeSelectOnScroll() {
  closeSelectMenu(false);
}

function closeSelectMenu(restoreFocus = false) {
  if (!openSelectState) return;
  const state = openSelectState;
  openSelectState = null;
  if (state.menu) {
    state.menu.remove();
    state.menu = null;
  }
  state.button.setAttribute('aria-expanded', 'false');
  state.button.removeAttribute('aria-activedescendant');
  window.removeEventListener('scroll', closeSelectOnScroll, true);
  window.removeEventListener('resize', closeSelectOnScroll);
  if (restoreFocus) state.button.focus();
}

function selectLabel(state) {
  const option = state.select.selectedOptions[0];
  const text = option ? option.textContent.trim() : '';
  state.value.textContent = text;
  state.button.setAttribute('aria-label', state.name ? state.name + '：' + text : text);
}

function markActiveOption(state, option) {
  for (const item of state.menu.querySelectorAll('.is-active')) item.classList.remove('is-active');
  option.classList.add('is-active');
  state.menu.setAttribute('aria-activedescendant', option.id);
  option.scrollIntoView({ block: 'nearest' });
}

function chooseSelectOption(state, option) {
  const index = [...state.menu.children].indexOf(option);
  closeSelectMenu(true);
  if (index < 0 || state.select.selectedIndex === index) return;
  state.select.selectedIndex = index;
  selectLabel(state);
  state.select.dispatchEvent(new Event('change', { bubbles: true }));
}

function buildSelectMenu(state) {
  const menu = document.createElement('div');
  menu.className = 'select__menu';
  menu.id = state.menuId;
  menu.tabIndex = -1;
  menu.setAttribute('role', 'listbox');
  [...state.select.options].forEach((option, index) => {
    const item = document.createElement('div');
    item.className = 'select__option';
    item.id = state.menuId + '-' + index;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(index === state.select.selectedIndex));
    item.dataset.value = option.value;
    item.innerHTML = `${icon('check')}<span>${escape(option.textContent)}</span>`;
    menu.append(item);
  });
  return menu;
}

function placeSelectMenu(state) {
  const anchor = state.button.getBoundingClientRect();
  const menu = state.menu;
  const height = menu.offsetHeight;
  const below = window.innerHeight - anchor.bottom;
  const openUp = below < height + 12 && anchor.top > height + 12;
  menu.style.minWidth = Math.round(anchor.width) + 'px';
  menu.style.left = Math.round(anchor.left) + 'px';
  menu.style.top = Math.round(openUp ? anchor.top - height - 6 : anchor.bottom + 6) + 'px';
}

function openSelectMenu(state) {
  closeSelectMenu(false);
  const host = state.select.closest('dialog') || document.body;
  state.menu = buildSelectMenu(state);
  host.append(state.menu);
  state.button.setAttribute('aria-expanded', 'true');
  openSelectState = state;
  placeSelectMenu(state);
  const selected =
    state.menu.querySelector('[aria-selected="true"]') || state.menu.firstElementChild;
  if (selected) markActiveOption(state, selected);
  state.menu.focus({ preventScroll: true });
  window.addEventListener('scroll', closeSelectOnScroll, true);
  window.addEventListener('resize', closeSelectOnScroll);
  state.menu.addEventListener('click', (event) => {
    const option = event.target.closest('.select__option');
    if (option) chooseSelectOption(state, option);
  });
  state.menu.addEventListener('pointermove', (event) => {
    const option = event.target.closest('.select__option');
    if (option && !option.classList.contains('is-active')) markActiveOption(state, option);
  });
  state.menu.addEventListener('keydown', (event) => {
    const items = [...state.menu.children];
    const current = state.menu.querySelector('.is-active');
    const index = items.indexOf(current);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next =
        event.key === 'ArrowDown' ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1);
      markActiveOption(state, items[next]);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      markActiveOption(state, event.key === 'Home' ? items[0] : items[items.length - 1]);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (current) chooseSelectOption(state, current);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeSelectMenu(true);
    } else if (event.key === 'Tab') {
      closeSelectMenu(false);
    }
  });
}

function enhanceSelect(select) {
  if (select.dataset.selectEnhanced) return;
  select.dataset.selectEnhanced = '1';
  const label = select.closest('label');
  const name = (
    select.getAttribute('aria-label') ||
    (label && label.querySelector(':scope > span')?.textContent) ||
    ''
  ).trim();
  const id = 'select-' + ++selectSequence;
  const wrapper = document.createElement('span');
  wrapper.className = 'select';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'select__button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  const value = document.createElement('span');
  value.className = 'select__value';
  button.append(value);
  button.insertAdjacentHTML('beforeend', icon('caret-down', 'select__chevron'));
  select.parentNode.insertBefore(wrapper, select);
  wrapper.append(select, button);
  select.classList.add('select__native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  const state = { select, button, value, menu: null, menuId: id + '-menu', name };
  selectLabel(state);
  select.addEventListener('focus', () => button.focus());
  button.addEventListener('click', () => {
    if (openSelectState === state) closeSelectMenu(true);
    else openSelectMenu(state);
  });
  button.addEventListener('keydown', (event) => {
    if (
      event.key === 'ArrowDown' ||
      event.key === 'ArrowUp' ||
      event.key === 'Enter' ||
      event.key === ' '
    ) {
      event.preventDefault();
      openSelectMenu(state);
    }
  });
}

function enhanceSelects(root) {
  if (root) root.querySelectorAll('select:not([data-select-enhanced])').forEach(enhanceSelect);
}

document.addEventListener('pointerdown', (event) => {
  if (!openSelectState) return;
  if (event.target.closest('.select__menu, .select__button')) return;
  closeSelectMenu(false);
});

function showLogin() {
  state.auth = null;
  disposeCharts();
  closeMenu();
  document.title = '登录 - 任务提醒';
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  $('#login-form [name=password]').type = 'password';
  $('#password-toggle').setAttribute('aria-label', '显示密码');
  $('#password-toggle').setAttribute('aria-pressed', 'false');
  $('#password-toggle').innerHTML = icon('eye');
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
  return `<section class="page-toolbar"><div><h1 class="page-title">${title}</h1><p class="page-subtitle">${subtitle}</p></div><div class="page-toolbar-actions">${actions}</div></section>`;
}
const badge = (status) =>
  `<span class="status-badge ${status === 'failed' ? 'danger' : status ? 'ok' : 'muted'}">${status ? icon(status === 'success' ? 'check-circle' : 'x-circle') : ''}${status === 'success' ? '成功' : status === 'failed' ? '失败' : '未执行'}</span>`;
const taskActions = (id) =>
  `<div class="row-actions">${[
    ['edit-task', '编辑任务', 'pencil-simple', ''],
    ['history', '执行历史', 'clock-counter-clockwise', ''],
    ['run', '立即执行', 'play', 'run'],
    ['delete-task', '删除任务', 'trash', 'danger'],
  ]
    .map(
      ([action, label, name, extra]) =>
        `<button class="row-action ${extra}" data-action="${action}" data-id="${id}" title="${label}" aria-label="${label}">${icon(name)}</button>`,
    )
    .join('')}</div>`;
async function metadata() {
  const [groups, settings] = await Promise.all([api('/api/groups'), api('/api/settings')]);
  state.groups = groups;
  state.targets = settings.targets;
  return settings;
}
function targetNotice(settings) {
  const defaultTarget = state.targets.find((t) => t.provider === 'serverchan3');
  return defaultTarget && !defaultTarget.url && !settings.serverchan_secrets_configured
    ? '<div class="notice warn"><i class="ph ph-warning-circle" aria-hidden="true"></i><span>Server酱³ 尚未配置推送地址。请到 <a href="/settings" data-page="settings">设置</a> 填写地址，或配置 Worker 的 UID / SendKey secrets。</span></div>'
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
  main.dataset.page = page;
  document.querySelectorAll('nav [data-page]').forEach((a) => {
    const active = a.dataset.page === page;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.title =
    {
      dashboard: '仪表盘',
      tasks: '任务管理',
      calendar: '日历',
      groups: '分组管理',
      monitoring: '运行监控',
      settings: '设置',
    }[page] + ' - 任务提醒';
  closeSelectMenu(false);
  disposeCharts();
  main.classList.add('is-loading');
  main.innerHTML = pageLoadingMarkup;
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
    enhanceSelects(main);
    if (page === 'dashboard') renderCharts();
  } catch (e) {
    if (version === renderVersion && state.auth)
      main.innerHTML = `<div class="notice warn">${escape(e.message)}</div><button data-action="refresh">重试</button>`;
  } finally {
    if (version === renderVersion) main.classList.remove('is-loading');
  }
}
async function navigate(path) {
  history.pushState({}, '', path);
  state.selected.clear();
  closeMenu();
  await renderPage();
}

async function dashboard() {
  const [stats, taskData, settings, failedData] = await Promise.all([
    api('/api/statistics'),
    api('/api/tasks'),
    metadata(),
    api('/api/tasks?last_status=failed'),
  ]);
  const days = Array.from({ length: 14 }, (_, i) => {
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: state.auth.timezone }).format(
      new Date(Date.now() - (13 - i) * 86400000),
    );
    return { date: day, success: 0, failed: 0, ...stats.daily.find((d) => d.day === day) };
  });
  state.chartData = {
    daily: days,
    groups: state.groups.map((g) => ({ name: g.name, value: g.task_count })),
  };
  const success = days.slice(-7).reduce((n, d) => n + d.success, 0);
  const failed = days.slice(-7).reduce((n, d) => n + d.failed, 0);
  const executions = success + failed;
  const failedTasks = failedData.total;
  const running = Number(stats.scheduler.last_completed_epoch) > Date.now() - 600000;
  const stat = (label, value, detail) =>
    `<article class="stat"><span class="stat-label">${label}</span><strong class="stat-value">${value}</strong><p class="stat-extra">${detail}</p></article>`;
  const recent = taskData.tasks
    .slice(0, 6)
    .map(
      (t) =>
        `<tr><td><a href="/tasks" data-page="tasks" class="row-title">${escape(t.title)}</a></td><td><span class="group-badge small">${groupIcon(state.groups.find((g) => g.id === t.group_id)?.icon)} ${escape(t.group_name)}</span></td><td><code class="cron-pill">${escape(t.cron_expression)}</code></td><td class="cell-muted">${datetime(t.next_run)}</td><td>${badge(t.last_status)}</td></tr>`,
    )
    .join('');
  return (
    heading(
      'OVERVIEW',
      '仪表盘',
      '任务与调度的整体运行情况一览。',
      `<a class="scheduler-pill ${running ? 'on' : 'off'}" href="/monitoring" data-page="monitoring">${icon(running ? 'waveform' : 'pause-circle')} ${running ? '调度运行中' : '等待调度'}</a><a class="btn-link" href="/tasks" data-page="tasks">${icon('list-dashes')} 管理任务</a>`,
    ) +
    targetNotice(settings) +
    `<section class="stat-strip">${stat('任务总数', stats.tasks.total, `已启用 ${stats.tasks.enabled}，停用 ${stats.tasks.total - stats.tasks.enabled}`)}${stat('近 7 日执行', executions, `今日 ${days.at(-1).success + days.at(-1).failed} 次，日均 ${(executions / 7).toFixed(1)} 次`)}${stat('近 7 日成功率', executions ? Math.round((success / executions) * 100) + '%' : '暂无', `成功 ${success}，失败 ${failed}`)}${stat('需要关注', failedTasks, failedTasks ? '<a class="attention-link" href="/tasks?last_status=failed" data-page="tasks">最近失败任务，建议优先排查</a>' : '没有失败任务')}</section>
    <section class="chart-grid"><article class="panel chart-card chart-main"><div class="panel-header"><h2>执行趋势</h2><span class="panel-badge">近 14 天</span></div><div class="chart-body" id="chart-trend" role="img" aria-label="近十四天成功和失败执行趋势"></div></article><article class="panel chart-card chart-groups"><div class="panel-header"><h2>分组任务量</h2></div><div class="chart-body" id="chart-groups" role="img" aria-label="各分组的任务数量"></div></article></section>
    <section class="panel"><div class="panel-header panel-header-stack"><div><h2>最近任务</h2><p class="panel-description">最近添加的任务及其执行与调度情况。</p></div><a class="btn-link" href="/tasks" data-page="tasks">查看全部</a></div><div class="table-wrap"><table class="data-table"><thead><tr><th>任务</th><th>分组</th><th>计划</th><th>下次执行</th><th>最近结果</th></tr></thead><tbody>${recent || '<tr><td colspan="5" class="empty">还没有任务，去创建第一个提醒吧。</td></tr>'}</tbody></table></div></section>`
  );
}
function renderCharts() {
  const data = state.chartData;
  if (!data || !window.echarts) return;
  // Read the palette from the stylesheet so the charts cannot drift from the page.
  const style = getComputedStyle(document.documentElement);
  const swatch = document.createElement('canvas').getContext('2d');
  const token = (name, fallback) => {
    swatch.fillStyle = fallback;
    swatch.fillStyle = style.getPropertyValue(name).trim() || fallback;
    return swatch.fillStyle;
  };
  const palette = {
    accent: token('--chart-accent', '#0b66d6'),
    success: token('--chart-success', '#2e9052'),
    danger: token('--chart-danger', '#c92f33'),
    grid: token('--chart-grid', '#e1e3e6'),
    label: token('--chart-label', '#6a6d74'),
    tooltip: token('--chart-tooltip-bg', '#181b20'),
    tooltipInk: token('--chart-tooltip-ink', '#f6f7fa'),
  };
  const baseTooltip = {
    trigger: 'axis',
    backgroundColor: palette.tooltip,
    borderWidth: 0,
    padding: [8, 12],
    extraCssText: 'border-radius:8px;box-shadow:none;',
    textStyle: { color: palette.tooltipInk, fontSize: 12 },
  };

  function makeChart(id, option) {
    const element = document.getElementById(id);
    if (!element) return null;
    const chart = echarts.init(element);
    chart.setOption(option);
    charts.push(chart);
    return chart;
  }

  const days = data.daily.map((item) => item.date.slice(5));
  makeChart('chart-trend', {
    color: [palette.success, palette.danger],
    textStyle: { fontFamily: getComputedStyle(document.body).fontFamily },
    tooltip: Object.assign({}, baseTooltip, {
      axisPointer: { type: 'line', lineStyle: { color: palette.grid, width: 1 } },
    }),
    legend: {
      top: 0,
      right: 0,
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 16,
      icon: 'circle',
      textStyle: { color: palette.label, fontSize: 12 },
    },
    grid: { left: 4, right: 16, top: 34, bottom: 0, containLabel: true },
    xAxis: {
      type: 'category',
      data: days,
      boundaryGap: false,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: palette.label, fontSize: 11, margin: 12 },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: palette.grid, width: 1 } },
      axisLabel: { color: palette.label, fontSize: 11, margin: 10 },
    },
    series: [
      {
        name: '成功',
        type: 'line',
        smooth: 0.25,
        showSymbol: false,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { width: 1.6 },
        areaStyle: { opacity: 0.06 },
        data: data.daily.map((item) => item.success),
      },
      {
        name: '失败',
        type: 'line',
        smooth: 0.25,
        showSymbol: false,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { width: 1.6 },
        data: data.daily.map((item) => item.failed),
      },
    ],
  });

  const groups = data.groups.slice().reverse();
  makeChart('chart-groups', {
    color: [palette.accent],
    textStyle: { fontFamily: getComputedStyle(document.body).fontFamily },
    tooltip: Object.assign({}, baseTooltip, { axisPointer: { type: 'shadow' } }),
    grid: { left: 4, right: 26, top: 4, bottom: 0, containLabel: true },
    xAxis: {
      type: 'value',
      minInterval: 1,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: palette.grid, width: 1 } },
      axisLabel: { color: palette.label, fontSize: 11 },
    },
    yAxis: {
      type: 'category',
      data: groups.map((item) => item.name),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: palette.label, fontSize: 12, width: 72, overflow: 'truncate' },
    },
    series: [
      {
        type: 'bar',
        barWidth: 8,
        itemStyle: { borderRadius: [0, 4, 4, 0], color: palette.accent },
        label: { show: true, position: 'right', color: palette.label, fontSize: 11 },
        data: groups.map((item) => item.value),
      },
    ],
  });
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
        `<tr><td class="checkbox-cell"><input type="checkbox" aria-label="选择 ${escape(t.title)}" data-select="${t.id}" ${state.selected.has(t.id) ? 'checked' : ''}></td><td><div class="row-title-cell"><span class="row-title">${escape(t.title)}</span>${t.tags.length ? `<span class="row-tags">${t.tags.map((tag) => `<span class="tag">${escape(tag)}</span>`).join('')}</span>` : ''}<small class="task-message">${escape(t.message)}</small></div></td><td><span class="badge neutral">${escape(t.group_name)}</span><small>${escape(t.webhook_name)}</small></td><td><div class="row-plan-cell"><code class="cron-pill">${escape(t.cron_expression)}</code><small>${datetime(t.next_run)}</small></div></td><td class="switch-cell"><button class="task-switch ${t.enabled ? 'on' : ''}" role="switch" aria-checked="${t.enabled}" aria-label="启停 ${escape(t.title)}" data-action="toggle" data-id="${t.id}"></button></td><td>${badge(t.last_status)}<small>${escape(t.last_run_at || '未执行')}</small></td><td class="actions-cell">${taskActions(t.id)}</td></tr>`,
    )
    .join('');
  return (
    heading(
      'TASKS',
      '任务管理',
      `共 ${data.total} 个任务，所有提醒均通过 Webhook 发送`,
      `${actionButton('export', '导出', 'download-simple', 'btn-link')}${actionButton('import', '导入', 'upload-simple', 'btn-link')}${actionButton('new-task', '新建任务', 'plus', 'primary')}`,
    ) +
    targetNotice(settings) +
    `<section class="panel data-panel"><form id="filters" class="filter-bar"><input type="search" name="q" placeholder="搜索标题或内容…" aria-label="搜索任务" value="${escape(query.get('q') || '')}"><select name="group_id" aria-label="筛选分组">${option('', '全部分组', query.get('group_id'))}${state.groups.map((g) => option(g.id, g.name, query.get('group_id'))).join('')}</select><select name="enabled" aria-label="筛选启用状态">${option('', '全部状态', query.get('enabled'))}${option('1', '已启用', query.get('enabled'))}${option('0', '已停用', query.get('enabled'))}</select><select name="last_status" aria-label="筛选执行结果">${option('', '全部结果', query.get('last_status'))}${option('success', '最近成功', query.get('last_status'))}${option('failed', '最近失败', query.get('last_status'))}</select><input type="text" name="tag" placeholder="标签" aria-label="筛选标签" class="tag-filter" value="${escape(query.get('tag') || '')}"><div class="filter-actions"><button class="btn" type="submit">${icon('magnifying-glass')} 查询</button><button class="btn-link" type="button" data-action="clear-filters">${icon('arrow-counter-clockwise')} 重置</button></div></form>
    <div class="actions batch-toolbar"><small id="selected-count">已选择 ${state.selected.size} 个</small><button data-action="batch" data-value="enable" ${state.selected.size ? '' : 'disabled'}>批量启用</button><button data-action="batch" data-value="disable" ${state.selected.size ? '' : 'disabled'}>批量停用</button><button class="danger" data-action="batch" data-value="delete" ${state.selected.size ? '' : 'disabled'}>批量删除</button></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th class="checkbox-cell"><input type="checkbox" id="select-all" aria-label="选择当前页所有任务"></th><th>任务</th><th>分组 / 通道</th><th>计划 / 下次执行</th><th>启用</th><th>最近结果</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="empty">没有找到任务。</td></tr>'}</tbody></table></div><div class="pagination"><span>共 ${data.total} 个任务，第 ${data.page} / ${data.pages} 页</span><div class="actions"><button data-action="page" data-value="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''}>上一页</button><button data-action="page" data-value="${data.page + 1}" ${data.page >= data.pages ? 'disabled' : ''}>下一页</button></div></div></section>`
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
  state.calendarEntries = data.entries;
  const eventButton = (e, className = 'calendar-event') =>
    `<button class="${className}" data-action="edit-task" data-id="${e.task_id}" title="${escape(e.when + ' ' + e.title)}"><span class="calendar-event-time">${e.when.slice(11, 16)}</span><span class="calendar-event-title">${escape(e.title)}</span></button>`;
  const cells = Array.from({ length: Math.ceil((first + days) / 7) * 7 }, (_, i) => {
    const day = i - first + 1;
    if (day < 1 || day > days) return '<div class="calendar-cell empty"></div>';
    const date = state.month + '-' + String(day).padStart(2, '0');
    const events = data.entries.filter((e) => e.when.startsWith(date));
    return `<div class="calendar-cell ${today === date ? 'today' : ''} ${i % 7 >= 5 ? 'weekend' : ''}"><span class="calendar-day-num">${day}</span><div class="calendar-events">${events
      .slice(0, 3)
      .map((e) => eventButton(e))
      .join(
        '',
      )}</div>${events.length > 3 ? `<button class="calendar-more" data-action="calendar-more" data-date="${date}" aria-label="查看 ${date} 的全部 ${events.length} 个提醒">+${events.length - 3} 更多</button>` : ''}</div>`;
  }).join('');
  const timeline = Object.entries(
    data.entries.reduce((acc, entry) => {
      const day = entry.when.slice(0, 10);
      (acc[day] ||= []).push(entry);
      return acc;
    }, {}),
  )
    .map(
      ([day, entries]) =>
        `<div class="calendar-day-group"><p class="calendar-day-head${day === today ? ' today' : ''}">${day.slice(5)}${day === today ? ' 今天' : ''}</p>${entries
          .map(
            (entry) =>
              `<button class="calendar-timeline-task" data-action="edit-task" data-id="${entry.task_id}"><time datetime="${entry.when}">${entry.when.slice(11, 16)}</time><span>${escape(entry.title)}</span></button>`,
          )
          .join('')}</div>`,
    )
    .join('');
  return (
    heading(
      'CALENDAR',
      '日历',
      '查看启用任务的未来提醒计划。',
      `<button class="btn-link" data-action="month" data-value="-1" aria-label="上个月">${icon('caret-left')} 上月</button><input class="month-input" type="month" id="calendar-month" min="2000-01" max="2100-12" aria-label="选择月份" value="${state.month}"><button class="btn-link" data-action="month" data-value="1" aria-label="下个月">下月 ${icon('caret-right')}</button>`,
    ) +
    (data.overflow
      ? '<div class="notice warn">当前月份展示前 600 个提醒。可按任务的 Cron 表达式确认完整计划。</div>'
      : '') +
    `<section class="panel calendar-panel"><div class="panel-header"><h2>触发计划</h2><span class="panel-badge">${data.entries.length} 个触发点</span></div><div class="calendar-grid-wrap"><div class="calendar-weekdays">${['一', '二', '三', '四', '五', '六', '日'].map((d, i) => `<span class="${i >= 5 ? 'weekend' : ''}">${d}</span>`).join('')}</div><div class="calendar-grid">${cells}</div></div><div class="calendar-timeline">${timeline || '<p class="help-text">本月没有待触发的任务。</p>'}</div></section>`
  );
}

async function groupsPage() {
  await metadata();
  return (
    heading(
      'GROUPS',
      '分组管理',
      `共 ${state.groups.length} 个分组，序号决定展示顺序；分组下仍有任务时无法删除。`,
      actionButton('new-group', '新建分组', 'plus', 'primary'),
    ) +
    `<section class="panel data-panel"><div class="filter-bar"><input type="search" id="group-keyword" placeholder="按名称筛选分组" aria-label="按名称筛选分组"></div><div class="table-wrap"><table class="data-table"><thead><tr><th>分组</th><th class="hide-sm">序号</th><th>任务数</th><th class="actions-cell">操作</th></tr></thead><tbody>${state.groups.map((g) => `<tr data-group-name="${escape(g.name)}"><td><div class="row-title-cell"><strong class="row-title">${groupIcon(g.icon, 'row-title-icon')}${escape(g.name)}</strong></div></td><td class="hide-sm cell-muted">${g.sort_order}</td><td><button class="count-link" data-action="group-tasks" data-id="${g.id}">${g.task_count} 个任务</button></td><td class="actions-cell"><button class="row-action" data-action="edit-group" data-id="${g.id}" title="编辑分组" aria-label="编辑分组 ${escape(g.name)}">${icon('pencil-simple')}</button>${g.name === '默认' ? '' : `<button class="row-action danger" data-action="delete-group" data-id="${g.id}" title="删除分组" aria-label="删除分组 ${escape(g.name)}">${icon('trash')}</button>`}</td></tr>`).join('')}</tbody></table></div></section>`
  );
}
function executionTable(history) {
  return `<div class="table-wrap"><table><thead><tr><th>执行时间</th><th>任务</th><th>结果</th><th>来源 / 详情</th></tr></thead><tbody>${history.map((h) => `<tr><td>${escape(h.executed_at)}</td><td>${escape(h.title || '')}</td><td>${badge(h.status)}</td><td><small>${h.source === 'manual' ? '手动执行' : '定时执行'}</small>${h.error ? `<div class="history-error">${escape(h.error)}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">暂无执行记录</td></tr>'}</tbody></table></div>`;
}
async function monitoringPage() {
  const stats = await api('/api/statistics?days=30');
  const scan = stats.scheduler.last_completed,
    neverRan = !stats.scheduler.last_completed_epoch,
    stale = !neverRan && Number(stats.scheduler.last_completed_epoch) < Date.now() - 600000;
  return (
    heading(
      'MONITORING',
      '运行监控',
      '跟踪每一次提醒，以及任务调度的运行状态。',
      '<button data-action="refresh">刷新</button>',
    ) +
    `<div class="monitor-grid"><div class="stat-card"><div class="label">上次调度完成</div><div class="number">${escape(scan || '尚无记录')}</div><div class="detail">${neverRan ? '请检查 Cloudflare Cron 是否启用；手动执行不能验证自动调度' : stale ? '超过 10 分钟，请检查 Cloudflare Cron' : '每分钟扫描一次到期任务'}</div></div><div class="stat-card"><div class="label">近 30 天执行</div><div class="number">${stats.executions.total} 次</div><div class="detail">成功 ${stats.executions.success}，失败 ${stats.executions.failed}</div></div><div class="stat-card"><div class="label">执行中的任务</div><div class="number">${stats.pending_claims}</div><div class="detail">异常中断将在 20 分钟后记录失败</div></div></div><div class="notice">提醒按分钟触发。调度延迟时补扫最近 5 分钟；投递失败记录原因，可在任务页手动重试。</div><section class="panel"><h2>最近执行记录</h2>${executionTable(stats.recent)}</section>`
  );
}
async function settingsPage() {
  const settings = await metadata();
  const cards = settings.targets
    .map(
      (t) =>
        `<form class="webhook-card" data-target-form="${t.id}"><div class="panel-head"><h3>${escape(t.name)}</h3><span class="badge neutral">${t.provider === 'serverchan3' ? '默认通道' : '自定义 Webhook'}</span></div><div class="field-grid"><label><span>通道名称</span><input name="name" value="${escape(t.name)}" ${t.provider === 'serverchan3' ? 'readonly' : ''} required></label><label><span>请求方式</span><select name="method">${[
          ['get', 'GET'],
          ['post_json', 'POST (JSON)'],
          ['post_form', 'POST (表单)'],
        ]
          .map(([v, n]) => `<option value="${v}" ${v === t.method ? 'selected' : ''}>${n}</option>`)
          .join(
            '',
          )}</select></label><label class="full">${t.provider === 'serverchan3' ? 'Server酱³ 推送地址' : '请求地址'}<input name="url" value="${escape(t.url)}" placeholder="${t.provider === 'serverchan3' ? 'https://UID.push.ft07.com/send/SENDKEY.send' : 'https://example.com/webhook'}" autocomplete="off"><small>${t.provider === 'serverchan3' ? '留空时使用 Worker secrets：SERVERCHAN_UID / SERVERCHAN_SENDKEY。' : 'GET 地址可使用占位符。'}</small></label><label class="full"><span>请求模板</span><textarea name="template" spellcheck="false">${escape(t.template)}</textarea><small>可用变量：{{title}}、{{content}}、{{url}}、{{time}}；JSON 中的变量需置于双引号内。</small></label><label class="full"><span>备注</span><input name="note" value="${escape(t.note)}"></label></div><div class="actions"><button type="submit">${icon('floppy-disk')} 保存通道</button><button type="button" data-action="test-target" data-id="${t.id}">${icon('plugs-connected')} 测试已保存通道</button>${t.provider === 'generic' ? `<button type="button" class="danger" data-action="delete-target" data-id="${t.id}">${icon('trash')} 删除通道</button>` : ''}</div><input type="hidden" name="provider" value="${t.provider}"></form>`,
    )
    .join('');
  return (
    heading('SETTINGS', '发送配置', '统一维护登录和 Webhook 配置。') +
    targetNotice(settings) +
    `<div class="settings-stack"><section class="panel"><div class="panel-header"><h2>账号设置</h2></div><form id="auth-settings"><div class="field-grid"><label><span>账号</span><input name="username" value="${escape(settings.auth.username)}" autocomplete="username" required></label><label><span>当前密码</span><div class="password-field"><input name="current_password" type="password" autocomplete="current-password" placeholder="请输入当前密码" required><button type="button" class="password-toggle" aria-label="显示密码" aria-pressed="false">${icon('eye')}</button></div></label><label><span>新密码</span><div class="password-field"><input name="password" type="password" autocomplete="new-password" minlength="12" placeholder="留空保持当前密码"><button type="button" class="password-toggle" aria-label="显示密码" aria-pressed="false">${icon('eye')}</button></div></label><label><span>备注</span><input name="note" value="${escape(settings.auth.note)}"></label></div><div class="actions"><button class="primary" type="submit">${icon('floppy-disk')} 保存账号设置</button><small>保存后所有登录会话失效，请重新登录。</small></div></form></section><section class="panel"><div class="panel-head"><h2>推送通道</h2><button data-action="new-target">${icon('plus')} 添加通道</button></div><p class="muted">${settings.serverchan_secrets_configured ? 'Server酱³ Worker secrets 已配置。' : 'Server酱³ 可在下方填写完整地址，也可通过 Worker secrets 配置。'} <a href="https://sc3.ft07.com/" target="_blank" rel="noopener noreferrer">获取 UID 与 SendKey</a></p>${cards}</section></div>`
  );
}

function showDialog(title, content, footer = '') {
  $('#dialog-content').innerHTML =
    `<div class="dialog-head"><h2 id="dialog-title">${escape(title)}</h2><button class="row-action" data-action="close-dialog" aria-label="关闭">${icon('x')}</button></div><div class="dialog-body">${content}</div>${footer ? `<div class="dialog-foot">${footer}</div>` : ''}`;
  enhanceSelects($('#dialog-content'));
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
    `<form id="task-form" data-id="${taskId || ''}"><div class="field-grid"><label class="full"><span>任务标题</span><input name="title" value="${escape(task.title)}" maxlength="200" required placeholder="例如：月末账单提醒" autofocus></label><label class="full"><span>提醒内容</span><textarea name="message" maxlength="20000">${escape(task.message)}</textarea><small>在正文中使用 {{var_monthly_count}} 显示本月执行序号（包含本次）。</small></label><label class="full"><span>相关链接</span><input name="url" value="${escape(task.url)}" placeholder="https://"></label><label><span>所属分组</span><select name="group_id">${state.groups.map((g) => `<option value="${g.id}" ${g.id === task.group_id ? 'selected' : ''}>${escape(g.name)}</option>`).join('')}</select></label><label><span>Webhook 通道</span><select name="webhook_id">${state.targets.map((t) => `<option value="${t.id}" ${t.id === task.webhook_id ? 'selected' : ''}>${escape(t.name)}</option>`).join('')}</select></label><label class="full"><span>Cron 表达式</span><input name="cron_expression" value="${escape(task.cron_expression)}" maxlength="200" required><small>分钟 小时 日期 月份 星期；时区 ${escape(state.auth.timezone)}；星期 0=周一，6=周日</small><button class="text-button" type="button" data-action="preview-cron">预览下次执行</button><div id="cron-preview" class="cron-preview" role="status"></div></label><label class="full"><span>标签</span><input name="tags" value="${escape(task.tags.join(', '))}" placeholder="用逗号分隔"></label><label class="check-label full"><input type="checkbox" name="enabled" ${task.enabled ? 'checked' : ''}> 启用定时提醒</label></div><div class="help"><p><code>0 9 * * *</code> 每天 09:00</p><p><code>0 10,21 28 * *</code> 每月 28 日 10:00 和 21:00</p><p><code>0 9 * * mon-fri</code> 工作日 09:00</p><p>日期与星期同时匹配才执行，沿用旧应用的 APScheduler 规则。最小精度为分钟。</p></div></form>`,
    '<button data-action="close-dialog">取消</button><button class="primary" type="submit" form="task-form">保存任务</button>',
  );
}
function editGroup(groupId) {
  const g = state.groups.find((g) => g.id === groupId) || {
    name: '',
    icon: 'folder',
    sort_order: state.groups.length,
  };
  showDialog(
    groupId ? '编辑分组' : '新建分组',
    `<form id="group-form" data-id="${groupId || ''}"><div class="field-grid"><label class="full"><span>名称</span><input name="name" value="${escape(g.name)}" ${g.name === '默认' ? 'readonly' : ''} required maxlength="100" placeholder="例如：工作"></label><label><span>图标</span><select name="icon" id="group-icon">${groupIcons.map(([value, label]) => `<option value="${value}" ${g.icon === value ? 'selected' : ''}>${label}</option>`).join('')}${groupIcons.some(([value]) => value === g.icon) ? '' : `<option value="${escape(g.icon)}" selected>当前图标：${escape(g.icon)}</option>`}</select><span id="group-icon-preview" class="icon-preview">${groupIcon(g.icon)} 图标预览</span></label><label><span>排序</span><input type="number" name="sort_order" value="${g.sort_order}" required></label></div></form>`,
    '<button data-action="close-dialog">取消</button><button class="primary" form="group-form" type="submit">保存分组</button>',
  );
}
function newTarget() {
  showDialog(
    '添加 Webhook 通道',
    `<form id="target-form"><div class="field-grid"><label class="full"><span>名称</span><input name="name" required maxlength="100" placeholder="例如：工作提醒"></label><label class="full"><span>请求地址</span><input name="url" placeholder="https://example.com/webhook" required></label><label class="full"><span>请求方式</span><select name="method"><option value="post_json">POST (JSON)</option><option value="get">GET</option><option value="post_form">POST (表单)</option></select></label><label class="full"><span>请求模板</span><textarea name="template">{"title":"{{title}}","content":"{{content}}","url":"{{url}}"}</textarea><small>GET / 表单模板示例：title={{title}}&amp;text={{content}}</small></label><label class="full"><span>备注</span><input name="note"></label></div></form>`,
    '<button data-action="close-dialog">取消</button><button class="primary" form="target-form" type="submit">添加通道</button>',
  );
}
async function showHistory(taskId, page = 1) {
  const data = await api('/api/tasks/' + taskId + '/history?page=' + page);
  showDialog(
    '执行历史：' + data.task.title,
    `<div class="history-list">${executionTable(data.history)}</div><div class="pagination"><span>共 ${data.total} 条记录，第 ${page} 页</span><div class="actions"><button data-action="history-page" data-id="${taskId}" data-value="${page - 1}" ${page <= 1 ? 'disabled' : ''}>上一页</button><button data-action="history-page" data-id="${taskId}" data-value="${page + 1}" ${page * 100 >= data.total ? 'disabled' : ''}>下一页</button></div></div>`,
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
  'calendar-more': (button) => {
    const entries = state.calendarEntries.filter((e) => e.when.startsWith(button.dataset.date));
    showDialog(
      button.dataset.date + ' 的全部提醒',
      `<div class="calendar-day-events">${entries.map((e) => `<div class="calendar-timeline-item"><span class="calendar-timeline-date"><strong>${e.when.slice(11, 16)}</strong></span><button class="calendar-timeline-task" data-action="edit-task" data-id="${e.task_id}">${escape(e.title)}</button></div>`).join('')}</div>`,
      '<button class="btn-link" data-action="close-dialog">关闭</button>',
    );
  },
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
      ? '接下来：' + data.next.join('、')
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
function syncSelection() {
  const count = $('#selected-count');
  if (count) count.textContent = `已选择 ${state.selected.size} 个`;
  document.querySelectorAll('.batch-toolbar button').forEach((button) => {
    button.disabled = state.selected.size === 0;
  });
}
document.addEventListener('change', (event) => {
  if (event.target.dataset.select) {
    const id = Number(event.target.dataset.select);
    event.target.checked ? state.selected.add(id) : state.selected.delete(id);
    syncSelection();
  }
  if (event.target.id === 'select-all') {
    document.querySelectorAll('[data-select]').forEach((el) => {
      el.checked = event.target.checked;
      el.checked
        ? state.selected.add(Number(el.dataset.select))
        : state.selected.delete(Number(el.dataset.select));
    });
    syncSelection();
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
    button = form.querySelector('button[type=submit]');
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
$('#mobile-menu').addEventListener('click', () => {
  const open = $('#mobile-nav').classList.toggle('active');
  $('#mobile-menu').classList.toggle('active', open);
  $('#mobile-menu').setAttribute('aria-expanded', String(open));
});
$('#mobile-logout').addEventListener('click', () => $('#logout').click());
$('#sidebar-toggle').addEventListener('click', () => {
  const collapsed = !document.documentElement.classList.contains('sidebar-collapsed');
  setSidebarCollapsed(collapsed);
  try {
    localStorage.setItem('taskly.sidebarCollapsed', String(collapsed));
  } catch {
    // The sidebar remains usable when browser storage is unavailable.
  }
});
document.addEventListener('click', (event) => {
  const button = event.target.closest('.password-toggle');
  if (!button) return;
  const input = button.closest('.password-field').querySelector('input');
  const visible = input.type === 'password';
  input.type = visible ? 'text' : 'password';
  button.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
  button.setAttribute('aria-pressed', String(visible));
  button.innerHTML = icon(visible ? 'eye-slash' : 'eye');
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('#mobile-menu, #mobile-nav')) closeMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu();
});
document.addEventListener('input', (event) => {
  if (event.target.id === 'group-keyword') {
    const keyword = event.target.value.trim().toLowerCase();
    document.querySelectorAll('[data-group-name]').forEach((row) => {
      row.hidden = !row.dataset.groupName.toLowerCase().includes(keyword);
    });
  }
});
document.addEventListener('change', (event) => {
  if (event.target.id === 'group-icon') {
    $('#group-icon-preview').innerHTML = groupIcon(event.target.value) + ' 图标预览';
  }
});
window.addEventListener('resize', () => {
  for (const chart of charts) chart.resize();
  if (window.innerWidth >= 1024) closeMenu();
});
// Charts must follow the content width throughout the sidebar transition.
let chartResizeFrame;
new ResizeObserver(() => {
  cancelAnimationFrame(chartResizeFrame);
  chartResizeFrame = requestAnimationFrame(() => {
    if (main.clientWidth) for (const chart of charts) chart.resize();
  });
}).observe(main);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!state.auth || currentPage() !== 'dashboard') return;
  disposeCharts();
  renderCharts();
});
window.addEventListener('popstate', () => guarded(renderPage));
async function signedIn(auth) {
  state.auth = auth;
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  await renderPage();
}
(async () => {
  try {
    await signedIn(await api('/api/session'));
  } catch {
    showLogin();
  }
})();
