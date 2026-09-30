import { cronMatches, localText } from './cron.js';
import { sendWebhook } from './webhook.js';

export async function executeTask(
  task,
  env,
  source = 'manual',
  scheduledFor = null,
  now = Date.now(),
  fetcher = fetch,
) {
  const db = env.DB;
  if (scheduledFor) {
    const claim = await db
      .prepare(
        `INSERT OR IGNORE INTO execution_claims(task_id,scheduled_for,claimed_at)
      SELECT id,?,? FROM tasks WHERE id=? AND enabled=1 AND updated_at=?`,
      )
      .bind(scheduledFor, now, task.id, task.updated_at)
      .run();
    if (!claim.meta.changes) return { skipped: true };
  }
  let status = 'success',
    error = null;
  try {
    const target = await db
      .prepare('SELECT * FROM webhook_targets WHERE id=?')
      .bind(task.webhook_id)
      .first();
    if (!target) throw new Error('任务指定的 Webhook 通道不存在');
    const monthStart = localText(now, env.APP_TIMEZONE).slice(0, 7) + '-01 00:00:00';
    const count = await db
      .prepare(
        'SELECT COUNT(*) AS count FROM execution_history WHERE task_id=? AND executed_at>=? AND executed_at<=?',
      )
      .bind(task.id, monthStart, localText(now, env.APP_TIMEZONE))
      .first();
    await sendWebhook(task, target, env, count.count + 1, now, fetcher);
  } catch (exc) {
    status = 'failed';
    error = exc.message || 'Webhook 发送失败';
  }
  const statements = [
    db
      .prepare(
        'INSERT OR IGNORE INTO execution_history(task_id,legacy_task_id,status,error,executed_at,scheduled_for,source) VALUES(?,?,?,?,?,?,?)',
      )
      .bind(
        task.id,
        task.id,
        status,
        error,
        localText(now, env.APP_TIMEZONE),
        scheduledFor,
        source,
      ),
  ];
  if (scheduledFor)
    statements.push(
      db
        .prepare('UPDATE execution_claims SET finished=1 WHERE task_id=? AND scheduled_for=?')
        .bind(task.id, scheduledFor),
    );
  await db.batch(statements);
  return { status, error };
}

export async function runScheduled(env, timestamp = Date.now(), fetcher = fetch) {
  const now = Date.now(),
    db = env.DB,
    end = Math.floor(timestamp / 60000) * 60000;
  // An interrupted claim has an ambiguous outcome: record it, do not send it again.
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO execution_history(task_id,legacy_task_id,status,error,executed_at,scheduled_for,source)
      SELECT task_id,task_id,'failed','执行中断，投递结果未知；为避免重复提醒未自动重发',?,scheduled_for,'scheduled'
      FROM execution_claims WHERE finished=0 AND claimed_at<?`,
      )
      .bind(localText(now, env.APP_TIMEZONE), now - 1200000),
    db
      .prepare('UPDATE execution_claims SET finished=1 WHERE finished=0 AND claimed_at<?')
      .bind(now - 1200000),
    db.prepare('DELETE FROM sessions WHERE expires_at<?').bind(now),
    db.prepare('DELETE FROM login_attempts WHERE expires_at<?').bind(now),
    db
      .prepare('DELETE FROM execution_claims WHERE claimed_at<? AND finished=1')
      .bind(now - 30 * 86400000),
  ]);
  const previous = await db
    .prepare("SELECT value FROM scheduler_state WHERE key='last_scan'")
    .first();
  // Catch up at most five minutes after a delay. First deployment never replays old tasks.
  const start = previous ? Math.max(Number(previous.value) + 60000, end - 4 * 60000) : end;
  const { results: tasks } = await db
    .prepare('SELECT * FROM tasks WHERE enabled=1 ORDER BY id')
    .all();
  let executed = 0;
  for (let minute = start; minute <= end; minute += 60000) {
    for (const task of tasks) {
      try {
        if (cronMatches(task.cron_expression, minute, env.APP_TIMEZONE)) {
          const result = await executeTask(
            task,
            env,
            'scheduled',
            new Date(minute).toISOString(),
            now,
            fetcher,
          );
          if (!result.skipped) executed++;
        }
      } catch (exc) {
        // Invalid imported schedules must be visible; storage errors fail the invocation.
        throw new Error(`任务 ${task.id} 调度失败: ${exc.message}`);
      }
    }
  }
  await db.batch([
    db
      .prepare(
        "INSERT INTO scheduler_state(key,value) VALUES('last_scan',?) ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT)",
      )
      .bind(String(end)),
    db
      .prepare(
        "INSERT INTO scheduler_state(key,value) VALUES('last_completed',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .bind(localText(now, env.APP_TIMEZONE)),
    db
      .prepare(
        "INSERT INTO scheduler_state(key,value) VALUES('last_completed_epoch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .bind(String(now)),
  ]);
  return { executed };
}
