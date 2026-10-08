import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { unstable_readConfig } from 'wrangler';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const config = unstable_readConfig({ config: 'wrangler.jsonc' });

test('production deployment keeps the minutely Cloudflare trigger enabled', () => {
  assert.deepEqual(config.triggers.crons, ['* * * * *']);
});

test('configured trigger delivers the October 8 Shanghai reminder through the scheduled handler', async () => {
  let sends = 0;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'main',
          modules: ['index', 'auth', 'cron', 'webhook', 'scheduler'].map((name) => ({
            type: 'ESModule',
            path: `src/${name}.js`,
          })),
          compatibilityDate: config.compatibility_date,
          cronTriggers: config.triggers.crons,
          d1Databases: { DB: 'scheduler-regression-db' },
          bindings: {
            ...config.vars,
            SERVERCHAN_UID: 'test-uid',
            SERVERCHAN_SENDKEY: 'test-key',
          },
          outboundService: async (request) => {
            assert.equal(request.url, 'https://test-uid.push.ft07.com/send/test-key.send');
            sends++;
            return Response.json({ code: 0 });
          },
        },
      ],
    }),
  );
  try {
    const db = await mf.getD1Database('DB');
    const schema = await readFile('migrations/0001_initial.sql', 'utf8');
    await db.batch(
      schema
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s)),
    );
    await db
      .prepare(
        `INSERT INTO tasks(id,title,cron_expression,enabled,group_id,webhook_id,created_at,updated_at)
        VALUES(3,'提醒回归测试','0 10,21 7,8 * *',1,1,1,'2026-10-01 00:00:00','2026-10-01 00:00:00')`,
      )
      .run();
    const worker = await mf.getWorker();
    const atTen = Date.parse('2026-10-08T02:00:00Z');
    // Miniflare does not run timers automatically. Replay only the deployed triggers.
    for (const cron of config.triggers.crons) {
      assert.equal(cron, '* * * * *');
      await worker.scheduled({ scheduledTime: atTen, cron });
    }
    assert.equal(sends, 1, '10:00 reminder must be sent automatically without manual execution');
    const history = await db.prepare('SELECT * FROM execution_history').all();
    assert.equal(history.results.length, 1);
    assert.equal(history.results[0].status, 'success');
    assert.equal(history.results[0].source, 'scheduled');
    assert.equal(history.results[0].scheduled_for, '2026-10-08T02:00:00.000Z');

    await worker.scheduled({ scheduledTime: atTen, cron: '* * * * *' });
    assert.equal(sends, 1, 'duplicate scheduled events must not send twice');
    await worker.scheduled({
      scheduledTime: Date.parse('2026-10-08T13:00:00Z'),
      cron: '* * * * *',
    });
    assert.equal(sends, 2, '21:00 remains a separate scheduled reminder');
  } finally {
    await mf.dispose();
  }
});
