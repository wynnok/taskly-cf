import { localText } from './cron.js';
export const SERVERCHAN_TEMPLATE =
  '{"title":"{{title}}","desp":"{{content}}\\n\\n[查看详情]({{url}})"}';
export function render(template, variables, encode = (x) => x) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (placeholder, key) =>
    key in variables ? encode(String(variables[key])) : placeholder,
  );
}
export function validUrl(value, optional = false) {
  if (optional && !value) return true;
  try {
    const u = new URL(value);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password;
  } catch {
    return false;
  }
}
export function validateTarget(input) {
  if (!input || typeof input !== 'object') throw new Error('通道配置无效');
  const name = String(input.name || '').trim(),
    method = input.method;
  if (!name || name.length > 100) throw new Error('通道名称不能为空或超过 100 字');
  if (!['get', 'post_json', 'post_form'].includes(method))
    throw new Error('不支持的 Webhook 请求方式');
  const url = String(input.url || '').trim();
  if (
    url &&
    !validUrl(
      render(url, { title: 'test', content: 'test', url: '', time: '' }, encodeURIComponent),
    )
  )
    throw new Error('Webhook 地址必须为 HTTP(S) URL');
  const template = String(input.template || '');
  if (url.length > 4096 || template.length > 20000) throw new Error('通道配置过长');
  if (method === 'post_json') {
    try {
      JSON.parse(
        render(template, { title: '"\n', content: '"\n', url: '', time: '' }, (x) =>
          JSON.stringify(x).slice(1, -1),
        ),
      );
    } catch {
      throw new Error('JSON 模板无效；占位符需要写在双引号内');
    }
  }
  const provider = input.provider === 'serverchan3' ? 'serverchan3' : 'generic';
  if (
    provider === 'serverchan3' &&
    url &&
    !/^https:\/\/[\w-]+\.push\.ft07\.com\/send\/[^/?#]+\.send$/.test(url)
  )
    throw new Error('Server酱³ 地址应为 https://UID.push.ft07.com/send/SENDKEY.send');
  return { name, method, url, template, note: String(input.note || '').slice(0, 1000), provider };
}
export async function sendWebhook(
  task,
  target,
  env,
  count = null,
  now = Date.now(),
  fetcher = fetch,
) {
  let url = target.url;
  if (!url && target.provider === 'serverchan3' && env.SERVERCHAN_UID && env.SERVERCHAN_SENDKEY) {
    if (!/^[\w-]+$/.test(env.SERVERCHAN_UID) || !/^[\w-]+$/.test(env.SERVERCHAN_SENDKEY))
      throw new Error('Server酱³ UID 或 SendKey 格式无效');
    url = `https://${env.SERVERCHAN_UID}.push.ft07.com/send/${env.SERVERCHAN_SENDKEY}.send`;
  }
  if (!url) throw new Error('Webhook 通道未配置地址，请在设置中填写或配置 Server酱³ secrets');
  const variables = {
    title: task.title,
    content:
      count === null
        ? task.message
        : (task.message || '').replaceAll('{{var_monthly_count}}', String(count)),
    url: task.url || '',
    time: localText(now, env.APP_TIMEZONE),
  };
  const options = {
    method: target.method === 'get' ? 'GET' : 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  };
  url = render(url, variables, encodeURIComponent);
  if (!validUrl(url)) throw new Error('Webhook 地址无效');
  if (target.method === 'get') {
    const query = render(target.template, variables, encodeURIComponent).replace(/^\?/, '');
    if (query) url += (url.includes('?') ? '&' : '?') + query;
  } else if (target.method === 'post_json') {
    options.body = render(target.template, variables, (x) => JSON.stringify(x).slice(1, -1));
    JSON.parse(options.body);
    options.headers = { 'Content-Type': 'application/json; charset=utf-8' };
  } else {
    options.body = render(target.template, variables, encodeURIComponent);
    options.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  }
  let response;
  try {
    response = await fetcher(url, options);
  } catch {
    throw new Error('Webhook 网络请求失败或超过 10 秒超时');
  }
  if (!response.ok) throw new Error(`Webhook 返回 HTTP ${response.status}`);
  if (target.provider === 'serverchan3') {
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error('Server酱³ 返回了无效 JSON');
    }
    if (data.code !== 0 && data.errno !== 0)
      throw new Error('Server酱³ 拒绝了推送，请检查 SendKey 和额度');
  } else if (response.body) await response.body.cancel();
}
