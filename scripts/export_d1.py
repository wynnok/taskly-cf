#!/usr/bin/env python3
"""Read a legacy SQLite database without writing it; export a standalone D1 SQL file."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
from datetime import datetime
from urllib.parse import quote, urlsplit
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
SERVER_TEMPLATE = json.dumps({'title': '{{title}}', 'desp': '{{content}}\n\n[查看详情]({{url}})'}, ensure_ascii=False)


def quote_sql(value):
    if value is None:
        return 'NULL'
    if isinstance(value, (int, float)):
        return str(value)
    # SQLite SQL text cannot contain a NUL; encode arbitrary text as UTF-8 hex.
    if '\x00' in str(value):
        return "CAST(X'" + str(value).encode().hex() + "' AS TEXT)"
    return "'" + str(value).replace("'", "''") + "'"


def insert(table, row):
    return f'INSERT INTO {table} ({",".join(row)}) VALUES ({",".join(quote_sql(v) for v in row.values())});'


def decode(value):
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return value


def migrate_password(stored, override=None):
    password = override if override is not None else decode(stored)
    if not isinstance(password, str) or not password:
        raise ValueError('No login password available; supply --password-env with the name of an environment variable.')
    if password.startswith('pbkdf2-sha256$100000$') and override is None:
        return password
    if override is None and password.startswith(('scrypt:', 'pbkdf2:', 'werkzeug:')):
        raise ValueError('Legacy password is hashed; supply --password-env to set a new Worker password.')
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 100000).hex()
    return f'pbkdf2-sha256$100000${salt.hex()}${digest}'


def export(source, output, password_override=None, serverchan_uid=None, serverchan_sendkey=None):
    source, output = Path(source).resolve(), Path(output).resolve()
    if source == output:
        raise ValueError('The output must not overwrite the source database.')
    if not source.is_file():
        raise FileNotFoundError(source)
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    conn = sqlite3.connect(f'file:{quote(str(source), safe="/")}?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute('BEGIN')  # consistent read snapshot, including WAL if present
        groups = [dict(r) for r in conn.execute('SELECT * FROM groups ORDER BY id')]
        tasks = [dict(r) for r in conn.execute('SELECT * FROM tasks ORDER BY id')]
        history = [dict(r) for r in conn.execute('SELECT * FROM execution_history ORDER BY id')]
        settings = {r['key']: r['value'] for r in conn.execute('SELECT key,value FROM settings')}
    finally:
        conn.close()
    time = datetime.now(ZoneInfo('Asia/Shanghai')).strftime('%Y-%m-%d %H:%M:%S')
    default = next((g for g in groups if g['name'] in ('默认', '默认分组')), None)
    if default:
        default['name'] = '默认'
    else:
        default = {'id': max((g['id'] for g in groups), default=0) + 1, 'name': '默认', 'icon': '📁', 'sort_order': 0, 'created_at': time, 'updated_at': time}
        groups.append(default)
    targets = decode(settings.get('webhook.targets', '[]')) or []
    if not isinstance(targets, list):
        raise ValueError('Legacy webhook.targets is not a list')
    used = set()
    for target in targets:
        target_id = target.get('id')
        if not isinstance(target_id, int) or target_id <= 0 or target_id in used:
            target_id = max(used, default=0) + 1
        target['id'] = target_id
        used.add(target_id)
    server = next((t for t in targets if t.get('name') == 'Server酱³' or (urlsplit(t.get('url', '')).hostname or '').endswith('.push.ft07.com')), None)
    if not server:
        server = {'id': max(used, default=0) + 1, 'name': 'Server酱³', 'method': 'post_json', 'url': '', 'template': SERVER_TEMPLATE, 'note': '在设置页填写完整推送地址，或设置 SERVERCHAN_UID/SERVERCHAN_SENDKEY secrets'}
        targets.insert(0, server)
    server['name'], server['provider'] = 'Server酱³', 'serverchan3'
    if serverchan_uid or serverchan_sendkey:
        if not (serverchan_uid and serverchan_sendkey):
            raise ValueError('Both Server酱³ UID and SendKey are required')
        server['url'] = f'https://{serverchan_uid}.push.ft07.com/send/{serverchan_sendkey}.send'
    legacy_url = decode(settings.get('webhook.base_url', ''))
    if legacy_url and not targets[0].get('url') == legacy_url and not any(t.get('name') == '原 Webhook 通道' for t in targets):
        legacy_id = max(t['id'] for t in targets) + 1
        params = str(decode(settings.get('webhook.default_params', '')) or '').lstrip('?')
        targets.append({'id': legacy_id, 'name': '原 Webhook 通道', 'method': 'get', 'url': str(legacy_url).rstrip('/') + '/{{title}}/{{content}}', 'template': params + ('&' if params else '') + 'url={{url}}', 'note': '保留原通道配置，迁移任务默认使用 Server酱³', 'provider': 'generic'})
    group_ids, target_ids = {g['id'] for g in groups}, {t['id'] for t in targets}
    # Source schema is older than the Worker schema; field allowlists discard retired settings.
    schema = (ROOT / 'migrations/0001_initial.sql').read_text().split('INSERT OR IGNORE INTO groups')[0]
    lines = ['-- Taskly production migration: import ONCE into an EMPTY D1 database.', '-- Includes private task data and login hashes; do not commit this file.', f'-- Source SHA256: {before}', 'PRAGMA foreign_keys = ON;', schema]
    # Fail on re-import or a nonempty destination; no upserts can silently replace production tasks.
    lines.extend([
        'CREATE TABLE _taskly_import_guard (count INTEGER CHECK(count=0));',
        'INSERT INTO _taskly_import_guard SELECT (SELECT COUNT(*) FROM tasks)+(SELECT COUNT(*) FROM groups)+(SELECT COUNT(*) FROM webhook_targets)+(SELECT COUNT(*) FROM settings)+(SELECT COUNT(*) FROM execution_history);',
    ])
    for g in groups:
        lines.append(insert('groups', {k: g[k] for k in ('id', 'sort_order', 'name', 'icon', 'created_at', 'updated_at')}))
    for t in targets:
        lines.append(insert('webhook_targets', {'id': t['id'], 'name': t['name'], 'method': t.get('method', 'get'), 'url': t.get('url', ''), 'template': t.get('template', ''), 'note': t.get('note', ''), 'provider': t.get('provider', 'generic')}))
    converted = 0
    for t in tasks:
        if t['channel'] != 'webhook':
            converted += 1
            t['webhook_id'] = server['id']
        elif t.get('webhook_id') not in target_ids:
            t['webhook_id'] = server['id']
        t['channel'] = 'webhook'
        if t.get('group_id') not in group_ids:
            t['group_id'] = default['id']
        if not t.get('tags'):
            t['tags'] = '[]'
        if not isinstance(decode(t['tags']), list):
            raise ValueError(f'Task {t["id"]} has invalid tags')
        for k in ('message', 'url'):
            t[k] = t.get(k) or ''
        lines.append(insert('tasks', {k: t[k] for k in ('id', 'title', 'message', 'url', 'cron_expression', 'channel', 'enabled', 'tags', 'group_id', 'webhook_id', 'created_at', 'updated_at')}))
    task_ids = {t['id'] for t in tasks}
    orphan_count = 0
    for h in history:
        legacy_id = h['task_id']
        if h['task_id'] not in task_ids:
            orphan_count += 1
            h['task_id'] = None
        row = {k: h[k] for k in ('id', 'task_id', 'status', 'error', 'executed_at')}
        row['legacy_task_id'] = legacy_id
        lines.append(insert('execution_history', row))
    password = migrate_password(settings.get('auth.password'), password_override)
    for key, value in {'auth.username': decode(settings.get('auth.username', '"admin"')), 'auth.password': password, 'auth.note': decode(settings.get('auth.note', '""'))}.items():
        lines.append(insert('settings', {'key': key, 'value': json.dumps(value, ensure_ascii=False), 'updated_at': time}))
    # Preserve high-water marks so deleted IDs are never accidentally reused.
    source_conn = sqlite3.connect(f'file:{quote(str(source), safe="/")}?mode=ro', uri=True)
    for table, seq in source_conn.execute("SELECT name,seq FROM sqlite_sequence WHERE name IN ('groups','tasks','execution_history')"):
        lines.append(f'UPDATE sqlite_sequence SET seq=MAX(seq,{int(seq)}) WHERE name={quote_sql(table)};')
    source_conn.close()
    lines.extend(['DROP TABLE _taskly_import_guard;', 'PRAGMA foreign_key_check;'])
    sql = '\n'.join(lines) + '\n'
    check = sqlite3.connect(':memory:')
    try:
        check.executescript(sql)
        if check.execute('PRAGMA foreign_key_check').fetchall():
            raise ValueError('Foreign key integrity check failed')
    finally:
        check.close()
    if hashlib.sha256(source.read_bytes()).hexdigest() != before:
        raise ValueError('Source database changed during export; retry from a stable backup')
    output.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as file:
        file.write(sql)
    os.chmod(output, 0o600)
    report = {'source_sha256': before, 'groups': len(groups), 'tasks': len(tasks), 'execution_history': len(history), 'deleted_task_history_preserved': orphan_count, 'converted_to_serverchan3': converted, 'serverchan_endpoint_configured': bool(server['url']), 'active_sessions_migrated': 0, 'output': str(output)}
    output.with_suffix('.report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', type=Path, default=ROOT / 'private/production.sql')
    parser.add_argument('--password-env', help='Environment variable containing a replacement login password')
    parser.add_argument('--serverchan-uid-env', help='Environment variable containing the Server酱³ UID')
    parser.add_argument('--serverchan-sendkey-env', help='Environment variable containing the Server酱³ SendKey')
    args = parser.parse_args()
    def env(name):
        if name and not os.environ.get(name):
            parser.error(f'Environment variable {name} is empty')
        return os.environ.get(name) if name else None
    report = export(args.source, args.output, env(args.password_env), env(args.serverchan_uid_env), env(args.serverchan_sendkey_env))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
