import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('export_d1', Path(__file__).resolve().parents[1] / 'scripts/export_d1.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MigrationTest(unittest.TestCase):
    def test_production_style_database_is_preserved_and_export_imports_once(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / 'tasks.db', Path(directory) / 'production.sql'
            c = sqlite3.connect(source)
            c.executescript('''
                CREATE TABLE groups(id INTEGER PRIMARY KEY AUTOINCREMENT, sort_order INTEGER, name TEXT, icon TEXT, created_at TEXT, updated_at TEXT);
                CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT,message TEXT,url TEXT,cron_expression TEXT,channel TEXT,enabled INTEGER,tags TEXT,group_id INTEGER,created_at TEXT,updated_at TEXT);
                CREATE TABLE execution_history(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id INTEGER,status TEXT,error TEXT,executed_at TEXT);
                CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT);
                CREATE TABLE sessions(session_id TEXT);
                INSERT INTO groups VALUES(1,0,'默认','folder','2026-01-01 00:00:00','2026-01-01 00:00:00');
                INSERT INTO tasks VALUES(2,'测试''标题','第 {{var_monthly_count}} 次','https://example.com','0 10,21 28 * *','email',1,'["test"]',999,'2026-01-01 00:00:00','2026-01-01 00:00:00');
                INSERT INTO execution_history VALUES(1,2,'success',NULL,'2026-09-01 10:00:00');
                INSERT INTO execution_history VALUES(2,999,'failed','old failure','2026-09-02 10:00:00');
                INSERT INTO settings VALUES('auth.username','"admin"','2026-01-01');
                INSERT INTO settings VALUES('auth.password','"original-password"','2026-01-01');
                INSERT INTO settings VALUES('smtp.password','"sensitive-retired-secret"','2026-01-01');
                INSERT INTO settings VALUES('webhook.base_url','"https://example.com/legacy"','2026-01-01');
                INSERT INTO sessions VALUES('old-session-token');
                UPDATE sqlite_sequence SET seq=42 WHERE name='tasks';
            ''')
            c.close()
            before = hashlib.sha256(source.read_bytes()).hexdigest()
            report = migration.export(source, output)
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), before)
            self.assertEqual(report['tasks'], 1)
            self.assertEqual(report['execution_history'], 2)
            self.assertEqual(report['deleted_task_history_preserved'], 1)
            sql = output.read_text()
            self.assertNotIn('sensitive-retired-secret', sql)
            self.assertNotIn('original-password', sql)
            self.assertNotIn('old-session-token', sql)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            d = sqlite3.connect(':memory:')
            d.executescript(sql)
            self.assertEqual(d.execute('PRAGMA foreign_key_check').fetchall(), [])
            self.assertEqual(d.execute('SELECT title,channel,webhook_id,group_id FROM tasks').fetchone(), ("测试'标题", 'webhook', 1, 1))
            self.assertEqual(d.execute('SELECT name FROM webhook_targets WHERE id=1').fetchone()[0], 'Server酱³')
            self.assertEqual(d.execute('SELECT task_id,legacy_task_id FROM execution_history WHERE id=2').fetchone(), (None, 999))
            self.assertEqual(d.execute("SELECT seq FROM sqlite_sequence WHERE name='tasks'").fetchone()[0], 42)
            stored = json.loads(d.execute("SELECT value FROM settings WHERE key='auth.password'").fetchone()[0])
            _, iterations, salt, digest = stored.split('$')
            self.assertEqual(hashlib.pbkdf2_hmac('sha256', b'original-password', bytes.fromhex(salt), int(iterations)).hex(), digest)
            with self.assertRaises(sqlite3.IntegrityError):
                d.executescript(sql)
            d.close()

    def test_existing_password_hash_requires_explicit_replacement(self):
        with self.assertRaises(ValueError):
            migration.migrate_password('"scrypt:32768:8:1$salt$hash"')
        self.assertTrue(migration.migrate_password('"scrypt:32768:8:1$salt$hash"', 'new-password').startswith('pbkdf2-sha256$'))

    def test_sql_quote_handles_unicode_apostrophes_and_nul(self):
        d = sqlite3.connect(':memory:')
        for value in ["测试'内容", 'hello\x00world', '\\line\nnext']:
            self.assertEqual(d.execute('SELECT ' + migration.quote_sql(value)).fetchone()[0], value)
        d.close()


if __name__ == '__main__':
    unittest.main()
