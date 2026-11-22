"""Local CLI for shared compute over the owned SSH server; existing auth only."""
import argparse
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import sqlite3
import subprocess
import sys
import uuid

from common import JOB_RE, MAX_BYTES, MAX_FILES, atomic_json, pack, read_regular, safe_name, unpack, diagnostic_tail

WINDOWS_CONFIG = Path('C:/Users/dongh/.config/shared-compute/config.json')
BLOCKED_HOSTS = {'dongbot'}  # plus config 'blocked_hosts', which keeps private addresses out of the repo
SECRET_NAMES = ('.env*', '*.pem', '*.key', '*.p12', '*.pfx', '*credentials*',
                'id_rsa*', 'id_ed25519*', 'auth.json', '*.tfstate*',
                'secret', 'secrets', 'token', 'tokens', 'secret.*', 'secrets.*',
                'token.*', 'tokens.*', '*.secret', '*.secrets', '*.token', '*.tokens',
                '*_token.*', '*_tokens.*', '*-token.*', '*-tokens.*',
                '*_secret.*', '*_secrets.*', '*-secret.*', '*-secrets.*')
EXCLUDED_DIRS = {'.git', '.ssh', '.aws', '.codex', '.claude', 'node_modules',
                 '.venv', '__pycache__'}
SECRET_CONTENT = re.compile(
    rb'-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|(?:AKIA|ASIA)[A-Z0-9]{16}'
    rb'|(?:sk-(?:ant-|proj-)?|gh[pousr]_)[A-Za-z0-9_-]{20,}'
    rb'|(?i:(?:password|api[_-]?key|access[_-]?token|secret[_-]?key)\s*[:=]\s*["\x27]?[A-Za-z0-9+/_.-]{12,})')


def config():
    path = Path(os.environ.get('SHARED_COMPUTE_CONFIG',
                str(WINDOWS_CONFIG if os.name == 'nt' else Path.home() / '.config/shared-compute/config.json')))
    if not path.exists():
        return {'host': None}
    return json.loads(path.read_text(encoding='utf-8-sig'))


def checked_host(settings):
    host = settings.get('host')
    if not host:
        raise ValueError('Server unset: configure only the confirmed free-server SSH alias')
    if (not isinstance(host, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{0,252}', host)
            or host.lower() in BLOCKED_HOSTS | {h.lower() for h in settings.get('blocked_hosts', [])}):
        raise ValueError('Invalid or protected SSH target')
    return host


def snapshot(repo):
    repo = Path(repo).resolve(strict=True)
    result = subprocess.run(['git', '-C', str(repo), 'rev-parse', '--show-toplevel'],
                            capture_output=True, check=True)
    root = Path(os.fsdecode(result.stdout).strip()).resolve()
    if root != repo:
        raise ValueError('Snapshot requires the repository root')
    names = subprocess.run(['git', '-C', str(root), 'ls-files', '-z', '--cached',
                            '--others', '--exclude-standard'], capture_output=True, check=True).stdout
    unique = set(os.fsdecode(n).replace(os.sep, '/') for n in names.split(b'\x00') if n)
    index = subprocess.run(['git', '-C', str(root), 'ls-files', '--stage', '-z'],
                           capture_output=True, check=True).stdout
    modes = {}
    for entry in index.split(b'\x00'):
        if entry:
            metadata, name = entry.split(b'\t', 1)
            mode, _, stage = metadata.split()
            if stage != b'0':
                raise ValueError('Resolve merge conflicts before snapshotting')
            modes[os.fsdecode(name)] = 0o700 if mode == b'100755' else 0o600
    if len(unique) > MAX_FILES:
        raise ValueError('Snapshot file count exceeds limit')
    files, excluded, deleted = {}, [], []
    total = 0
    for name in sorted(unique):
        safe_name(name)
        parts = name.split('/')
        if (any(p.lower() in EXCLUDED_DIRS for p in parts)
                or any(fnmatch.fnmatch(parts[-1].lower(), pat) for pat in SECRET_NAMES)):
            excluded.append({'path': name, 'reason': 'name'})
            continue
        # Do not silently follow links even when their destination disappeared.
        try:
            data, info = read_regular(root, name, MAX_BYTES - total)
        except FileNotFoundError:
            deleted.append(name)
            continue
        if os.name != 'nt':
            modes[name] = info.st_mode
        if SECRET_CONTENT.search(data):
            excluded.append({'path': name, 'reason': 'content'})
            continue
        files[name] = data
        total += len(data)
    payload = pack(files, modes)
    payload.update(excluded=excluded, deleted=deleted, bytes=total,
                   manifest_sha256=hashlib.sha256(json.dumps(payload['manifest'], sort_keys=True).encode()).hexdigest())
    return payload


def transport(settings, request):
    host = checked_host(settings)
    scripts = Path(__file__).resolve().parent
    sources = {name: (scripts / name).read_text(encoding='utf-8') for name in ('common.py', 'remote.py')}
    bootstrap = (
        "import json,sys,types,os;os.environ['CUDA_DEVICE_ORDER']='PCI_BUS_ID';w=json.load(sys.stdin);s=w['sources'];"
        "m=types.ModuleType('common');sys.modules['common']=m;exec(s['common.py'],m.__dict__);"
        "n={'__name__':'shared_remote'};exec(s['remote.py'],n);"
        "n['rpc'](w['request'],s)"
    )
    remote_command = 'python3 -B -c ' + shlex.quote(bootstrap)
    ssh = 'C:/Windows/System32/OpenSSH/ssh.exe' if os.name == 'nt' else 'ssh'
    args = [ssh, '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10',
            '-o', 'ServerAliveCountMax=2', host, remote_command]
    result = subprocess.run(args, input=json.dumps({'request': request, 'sources': sources}).encode(),
                            capture_output=True, timeout=60)
    if result.returncode:
        # SSH may print user-controlled remote diagnostics; do not dump them automatically.
        raise RuntimeError(f'SSH failed (exit {result.returncode}); inspect target/authentication separately')
    if len(result.stdout) > MAX_BYTES * 2:
        raise ValueError('Remote response exceeds limit')
    response = json.loads(result.stdout)
    if not response.get('ok'):
        raise RuntimeError(response.get('error', 'Remote operation failed'))
    return response['data']


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    commands = p.add_subparsers(dest='action', required=True)
    status = commands.add_parser('status')
    status.add_argument('job', nargs='?')
    snap = commands.add_parser('snapshot')
    snap.add_argument('repo')
    routing = commands.add_parser('route', help='Recommend bounded command or isolated agent delegation, locally only')
    routing.add_argument('--request', required=True)
    delegate = commands.add_parser('delegate-prepare', help='Prepare sanitized input and a worker brief; never launch remotely')
    delegate.add_argument('repo')
    delegate.add_argument('--request', required=True)
    delegate.add_argument('--output', required=True)
    submit = commands.add_parser('submit')
    submit.add_argument('repo')
    submit.add_argument('--cpu', type=int, required=True, help='Workload-specific logical thread request')
    submit.add_argument('--memory-mb', type=int, required=True, help='Workload-specific RAM reservation in MiB')
    submit.add_argument('--timeout', type=int, required=True, help='Declared finite total job lifetime in seconds, including reporting')
    submit.add_argument('--gpu', type=int, action='append', default=[])
    for action in ('logs', 'cancel', 'fetch'):
        sub = commands.add_parser(action)
        sub.add_argument('job')
        if action == 'fetch':
            sub.add_argument('destination')
    return p


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    command = None
    if argv and argv[0] == 'submit' and '--' in argv:
        split = argv.index('--')
        command, argv = argv[split + 1:], argv[:split]
    args = parser().parse_args(argv)
    request = vars(args).copy()
    action = request['action']
    try:
        if action in ('route', 'delegate-prepare'):
            from delegation import route, prepare
            task_request = json.loads(Path(args.request).read_text(encoding='utf-8-sig'))
            data = route(task_request) if action == 'route' else prepare(args.repo, task_request, args.output, config())
        elif action == 'snapshot':
            data = snapshot(args.repo)
            del data['archive']
        else:
            settings = config()
            if action == 'status' and not settings.get('host'):
                data = {'configured': False, 'ready': False,
                        'reason': 'Confirmed free-server SSH alias and server policy required'}
            else:
                checked_host(settings)
                if request.get('job') and not JOB_RE.fullmatch(request['job']):
                    raise ValueError('Invalid job ID')
                if action == 'submit':
                    if not command:
                        raise ValueError('Use -- followed by the command argument list')
                    if any(n <= 0 for n in (args.cpu, args.memory_mb, args.timeout)):
                        raise ValueError('Resource requests must be positive')
                    if SECRET_CONTENT.search(' '.join(command).encode()):
                        raise ValueError('Secret-looking command argument forbidden')
                    request = dict(action='submit', job=uuid.uuid4().hex, command=command,
                                   cpu=args.cpu, memory_mb=args.memory_mb, timeout=args.timeout,
                                   gpus=args.gpu, snapshot=snapshot(args.repo))
                    # Persist an ID before transport: a timeout is not proof of failure.
                    receipts = Path(os.environ.get('SHARED_COMPUTE_STATE',
                                    str(WINDOWS_CONFIG.parent / 'jobs' if os.name == 'nt'
                                        else Path.home() / '.local/state/shared-compute-client/jobs')))
                    receipts.mkdir(parents=True, exist_ok=True)
                    receipt_path = receipts / (request['job'] + '.json')
                    atomic_json(receipt_path, {'job': request['job'], 'host': settings['host'],
                                             'manifest_sha256': request['snapshot']['manifest_sha256'],
                                             'submission': 'uncertain'})
                    print(json.dumps({'submitting_job': request['job']}), file=sys.stderr, flush=True)
                if action == 'fetch' and (Path(args.destination).exists() or Path(args.destination).is_symlink()):
                    raise ValueError('Fetch destination must be new')
                wire_request = {k: v for k, v in request.items() if k != 'destination'}
                data = transport(settings, wire_request)
                if action == 'logs':
                    data['text'] = diagnostic_tail(data.get('text', ''))
                if action in ('submit', 'logs', 'cancel', 'fetch') and data.get('job') != request['job']:
                    raise ValueError('Response job ID mismatch')
                if action == 'submit':
                    atomic_json(receipt_path, {'job': request['job'], 'host': settings['host'],
                                             'manifest_sha256': request['snapshot']['manifest_sha256'],
                                             'submission': 'accepted'})
                if action == 'fetch':
                    if data.get('job') != args.job:
                        raise ValueError('Response job ID mismatch')
                    if any(r['path'] == '_shared_compute_manifest.json' for r in data['result']['manifest']):
                        raise ValueError('Output collides with reserved fetch metadata name')
                    manifest = unpack(data['result'], args.destination)
                    atomic_json(Path(args.destination) / '_shared_compute_manifest.json',
                                {'job': args.job, 'files': manifest})
                    data = {'job': args.job, 'destination': str(Path(args.destination).resolve()), 'files': len(manifest)}
        print(json.dumps(data, indent=2))
        return 0
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError, KeyError, sqlite3.Error) as exc:
        print(json.dumps({'error': str(exc), 'action': action}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
