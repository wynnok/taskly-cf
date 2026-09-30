# ADR 0001: Workers、D1 与分钟调度

状态：采用。日期：2026-09-30。

原应用依赖 Flask、文件 SQLite 和常驻 APScheduler。新应用使用 ES module Worker 的 fetch/scheduled 入口、D1 和 Workers Static Assets；只有 Webhook 通知通道。

每分钟扫描到期任务，原 cron 按 Asia/Shanghai 和 APScheduler 的星期编号/AND 规则解释。D1 execution_claims 的复合主键原子抑制重复计划投递。外部 Webhook 没有通用幂等协议，网络超时无法确认服务商是否已接收，因此失败不自动重投；未知中断在 20 分钟后记载失败，允许管理员判断后手动执行。

生产 SQL 使用只读源库快照、完整 schema 和明确 INSERT，拒绝非空目标。生产数据与凭据只留在被忽略的 private 目录；源数据库与软链接不纳入 Git。保留已删除任务的历史，task_id 为 NULL，legacy_task_id 记录原 ID。

代价：分钟精度代替任意秒级调度；五分钟以上的停机不补发。实际生产库的全部 12 个 cron 均为五段，可完整保留。
