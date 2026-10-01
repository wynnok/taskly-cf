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
2. 点 **Create database**，名称可填写 `taskly`（这是教程示例，也可以自定义，例如 `taskly-prod`），然后点 **Create**。位置可选 Asia-Pacific。
3. 打开刚创建的数据库，在页面详情中复制 **Database ID**。稍后要把它填入仓库的配置文件。

Cloudflare 官方：[创建 D1 数据库](https://developers.cloudflare.com/d1/get-started/#2-create-a-database)。

### 2. 检查 D1，再导入生产 SQL 文件

1. 确认刚创建的 D1 数据库（默认示例名 `taskly`）是空的；不要在已经有表或数据的数据库上继续。
2. 打开数据库里的 **Console**。
3. 先在查询编辑框输入 `SELECT 1;` 并点 **Execute**，确认返回 `1`。编辑框里必须能看到 SQL 文本；如果提示 `Requests without any query are not supported`，表示这次请求没有带上查询内容，请重新点进 SQL 编辑框后输入/粘贴。
4. 检查应用表是否存在：

   ```sql
   SELECT name FROM sqlite_master
   WHERE type = 'table' AND name IN ('tasks', 'groups', 'execution_history')
   ORDER BY name;
   ```

   如果查询已经列出这些表，先不要导入：继续查任务和历史数量，确认是不是已经完整导入。D1 自动创建的内部表不表示生产数据已经导入。

5. 从项目目录打开本机终端。先确认本机 `wrangler.jsonc` 的 `database_id` 已替换成第 1 步复制的 ID（如果你只在 GitHub 网页改过，也把同一个 ID 填到本机文件里）；`database_name` 要对应实际 D1 名称，`binding` 保持 `DB`。然后执行文件导入命令。若尚未安装项目依赖，先执行 `npm ci`；如果 Wrangler 尚未登录，运行 `npx wrangler login` 并在浏览器完成 Cloudflare 授权。将命令中的 `taskly` 换成你实际创建的数据库名称：

   ```bash
   npx wrangler d1 execute taskly --remote --file=private/production.sql
   npx wrangler d1 migrations apply DB --remote
   ```

   这是单独的一次数据导入命令；Worker 的创建和部署仍按后面的 **Create application → Continue with GitHub** 网页步骤操作。Cloudflare 官方把 `.sql` 文件导入指向 Wrangler 的 `d1 execute --file` 命令；D1 Console 适合执行短查询和 SQL 片段：[官方导入说明](https://developers.cloudflare.com/d1/best-practices/import-export-data/)。

6. 回到 D1 **Console**，分别运行以下查询，确认数据正确：

   ```sql
   SELECT COUNT(*) AS tasks FROM tasks;
   SELECT COUNT(*) AS groups FROM groups;
   SELECT COUNT(*) AS history FROM execution_history;
   SELECT channel, COUNT(*) AS count FROM tasks GROUP BY channel;
   PRAGMA foreign_key_check;
   ```

   结果应为 12 个任务、4 个分组、196 条历史；所有任务的 channel 都是 `webhook`；`foreign_key_check` 不应返回行。

Cloudflare 官方也演示了在 D1 Dashboard 的 **Console** 输入和运行 SQL 片段：[D1 网页入门教程](https://developers.cloudflare.com/d1/get-started/#4-run-a-query-against-your-d1-database)。

### 3. 把 D1 ID 写进 GitHub 仓库配置

这个 Worker 通过 Cloudflare 的 GitHub Builds 从 `main` 分支发布。D1 绑定配置在仓库文件里管理，因此新建数据库后要先在 GitHub 网页更新一次配置：

1. 打开 [wynnok/taskly-cf 的 GitHub 仓库](https://github.com/wynnok/taskly-cf)，进入 `wrangler.jsonc`。
2. 点铅笔图标 **Edit this file**，找到 `d1_databases` 下的 `database_id`。
3. 把 `00000000-0000-0000-0000-000000000000` 替换为第 1 步复制的 Database ID。`database_name` 必须与第 1 步实际创建的 D1 名称一致（默认示例是 `taskly`）；`binding` 保持为 `DB`，其它配置不改。
4. 点 **Commit changes**，直接提交到 `main`。

`DB` 是 Worker 程序访问数据库时使用的绑定变量名，代码通过 `env.DB` 读取它；D1 资源名可以自定义，数据库 ID 指向你账号下的实际数据库。比如你把资源名设为 `taskly-prod`，配置中就写 `"database_name": "taskly-prod"`，同时保留 `"binding": "DB"`。部署后可在 Worker 的 **Bindings** 页面确认绑定显示为 `DB → taskly-prod`（或你选的名称）。Cloudflare 的绑定说明见[官方 D1 绑定教程](https://developers.cloudflare.com/d1/get-started/#3-bind-your-worker-to-your-d1-database)。

### 4. 从 Create application 通过 GitHub 创建并部署

首次部署前，先在 GitHub 网页编辑 `wrangler.jsonc`：把 `triggers` 中的 Cron 临时改为空数组：

```jsonc
"triggers": { "crons": [] },
```

保留前一步填好的 D1 ID 和 `binding: "DB"`。提交到 `main`。此时 Cloudflare 还未连接仓库，所以不会触发 Worker 部署；空 Cron 可让首次部署后有时间配置运行时密钥，不会提前扫描生产任务。

然后在 Cloudflare Dashboard 按你习惯的入口创建应用：

1. 进入 **Workers & Pages → Create application → Continue with GitHub**。
2. 首次使用时授权 Cloudflare Workers GitHub App 访问仓库；建议只授权 `wynnok/taskly-cf`。
3. 选择 GitHub 账号、`wynnok/taskly-cf` 仓库和 `main` 分支，继续。
4. 部署设置填写：

   | 设置项 | 填写内容 |
   | --- | --- |
   | Project name | `taskly-cf`（必须与 `wrangler.jsonc` 的 `name` 相同） |
   | Build command | 留空（本项目无需编译，数据库已在导入步骤初始化） |
   | Deploy command | `npx wrangler deploy` |
   | Root directory | `/` 或留空（仓库根目录） |

5. 点 **Save and Deploy**。Cloudflare 会读取仓库配置，打包 Worker 代码和网页静态资源并发布。以后每次推送到 `main` 会自动重新部署；如果更新中包含新的数据库 migration，需要先执行 `npx wrangler d1 migrations apply DB --remote`。默认构建令牌不一定有 D1 修改权限，因此这里不把数据库迁移放到 Build command 中。
6. 在 **Deployments → View build history** 查看日志，确认 Build 和 Deploy 成功。官方步骤见 [Workers Builds：连接仓库](https://developers.cloudflare.com/workers/ci-cd/builds/)和[构建配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)。

### 5. 添加运行时密钥并开启 Cron

1. 部署完成后，打开刚创建的 Worker，进入 **Settings → Variables and Secrets**。新增两个类型为 **Secret** 的运行时密钥：

   | 名称 | 值 |
   | --- | --- |
   | `SERVERCHAN_UID` | 你的 Server酱³ UID |
   | `SERVERCHAN_SENDKEY` | 你的 Server酱³ SendKey |

   保存密钥。Build 设置中的变量只供构建过程使用，不能代替 Worker 的运行时密钥；这里要在 Worker 的 Settings 下新增。

2. 回到 GitHub 网页编辑 `wrangler.jsonc`，把 Cron 从空数组恢复为：

   ```jsonc
   "triggers": { "crons": ["* * * * *"] },
   ```

   提交到 `main`。Cloudflare 会自动重新构建并部署；Worker 开始每分钟扫描任务。

原生产库没有 Server酱³ 的 UID/SendKey，所以导入后的默认通道地址为空；设置这两个密钥后，应用会自动构造投递地址。也可以登录应用后在 Webhook 设置页填写完整地址。Server酱³ 接口说明：[官方文档](https://sc3.ft07.com/doc)。

### 6. 打开应用并完成首次检查

1. 在 Worker 的 Overview 页面打开 `https://taskly-cf.<你的 workers.dev 子域>.workers.dev`。
2. 使用旧应用的用户名和密码登录。原有账号保留，旧明文密码已转成安全哈希；建议登录后在账号设置里更换密码。因为是迁移现有数据库，**不需要**设置 `INITIAL_ADMIN_PASSWORD`。
3. 进入应用设置，测试 Server酱³ 通道。收到测试消息后，再检查任务列表、分组和执行历史。
4. 确认 Worker 的 **Bindings** 页面显示 `DB → taskly`（如果你使用自定义数据库名，则显示为 `DB → 你的数据库名`）。Cron 已在上一步通过 GitHub 配置开启，不需要再手工添加。查看触发情况可打开 Worker 的 **Settings → Triggers → Cron Triggers** 或 **View events**。新建/改名后 Cron 事件可能需要一段时间才显示。
5. 在应用运行监控中查看“上次调度完成”。

如果是全新安装而不是导入本项目数据库，设置页没有可用账号时，需在 Worker 的 **Settings → Variables and Secrets** 中设置 Secret `INITIAL_ADMIN_PASSWORD` 后重新部署；首次初始化用户名默认为 `admin`，也可用普通变量 `INITIAL_ADMIN_USERNAME` 指定。

## 用 Cloudflare 网页部署（空白新库）

如果不迁移旧数据，跳过生产 SQL 导入，在 D1 Console 执行仓库的 `migrations/0001_initial.sql`。数据库名称可自定义；将名称和 ID 写入 `wrangler.jsonc`，绑定保留 `DB`。按上面的 GitHub 导入流程首次部署后，在 Worker 的 **Settings → Variables and Secrets** 添加 `SERVERCHAN_UID`、`SERVERCHAN_SENDKEY` 和 `INITIAL_ADMIN_PASSWORD` 三个 Secret，再把 Cron 配置恢复为 `* * * * *` 并提交。新库初始化账号默认为 `admin`。

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
