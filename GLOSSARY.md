# 领域术语

- **任务（Task）**：标题、正文、Cron、分组、Webhook 通道与启用状态的组合。
- **分组（Group）**：任务的分类；默认分组必须存在。
- **Webhook 通道（Webhook target）**：请求地址、方法、模板与服务商信息。任务通过 webhook_id 引用。
- **Server酱³**：默认 Webhook 通道，使用 UID/SendKey 的 ft07.com 推送接口。
- **计划分钟（scheduled_for）**：Cron 对应的 UTC ISO 分钟，用于去重。
- **执行占位（Execution claim）**：某任务在某计划分钟的原子记录，保证最多发起一次定时投递。
- **执行历史（Execution history）**：一次发送的成功/失败结果、错误与本地时区时间。
- **本月序号（var_monthly_count）**：本月全部历史数量加一，在消息正文中渲染。
