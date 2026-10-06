#!/usr/bin/env python3
"""Сводка сессий агентов по workspace за окно времени: чаты Cursor и ручные сессии Codex."""
import argparse
import glob
import json
import os
import re
import time

CURSOR_PROJECTS = os.path.expanduser('~/.cursor/projects')
CODEX_SESSIONS = os.path.expanduser('~/.codex/sessions')
FIRST_QUERY_CHARS = 400
LAST_QUERY_CHARS = 300
LAST_REPLY_CHARS = 1200
GIT_LIST_LIMIT = 15
TIME_FORMAT = '%m-%d %H:%M'
SECONDS_PER_HOUR = 3600
GIT_WRITE = re.compile(
    r'git (?:commit|push|merge|rebase|cherry-pick|stash(?! list)|worktree add|checkout -b|switch -c)[^\n;&|]{0,70}'
    r'|deploy/deploy\.sh[^\n;&|]{0,40}'
)
USER_QUERY = re.compile(r'<user_query>(.*?)</user_query>', re.S)
CODEX_SERVICE_MARKERS = ('<environment_context>', 'AGENTS.md instructions', '<permissions', '<turn_aborted>')


def squash(text: str) -> str:
    return re.sub(r'\s+', ' ', text).strip()


def fmt(ts: float) -> str:
    return time.strftime(TIME_FORMAT, time.localtime(ts))


def read_jsonl(path: str):
    with open(path, encoding='utf-8') as f:
        for line in f:
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def cursor_chats(workspace: str, since: float) -> list[dict]:
    project_dir = re.sub(r'[^\w-]', '-', workspace.strip('/'))
    root = os.path.join(CURSOR_PROJECTS, project_dir, 'agent-transcripts')
    subagent_ids = {os.path.basename(p)[:-len('.jsonl')] for p in glob.glob(f'{root}/*/subagents/*.jsonl')}
    worktree_path = re.compile(re.escape(workspace) + r'-[\w-]+|\.cursor/worktrees/[\w/-]+')
    chats = []
    for chat_id in os.listdir(root):
        path = os.path.join(root, chat_id, f'{chat_id}.jsonl')
        if not os.path.exists(path) or chat_id in subagent_ids:
            continue
        stat = os.stat(path)
        if stat.st_mtime < since:
            continue
        queries, last_reply, git_writes, worktrees = [], '', [], set()
        for record in read_jsonl(path):
            role = record.get('role')
            for item in record.get('message', {}).get('content') or []:
                if not isinstance(item, dict):
                    continue
                if item.get('type') == 'text' and role == 'user':
                    queries += USER_QUERY.findall(item['text'])
                if item.get('type') == 'text' and role == 'assistant' and item['text'].strip() != '':
                    last_reply = item['text']
                if item.get('type') != 'tool_use':
                    continue
                tool_input = item.get('input', {})
                worktrees.update(worktree_path.findall(json.dumps(tool_input, ensure_ascii=False)))
                if item.get('name') == 'Shell':
                    git_writes += GIT_WRITE.findall(tool_input.get('command', ''))
        chats.append({
            'id': chat_id,
            'start': getattr(stat, 'st_birthtime', stat.st_ctime),
            'end': stat.st_mtime,
            'queries': queries,
            'last_reply': last_reply,
            'git_writes': git_writes,
            'worktrees': sorted(worktrees),
        })
    return sorted(chats, key=lambda c: c['start'])


def codex_text(payload: dict) -> str:
    return ' '.join(c.get('text', '') for c in payload.get('content', []) if isinstance(c, dict))


def codex_sessions(workspace: str, since: float) -> list[dict]:
    sessions = []
    for path in glob.glob(f'{CODEX_SESSIONS}/**/*.jsonl', recursive=True):
        if os.path.getmtime(path) < since:
            continue
        records = read_jsonl(path)
        meta = next(records, {}).get('payload', {})
        is_workspace = meta.get('cwd', '').startswith(workspace)
        is_manual = meta.get('thread_source') == 'user'
        if not is_workspace or not is_manual:
            continue
        queries, last_reply = [], ''
        for record in records:
            payload = record.get('payload', {})
            if payload.get('type') != 'message':
                continue
            text = codex_text(payload)
            if payload.get('role') == 'user' and not any(m in text for m in CODEX_SERVICE_MARKERS):
                queries.append(text)
            if payload.get('role') == 'assistant' and text.strip() != '':
                last_reply = text
        sessions.append({
            'path': path,
            'cwd': meta['cwd'],
            'end': os.path.getmtime(path),
            'queries': queries,
            'last_reply': last_reply,
        })
    return sorted(sessions, key=lambda s: s['end'])


def print_session(header: str, queries: list[str], last_reply: str) -> None:
    print(f'##### {header}')
    if len(queries) > 0:
        print('ПЕРВЫЙ ЗАПРОС:', squash(queries[0])[:FIRST_QUERY_CHARS])
        print('ПОСЛЕДНИЙ ЗАПРОС:', squash(queries[-1])[:LAST_QUERY_CHARS])
    print('ПОСЛЕДНИЙ ОТВЕТ:', squash(last_reply)[-LAST_REPLY_CHARS:])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--hours', type=float, required=True)
    parser.add_argument('--workspace', default=os.getcwd())
    args = parser.parse_args()
    workspace = os.path.abspath(args.workspace)
    now = time.time()
    since = now - args.hours * SECONDS_PER_HOUR

    for chat in cursor_chats(workspace, since):
        idle_minutes = int((now - chat['end']) / 60)
        print_session(
            f"cursor {chat['id']} {fmt(chat['start'])} → {fmt(chat['end'])} "
            f"(тишина {idle_minutes} мин, запросов {len(chat['queries'])})",
            chat['queries'],
            chat['last_reply'],
        )
        print('ПАПКИ:', chat['worktrees'])
        print('GIT И ВЫКЛАДКА:', chat['git_writes'][-GIT_LIST_LIMIT:])
        print()

    for session in codex_sessions(workspace, since):
        print_session(f"codex {session['path']} до {fmt(session['end'])} cwd={session['cwd']}",
                      session['queries'], session['last_reply'])
        print()


if __name__ == '__main__':
    main()
