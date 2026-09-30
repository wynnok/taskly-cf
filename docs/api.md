# HTTP API

响应均为 JSON；错误结构为 `{ "error": "..." }`。除 `POST /api/login` 外，所有 API 需要登录 Cookie。所有写请求必须发送同源 `Origin`、`Content-Type: application/json` 和会话中的 `X-CSRF-Token`。

| 路径                     | 方法               | 用途                                                               |
| ------------------------ | ------------------ | ------------------------------------------------------------------ |
| `/api/login`             | POST               | `{username,password}`，创建会话                                    |
| `/api/session`           | GET                | 返回 username、csrf、timezone                                      |
| `/api/logout`            | POST               | 删除当前会话                                                       |
| `/api/tasks`             | GET                | 分页任务；q、group_id、webhook_id、enabled、last_status、tag、page |
| `/api/tasks`             | POST               | 创建任务                                                           |
| `/api/tasks/:id`         | GET / PUT / DELETE | 查询、修改、删除任务                                               |
| `/api/tasks/:id/toggle`  | POST               | 原子切换启用状态                                                   |
| `/api/tasks/:id/run`     | POST               | 发送一次并返回 `{status,error}`                                    |
| `/api/tasks/:id/history` | GET                | page，100 条/页                                                    |
| `/api/tasks/batch`       | POST               | `{action:enable/disable/delete,ids:[]}`                            |
| `/api/tasks/export`      | GET                | 导出任务 JSON 数组                                                 |
| `/api/tasks/import`      | POST               | 导入 JSON 数组，最多 100 个                                        |
| `/api/groups`            | GET / POST         | 分组列表 / 新建分组                                                |
| `/api/groups/:id`        | PUT / DELETE       | 修改 / 删除分组                                                    |
| `/api/settings`          | GET                | 账号信息和通道；不返回登录哈希或 Worker secrets                    |
| `/api/settings/auth`     | PUT                | `{username,current_password,password?,note?}`，撤销全部会话        |
| `/api/webhooks`          | POST               | 新建通道                                                           |
| `/api/webhooks/:id`      | PUT / DELETE       | 修改 / 删除通道                                                    |
| `/api/webhooks/:id/test` | POST               | 测试已保存的通道                                                   |
| `/api/statistics`        | GET                | days=1..365，执行统计与调度状态                                    |
| `/api/calendar`          | GET                | month=YYYY-MM，未来提醒，最多 600 个                               |
| `/api/cron/preview`      | POST               | `{expression}`，返回未来 5 个时刻                                  |

任务字段：`title,message,url,cron_expression,enabled,tags,group_id,webhook_id`。channel 只能是 webhook。生产迁移保留 ID；JSON 导入创建新的 ID。

通道字段：`name,method,url,template,note,provider`。method 为 get/post_json/post_form。provider 为 generic/serverchan3。默认 Server酱³ 通道不可删除或改名；仍被任务引用的通道和分组不可删除。
