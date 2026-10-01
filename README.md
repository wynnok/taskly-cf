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

## 用 Cloudflare 网页部署（生产数据迁移）

下面按 Cloudflare Dashboard 网页操作来写，不要求用 Wrangler 命令部署。适用于把本仓库部署到 Cloudflare，并导入本项目原有的 `tasks.db` 数据。Cloudflare 菜单文字偶尔会调整；括号内附了对应官方文档。

### 先准备好生产 SQL

当前工作目录已经有离线生成的 `private/production.sql`。如果你重新生成了 SQL，生成过程仍要在有原始 `tasks.db` 的电脑上完成；数据库和 SQL 都不会上传到 GitHub。

- 这个 SQL 包含原来的任务、分组、历史和登录信息。所有邮件提醒已转成 Webhook，默认目标为 Server酱³；SMTP 设置和旧会话不迁移。
- 文件还包含建表语句及空库保护。请只把它导入一个**新建且为空**的 D1 数据库，并且只执行一次。不要先手动建表，也不要对已经有数据的库重复执行。
- 当前生产数据预期为 **12 个任务、4 个分组、196 条历史**，其中 15 条历史来自已经删除的旧任务，仍会保留。
- `private/production.sql` 可能含有任务内容、登录密码哈希和旧 Webhook 地址；不要提交到 GitHub，也不要发给他人。

### 1. 在网页创建 D1 数据库

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，进入 **Workers & Pages → D1 SQL Database**（也可能显示为 **Storage & databases → D1**）。
2. 点 **Create database**，名称填写 `taskly`，然后点 **Create**。位置可选 Asia-Pacific。
3. 打开刚创建的 `taskly` 数据库，在页面详情中复制 **Database ID**。稍后要把它填入仓库的配置文件。

Cloudflare 官方：[创建 D1 数据库](https://developers.cloudflare.com/d1/get-started/#2-create-a-database)。

### 2. 用 D1 网页 Console 导入生产数据

1. 确认 `taskly` 是刚新建的空数据库；不要在已经有表或数据的数据库上继续。
2. 打开数据库里的 **Console**。
3. 在本机文本编辑器打开 `private/production.sql`，全选并复制文件内容。
4. 粘贴到 D1 的 Console 查询框，点 **Execute**，等待成功提示。整份 SQL 大约几十 KB，里面有多条语句，请一次性粘贴并执行，不要拆分执行。
5. 在 Console 中分别运行以下查询，确认导入正确：

   ```sql
   SELECT COUNT(*) AS tasks FROM tasks;
   SELECT COUNT(*) AS groups FROM groups;
   SELECT COUNT(*) AS history FROM execution_history;
   SELECT channel, COUNT(*) AS count FROM tasks GROUP BY channel;
   PRAGMA foreign_key_check;
   ```

   结果应为 12 个任务、4 个分组、196 条历史；所有任务的 channel 都是 `webhook`；`foreign_key_check` 不应返回行。

Cloudflare 官方也演示了在 D1 Dashboard 的 **Console** 粘贴 SQL 并执行：[D1 网页入门教程](https://developers.cloudflare.com/d1/get-started/#4-run-a-query-against-your-d1-database)。

### 3. 把 D1 ID 写进 GitHub 仓库配置

这个 Worker 通过 Cloudflare 的 GitHub Builds 从 `main` 分支发布。D1 绑定配置在仓库文件里管理，因此新建数据库后要先在 GitHub 网页更新一次配置：

1. 打开 [wynnok/taskly-cf 的 GitHub 仓库](https://github.com/wynnok/taskly-cf)，进入 `wrangler.jsonc`。
2. 点铅笔图标 **Edit this file**，找到 `d1_databases` 下的 `database_id`。
3. 把 `00000000-0000-0000-0000-000000000000` 替换为第 1 步复制的 Database ID。保持 `database_name` 为 `taskly`、`binding` 为 `DB`，其它配置不改。
4. 点 **Commit changes**，直接提交到 `main`。

`DB` 是 Worker 程序访问数据库时使用的绑定名；数据库 ID 则指向你账号下刚建好的那一个库。部署后可在 Worker 的 **Bindings** 页面确认 D1 绑定显示为 `DB → taskly`。Cloudflare 的绑定说明见[官方 D1 绑定教程](https://developers.cloudflare.com/d1/get-started/#3-bind-your-worker-to-your-d1-database)。

### 4. 在网页创建 Worker，并预先放入 Server酱³密钥

先创建空 Worker 并放入密钥，再连接 GitHub，可以避免刚上线时定时任务尚未配置好投递地址。

1. 回到 Cloudflare Dashboard，进入 **Workers & Pages → Create application → Start with Hello World**。
2. Worker 名称填写 **`taskly-cf`**，点 **Deploy**。名称必须与仓库 `wrangler.jsonc` 中的 `name` 完全一致。
3. 打开 Worker，进入 **Settings → Variables and Secrets**（部分界面在 **Settings → Variables**）。新增两个类型为 **Secret** 的运行时密钥：

   | 名称 | 值 |
   | --- | --- |
   | `SERVERCHAN_UID` | 你的 Server酱³ UID |
   | `SERVERCHAN_SENDKEY` | 你的 Server酱³ SendKey |

   保存密钥。请选 **Secret**，不要把密钥作为普通明文变量提交到 GitHub。

原生产库没有 Server酱³ 的 UID/SendKey，因此导入后的默认通道地址为空；设置这两个密钥后，应用会自动构造投递地址。也可以登录应用后在 Webhook 设置页填写完整地址。Server酱³ 接口说明：[官方文档](https://sc3.ft07.com/doc)。

### 5. 从 Cloudflare 网页连接 GitHub 并发布

1. 在 Worker 页面进入 **Settings → Builds**，点 **Connect**。
2. 按提示授权 Cloudflare Workers GitHub App，只授予它访问 `wynnok/taskly-cf` 仓库的权限，然后选择仓库和 `main` 分支。
3. 仓库根目录保持 `/`。Build settings 填写：

   | 设置项 | 填写内容 |
   | --- | --- |
   | Build command | `npx wrangler d1 migrations apply taskly --remote` |
   | Deploy command | `npx wrangler deploy` |
   | Root directory | `/` 或留空（仓库根目录） |

4. 保存并启动构建。Build command 会在首次发布前应用仓库里的初始数据库 migration；它使用 `IF NOT EXISTS`，所以在上一步已经导入完整 SQL 的情况下不会覆盖任务数据。之后每次向 `main` 提交代码，Cloudflare 都会先应用尚未运行的 D1 migrations，再部署 Worker。
5. 在 **Deployments → View build history** 查看构建日志，确认 Build 和 Deploy 都成功。官方步骤见 [Workers Builds：连接仓库](https://developers.cloudflare.com/workers/ci-cd/builds/)和[构建配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)。

如果原来已经建过 `taskly-cf` Worker，就不用再创建 Hello World：直接在该 Worker 的 **Settings → Variables and Secrets** 设置密钥，然后 **Settings → Builds → Connect**。

### 6. 打开应用并完成首次检查

1. 在 Worker 的 Overview 页面打开 `https://taskly-cf.<你的 workers.dev 子域>.workers.dev`。
2. 使用旧应用的用户名和密码登录。原有账号保留，旧明文密码已转成安全哈希；建议登录后在账号设置里更换密码。因为是迁移现有数据库，**不需要**设置 `INITIAL_ADMIN_PASSWORD`。
3. 进入应用设置，测试 Server酱³ 通道。收到测试消息后，再检查任务列表、分组和执行历史。
4. 确认 Worker 的 **Bindings** 页面显示 `DB → taskly`。仓库配置中的 Cron 为 `* * * * *`，Worker 首次部署后会每分钟扫描任务，不需要手动再添加一个 Cron。若想查看 Cron 触发情况，打开 Worker 的 **Settings → Triggers → Cron Triggers** 或 **View events**。新建/改名后 Cron 事件可能需要一段时间才显示。
5. 在应用运行监控中查看“上次调度完成”。

如果是全新安装而不是导入本项目数据库，设置页没有可用账号时，需在 Worker 的 **Settings → Variables and Secrets** 中设置 Secret `INITIAL_ADMIN_PASSWORD` 后重新部署；首次初始化用户名默认为 `admin`，也可用普通变量 `INITIAL_ADMIN_USERNAME` 指定。

## 用 Cloudflare 网页部署（空白新库）

如果不迁移旧数据，跳过生产 SQL 导入。先在 D1 Console 执行仓库的 `migrations/0001_initial.sql`，再按上面的流程创建 Worker、填 D1 ID、设置 `SERVERCHAN_UID` / `SERVERCHAN_SENDKEY` 并连接 GitHub。新库还需要设置 `INITIAL_ADMIN_PASSWORD` Secret。后续发布步骤相同。

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
