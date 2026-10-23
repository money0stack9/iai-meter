#!/usr/bin/env python3
"""Authorized self-host launcher.

Reads 0G management keys from a private owner-only JSON file and passes them
to iAI Meter only through the child process environment. Never prints keys.
"""
import argparse
import json
import os
import re
import stat
import sys

ENV_RE = re.compile(r'^[A-Z][A-Z0-9_]{0,63}$')
ALIAS_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$')
DENY_ENV = {'PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'TMPDIR', 'NODE_OPTIONS', 'NODE_PATH'}
DENY_PREFIX = ('NODE_', 'LD_', 'DYLD_', 'NPM_')
MAX_MAPPINGS = 20


def fail(msg='run-with-credentials: configuration error'):
    print(msg, file=sys.stderr)
    sys.exit(1)


class Parser(argparse.ArgumentParser):
    def error(self, message):
        fail('run-with-credentials: invalid arguments')


def read_json(path, private):
    if not os.path.isabs(path):
        raise ValueError
    if stat.S_ISLNK(os.lstat(path).st_mode):
        raise ValueError
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise ValueError
        if private and ((st.st_mode & 0o077) != 0 or st.st_uid != os.geteuid()):
            raise ValueError
        f = os.fdopen(fd, 'r', encoding='utf-8')
        fd = None
        with f:
            return json.load(f)
    finally:
        if fd is not None:
            os.close(fd)


def safe_env_name(name):
    return (isinstance(name, str) and ENV_RE.match(name) and name not in DENY_ENV
            and not name.startswith(DENY_PREFIX))


def main():
    if not hasattr(os, 'geteuid') or not hasattr(os, 'execve'):
        fail('run-with-credentials: unsupported platform')
    p = Parser(description='Run iAI Meter with management keys from a private file (self-host).')
    p.add_argument('--credentials-file', required=True)
    p.add_argument('--mapping-file', required=True)
    p.add_argument('--node', required=True)
    p.add_argument('--app', required=True)
    p.add_argument('--config', required=True)
    p.add_argument('--mode', choices=['status', 'serve', 'mcp'], default='status')
    p.add_argument('--port', type=int, default=8877)
    a = p.parse_args()

    try:
        if not (1 <= a.port <= 65535):
            raise ValueError
        for path in (a.node, a.app, a.config):
            if not os.path.isabs(path):
                raise ValueError
        if not (os.path.isfile(a.node) and os.access(a.node, os.X_OK)):
            raise ValueError
        cli = os.path.join(a.app, 'src', 'cli.js')
        if not (os.path.isdir(a.app) and os.path.isfile(cli) and os.path.isfile(a.config)):
            raise ValueError

        creds = read_json(a.credentials_file, private=True)
        mapping = read_json(a.mapping_file, private=False)
        if not isinstance(creds, dict) or not isinstance(mapping, dict):
            raise ValueError
        if len(mapping) > MAX_MAPPINGS:
            raise ValueError

        env = dict(os.environ)
        for name, alias in mapping.items():
            if not safe_env_name(name) or not (isinstance(alias, str) and ALIAS_RE.match(alias)):
                raise ValueError
            env.pop(name, None)
            entry = creds.get(alias)
            key = entry.get('management_key') if isinstance(entry, dict) else None
            if isinstance(key, str) and key.strip():
                key = key.strip()
                if any(ord(c) < 32 or ord(c) == 127 for c in key):
                    raise ValueError
                env[name] = key
            # absent key: env stays removed -> account reports unconfigured

        argv = [a.node, cli, a.mode, '--config', a.config]
        if a.mode == 'serve':
            argv += ['--port', str(a.port)]
        if a.mode == 'status':
            argv.append('--json')
    except Exception:
        fail()

    try:
        os.execve(a.node, argv, env)
    except Exception:
        fail('run-with-credentials: failed to start node')


if __name__ == '__main__':
    main()
