# Taskly CF

个人定时任务与 Webhook 提醒应用，由 Unified Task 的 Flask / SQLite 应用改写为 Cloudflare Workers + D1。运行时使用原生 JavaScript 和浏览器界面，不需要 Python、Docker 或常驻调度进程。Python 只用于离线导出旧生产库。

## 功能

- 登录、30 分钟滑动会话、CSRF、登录限流、账号与密码修改。
- 任务创建/编辑/删除、搜索、分组/标签/状态筛选、分页、批量启停与删除。
- 手动执行、历史记录、执行统计、任务日历、调度状态监控。
- 多 Webhook 通道：GET、POST JSON、POST 表单，支持模板变量和通道测试。
- 默认通道 **Server酱³**；已移除旧邮件发送代码、邮件 UI 和 SMTP 设置。
- 定时任务通过一分钟一次的 Cloudflare Cron Trigger 扫描 D1，执行占位阻止相同任务/时刻重复投递。

## 开发

需要 Node.js 22+、npm；离线迁移工具需要 Python 3.9+（标准库，无额外依赖）。

```bash
npm ci
cp .dev.vars.example .dev.vars
# 修改 .dev.vars，设置至少 12 位的 INITIAL_ADMIN_PASSWORD。
npm run db:migrate
npm run dev
```

打开 `http://localhost:8787`。初次登录时初始化账号，默认用户名 `admin`。已有生产 SQL 提供账号时不需要初始化密码。

```bash
npm test          # workerd/D1 集成测试、Cron/Webhook 测试、迁移测试
npm run check    # JavaScript 语法检查及 Wrangler dry-run 构建
```

本地触发一次调度：

```bash
curl 'http://localhost:8787/cdn-cgi/local/scheduled'
```

此操作会实际发送本地库中的到期提醒。测试套件的所有外部提醒均使用模拟响应，不会联系生产通道。

## 导入现有生产数据并部署

以下流程针对原生产库迁移。**创建一个空 D1 数据库，先导入生产 SQL，再登记工程迁移。** 新安装、无需旧数据的场景只需 `npm run db:migrate:remote`，不运行生产 SQL。

1. 登录 Cloudflare，创建数据库：

   ```bash
   npx wrangler login
   npx wrangler d1 create taskly
   ```

2. 将返回的 `database_id` 写入 `wrangler.jsonc` 的 D1 绑定；当前全零 ID 是占位符。Worker 中的绑定名称必须保留 `DB`。

3. 离线导出生产 SQL（仓库当前工作目录已生成 `private/production.sql`）：

   ```bash
   npm run export:production
   ```

   导出以只读方式访问 `tasks.db`，保留任务、分组、历史、ID 与自增序列；邮件任务全部改成 `channel='webhook'`、`webhook_id=Server酱³`。原登录账号保留，明文密码转换成 PBKDF2 SHA-256 哈希，旧会话不迁移。SMTP 设置被丢弃。

   旧库中已删除任务的历史仍保留，并记录 `legacy_task_id`；新应用删除任务也会保留历史。默认分组引用异常的任务归入“默认”。已存在的 Webhook 通道保留，任务引用失效时归入 Server酱³。

   `private/production.sql` 含真实任务、登录哈希和可能存在的 Webhook 凭据，已被 `.gitignore` 排除。**SQL 只能执行一次，目标必须为空**；导入保护会拒绝非空目标，不会覆盖已有生产数据。它自带建表语句，无需手动拼接 schema，也不包含 D1 不支持的显式事务控制。

   如果旧密码已经是 Werkzeug 哈希，工具要求显式设置新密码：

   ```bash
   read -rs TASKLY_NEW_PASSWORD
   export TASKLY_NEW_PASSWORD
   python3 scripts/export_d1.py tasks.db --output private/production.sql --password-env TASKLY_NEW_PASSWORD
   unset TASKLY_NEW_PASSWORD
   ```

4. 导入空数据库并登记初始迁移：

   ```bash
   npx wrangler d1 execute taskly --remote --file=private/production.sql
   npm run db:migrate:remote
   ```

   初始 migration 使用 `IF NOT EXISTS` 和 `INSERT OR IGNORE`，可在生产 SQL 已导入之后登记，不会修改导入的任务与设置。导入后核对：

   ```bash
   npx wrangler d1 execute taskly --remote --command="SELECT COUNT(*) AS tasks FROM tasks; SELECT COUNT(*) AS groups FROM groups; SELECT COUNT(*) AS history FROM execution_history; SELECT channel,COUNT(*) FROM tasks GROUP BY channel; PRAGMA foreign_key_check;"
   ```

   此次提供的库应为 **12 个任务、4 个分组、196 条历史，全部任务为 webhook**。其中 15 条历史属于已删除任务，仍保留。逐项报告在 `private/production.report.json`。

5. 配置 Server酱³：

   ```bash
   npx wrangler secret put SERVERCHAN_UID
   npx wrangler secret put SERVERCHAN_SENDKEY
   ```

   或在应用设置页填写完整地址：`https://UID.push.ft07.com/send/SENDKEY.send`。设置页地址优先于 secrets。原库没有 Server酱³ 端点，迁移创建的默认通道地址为空，配置后才能投递；旧 Webhook 地址单独保存为“原 Webhook 通道”。[Server酱³ 官方接口文档](https://sc3.ft07.com/doc)。

6. 发布 Worker：

   ```bash
   npm run deploy
   ```

   在设置页测试 Server酱³ 通道。之后检查运行监控的“上次调度完成”；Cron 配置传播可能需要最多 15 分钟。[Cloudflare Cron 文档](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。

新安装的数据库还需要配置初始化密码：

```bash
npx wrangler secret put INITIAL_ADMIN_PASSWORD
# 如需用户名不同于 admin，可再设置 INITIAL_ADMIN_USERNAME。
```

迁移后的账号直接使用旧用户名与旧密码登录，建议通过设置页更换密码。

## 调度行为与兼容范围

- 默认时区 `Asia/Shanghai`，可在 `wrangler.jsonc` 的 `APP_TIMEZONE` 中修改。数据库历史时间为该时区的 `YYYY-MM-DD HH:mm:ss` 文本；已有生产库应保持 Asia/Shanghai。
- 保持原 APScheduler 语义：星期 **0=周一，6=周日**；支持 `mon-fri` 等名称，日期与星期为 **AND** 关系。
- 支持五段 Cron、秒字段严格为 `0` 的六段 Cron、`*`、逗号、范围、步长、月份/星期名称，以及日期字段 `last`。秒级频率、`1st mon` 等扩展不支持，创建/导入时明确拒绝，不会静默更改精度。
- 触发精度为分钟，页面显示该分钟的计划时刻。首次部署仅检查当前触发分钟，延迟后最多补扫最近五分钟，长期停机不会批量重放过期提醒。
- 每个任务/计划分钟在 D1 中原子占位。网络错误、HTTP 非 2xx 或 Server酱³ 业务错误均记录失败。避免未知网络结果导致重复提醒，不自动重试，可从界面手动重试。
- 执行中断的占位 20 分钟后标记为失败（投递结果未知），完成的占位保留 30 天。执行历史保留，直到数据库管理员主动清理。
- 本月序号 `{{var_monthly_count}}` 延续旧逻辑：本月所有已记载执行（含失败）数量 + 1；跨月重新计数。
- Webhook 模板的 `{{title}}`、`{{content}}`、`{{url}}`、`{{time}}` 按 JSON 或 URL/form 规则转义；未识别的占位符保持原文。外部请求超时为 10 秒，不跟随重定向。
- JSON 导入每批最多 100 个任务，先校验全部任务，再使用 [D1 batch 事务](https://developers.cloudflare.com/d1/worker-api/d1-database/) 原子写入；JSON 导出包含任务，不包含通道凭据。

## 工程结构

```text
src/index.js           HTTP API、D1 持久化、认证入口、静态资源
src/auth.js            密码哈希、会话与安全比较
src/cron.js            原应用 Cron 语义、时区、日历展开
src/scheduler.js       定时扫描、执行占位、投递历史
src/webhook.js         通道校验、模板与请求
public/                无构建依赖的中文管理界面
migrations/            D1 schema migrations
scripts/export_d1.py   只读生产库导出工具
private/               本地生产 SQL 和报告（不提交）
tests/                 离线及本地 workerd/D1 测试
```

Worker 的 API 路径见 `docs/api.md`。原应用软链接及生产 SQLite 文件仅作为本地迁移输入，不纳入 Git。
