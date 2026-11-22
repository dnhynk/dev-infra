"""Linux PTY launcher for an existing remote agent, sharing command-mode admission.

This file is supplied for authorized server onboarding, not installed remotely by
the local wrapper. It never authenticates agents or starts Orca servers.
"""
import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import sys
import time

from common import atomic_json, read_regular
from delegation import checked_bundle, checked_worktree, git, marker_path
import remote


def group_resident_bytes(group):
    total = 0
    for proc in Path('/proc').iterdir():
        if not proc.name.isdecimal(): continue
        try:
            stat = (proc / 'stat').read_text().rsplit(')', 1)[1].split()
            if int(stat[2]) == group:
                total += int(stat[21]) * os.sysconf('SC_PAGE_SIZE')
        except (FileNotFoundError, ProcessLookupError, PermissionError): pass
    return total


def preflight(root, bundle, worktree, branch, command):
    checked_bundle(bundle)
    worktree = checked_worktree(worktree, bundle['base_commit'], branch)
    policy = remote.read_policy(root)
    if policy.get('allow_agent_guards') is not True:
        raise ValueError('Server agent guard onboarding is not approved')
    roots = policy.get('agent_worktree_roots', [])
    if (not isinstance(roots, list) or not roots
            or not any(Path(r).is_absolute() and Path(r).resolve() == Path(r)
                       and worktree.is_relative_to(Path(r)) and worktree != Path(r) for r in roots)):
        raise ValueError('Task worktree is outside approved agent roots')
    if (not isinstance(command, list) or not command or any(not isinstance(a, str) or '\x00' in a for a in command)
            or not Path(command[0]).is_absolute() or command[0] not in policy.get('agent_executables', [])):
        raise ValueError('Existing absolute agent executable must be explicitly approved')
    if Path(command[0]).name == 'codex' and '--no-daemon' not in command:
        raise ValueError('Codex must use --no-daemon so this guard owns its resource/process lifetime')
    from compute import SECRET_CONTENT
    if (SECRET_CONTENT.search(' '.join(command).encode()) or any(a in command for a in
            ('--dangerously-bypass-approvals-and-sandbox', '--yolo', '--dangerously-skip-permissions'))):
        raise ValueError('Secret or security-bypass agent arguments forbidden')
    marker = json.loads(marker_path(worktree).read_text())
    if any(marker.get(k) != bundle[k] for k in ('job', 'bundle_sha256', 'base_commit', 'input_manifest_sha256')):
        raise ValueError('Replay provenance differs')
    if marker.get('branch') != branch or marker.get('worktree') != str(worktree):
        raise ValueError('Replay worktree identity differs')
    for item in bundle['snapshot']['manifest']:
        data, _ = read_regular(worktree, item['path'])
        if len(data) != item['size'] or hashlib.sha256(data).hexdigest() != item['sha256']:
            raise ValueError('Replayed input changed before agent admission')
    if any((worktree / name).exists() for name in bundle['snapshot']['deleted']):
        raise ValueError('Replayed deletion differs')
    from compute import snapshot
    actual_input = snapshot(worktree)
    if (actual_input['manifest'] != bundle['snapshot']['manifest']
            or actual_input['deleted'] != bundle['snapshot']['deleted']
            or actual_input['excluded']):
        raise ValueError('Replayed input manifest differs before agent admission')
    for item in bundle['request'].get('shared_data', []):
        path = Path(item['path'])
        if (not item['read_only_verified'] or not path.is_absolute() or path.resolve() != path
                or path.is_relative_to(worktree) or not path.exists() or path.stat().st_mode & 0o222):
            raise ValueError('Shared immutable data must be verified read-only outside the worktree')
    return worktree, policy


def run(root, bundle, worktree, branch, command, *, stream=False, native_foreground=False):
    if not sys.platform.startswith('linux'):
        raise ValueError('Agent guard requires Linux PTY/affinity support')
    import pty
    import resource
    if native_foreground and (not os.isatty(0) or os.tcgetpgrp(0) != os.getpgrp()):
        raise ValueError('Native launch requires the owned foreground controlling terminal')
    root = remote.checked_root(Path(root))
    worktree, policy = preflight(root, bundle, worktree, branch, command)
    path = remote.job_path(root, bundle['job'])
    request = bundle['resources']
    with remote.locked(root):
        admission_observation = {}
        cpu_ids = remote.admission(root, policy, request, observation=admission_observation)
        if path.exists():
            raise ValueError('Job already exists; reconnect/inspect, never start a duplicate agent')
        path.mkdir(mode=0o700)
        (path / 'outputs').mkdir(mode=0o700)
        row = {'job': bundle['job'], 'mode': 'agent_delegation', **request, 'cpu_ids': cpu_ids,
            'state': 'running', 'created': time.time(), 'worker_pid': os.getpid(),
            'worktree': str(worktree), 'branch': branch, 'base_commit': bundle['base_commit'],
            'input_manifest_sha256': bundle['input_manifest_sha256'], 'bundle_sha256': bundle['bundle_sha256'],
            'orca_context': bundle['request'].get('orca_context', {}),
            'commit_allowed': bundle['commit_allowed'], 'admission_observation': admission_observation}
        atomic_json(path / 'job.json', row)
        atomic_json(path / 'log-meta.json', {'bytes': 0})
    pid = fd = None
    outcome = None
    written = 0
    deadline = time.monotonic() + request['timeout']
    prior_handlers = {}
    interrupted = []
    terminal_attributes = None
    stdout_blocking = None
    original_foreground = None
    pending_output = bytearray()
    forward_dropped = 0
    try:
        for sig in (signal.SIGTERM, signal.SIGINT):
            prior_handlers[sig] = signal.signal(sig, lambda *_: interrupted.append(True))
        if native_foreground:
            original_foreground = os.tcgetpgrp(0)
            prior_handlers[signal.SIGTTOU] = signal.signal(signal.SIGTTOU, signal.SIG_IGN)
            native_read, native_write = os.pipe()
            pid = os.fork()
        else:
            pid, fd = pty.fork()
        if pid == 0:
            try:
                if native_foreground:
                    os.setpgid(0, 0)
                    os.close(native_write)
                    if os.read(native_read, 1) != b'1': os._exit(127)
                    os.close(native_read)
                    signal.signal(signal.SIGTTOU, signal.SIG_DFL)
                    signal.signal(signal.SIGINT, signal.SIG_DFL)
                    signal.signal(signal.SIGTERM, signal.SIG_DFL)
                os.chdir(worktree)
                os.sched_setaffinity(0, cpu_ids)
                if not native_foreground:
                    resource.setrlimit(resource.RLIMIT_AS, (request['memory_mb'] * 1048576,) * 2)
                resource.setrlimit(resource.RLIMIT_CPU, (request['timeout'] * request['cpu'],) * 2)
                env = os.environ.copy()  # Existing remote login only; no local credentials supplied.
                # Bash sources ~/.bashrc when SSH_CLIENT is inherited even with login=False.
                # Keep Orca relay identity, but prevent shell init from overriding admission hints.
                for key in ('SSH_CLIENT', 'SSH2_CLIENT', 'SSH_CONNECTION', 'SSH_TTY', 'BASH_ENV', 'ENV'):
                    env.pop(key, None)
                env.update({k: str(request['cpu']) for k in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS')})
                env.update(CUDA_DEVICE_ORDER='PCI_BUS_ID', CUDA_VISIBLE_DEVICES=','.join(map(str, request['gpus'])),
                    SHARED_COMPUTE_JOB=bundle['job'], SHARED_COMPUTE_OUTPUT=str(path / 'outputs'),
                    SHARED_COMPUTE_MODE='agent_delegation')
                os.execve(command[0], command, env)
            except BaseException:
                os._exit(127)
        if native_foreground:
            os.close(native_read)
            try: os.setpgid(pid, pid)
            except PermissionError: pass  # Child may already have exec'd in its own group.
            os.tcsetpgrp(0, pid)
            os.write(native_write, b'1')
            os.close(native_write)
            row['terminal_transport'] = 'orca_native_pty'
            row['log_owner'] = 'orca_terminal_or_worker_read'
            row['memory_enforcement'] = 'aggregate_process_group_rss_poll_100ms'
            row['peak_resident_bytes'] = 0
        with remote.locked(root):
            row['process_group'] = pid
            atomic_json(path / 'job.json', row)
        if stream and not native_foreground and os.isatty(0):
            import fcntl
            import termios
            import tty
            terminal_attributes = termios.tcgetattr(0)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0' * 8))
            tty.setraw(0)
        if fd is not None: os.set_blocking(fd, False)
        if stream and not native_foreground:
            stdout_blocking = os.get_blocking(1)
            os.set_blocking(1, False)
        stop_at = None
        child_status = None
        stdin_open = stream
        with (path / 'stdout.log').open('xb+') as log:
            while True:
                if native_foreground and outcome is None:
                    resident = group_resident_bytes(pid)
                    row['peak_resident_bytes'] = max(row['peak_resident_bytes'], resident)
                    if resident > request['memory_mb'] * 1048576:
                        outcome = 'failed'
                        row.update(error='MemoryLimitExceeded', review_required=True)
                if outcome is None and (interrupted or (path / 'cancel').exists()):
                    outcome = 'cancelled'
                if outcome is None and time.monotonic() >= deadline:
                    outcome = 'timed_out'
                if outcome is not None and stop_at is None:
                    try: os.killpg(pid, signal.SIGTERM)
                    except ProcessLookupError: pass
                    stop_at = time.monotonic() + 1
                if stop_at is not None and time.monotonic() >= stop_at:
                    try: os.killpg(pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                if native_foreground:
                    exited, status = os.waitpid(pid, os.WNOHANG)
                    if exited:
                        child_status = status
                        try: os.killpg(pid, signal.SIGKILL)
                        except ProcessLookupError: pass
                        break
                    time.sleep(.1)
                    continue
                readable, writable, _ = select.select([fd, *([0] if stdin_open else [])],
                    [1] if stream and pending_output else [], [], 0.1)
                if 1 in writable:
                    try:
                        sent = os.write(1, pending_output)
                        del pending_output[:sent]
                    except BlockingIOError:
                        pass
                    except (BrokenPipeError, OSError):
                        # A disconnected reader must never prevent deadline/cancel supervision.
                        forward_dropped += len(pending_output)
                        pending_output.clear()
                        stream = False
                        stdin_open = False
                if stdin_open and 0 in readable:
                    data = os.read(0, 65536)
                    if data:
                        os.write(fd, data)
                    else:
                        stdin_open = False
                if fd in readable:
                    try: data = os.read(fd, 65536)
                    except OSError as exc:
                        if exc.errno != errno.EIO: raise
                        data = b''
                    if data:
                        with remote.locked(root):
                            cursor = written % remote.LOG_LIMIT
                            first = min(len(data), remote.LOG_LIMIT - cursor)
                            log.seek(cursor); log.write(data[:first])
                            if first < len(data): log.seek(0); log.write(data[first:])
                            log.flush(); written += len(data)
                            atomic_json(path / 'log-meta.json', {'bytes': written})
                        if stream:
                            pending_output.extend(data)
                            if len(pending_output) > 65536:
                                dropped = len(pending_output) - 65536
                                del pending_output[:dropped]
                                forward_dropped += dropped
                    elif child_status is not None:
                        break
                if child_status is None:
                    exited, status = os.waitpid(pid, os.WNOHANG)
                    if exited:
                        child_status = status
                        # Reap the child before releasing; do not leave descendants in its group.
                        try: os.killpg(pid, signal.SIGKILL)
                        except ProcessLookupError: pass
                if child_status is not None and fd not in readable:
                    break
        row.update(state=outcome or ('succeeded' if os.waitstatus_to_exitcode(child_status) == 0 else 'failed'),
                   exit_code=os.waitstatus_to_exitcode(child_status))
        row['result_commit'] = git(worktree, 'rev-parse', 'HEAD')
        row['worktree_dirty'] = bool(git(worktree, 'status', '--porcelain', '-z'))
        from compute import snapshot
        current = snapshot(worktree)
        before = {v['path']: v for v in bundle['snapshot']['manifest']}
        after = {v['path']: v for v in current['manifest']}
        row['modified_since_input'] = sorted(p for p in before.keys() | after.keys() if before.get(p) != after.get(p))
        scopes = bundle['request']['allowed_paths']
        if any(not any(p == scope or p.startswith(scope + '/') for scope in scopes) for p in row['modified_since_input']):
            row.update(state='failed', error='OutOfScopeEdits', review_required=True)
        if (git(worktree, 'branch', '--show-current') != branch
                or (row['result_commit'] != bundle['base_commit'] and not bundle['commit_allowed'])):
            row.update(state='failed', error='UnauthorizedBranchOrCommit', review_required=True)
    except BaseException as exc:
        row.update(state=outcome or 'failed', error=type(exc).__name__)
    finally:
        if pid is not None and pid > 0:
            try: os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError: pass
            try: os.waitpid(pid, 0)
            except ChildProcessError: pass
        if fd is not None: os.close(fd)
        if original_foreground is not None:
            os.tcsetpgrp(0, original_foreground)
        if stdout_blocking is not None:
            os.set_blocking(1, stdout_blocking)
        if terminal_attributes is not None:
            import termios
            termios.tcsetattr(0, termios.TCSADRAIN, terminal_attributes)
        for sig, handler in prior_handlers.items(): signal.signal(sig, handler)
        row['finished'] = time.time()
        row['terminal_output_dropped_bytes'] = forward_dropped + len(pending_output)
        with remote.locked(root):
            atomic_json(path / 'job.json', row)
            atomic_json(path / 'outputs/agent-provenance.json', {
                k: row.get(k) for k in ('job', 'mode', 'state', 'exit_code', 'worktree', 'branch', 'base_commit',
                    'input_manifest_sha256', 'bundle_sha256', 'cpu_ids', 'gpus', 'commit_allowed',
                    'orca_context',
                    'result_commit', 'worktree_dirty', 'modified_since_input', 'error', 'review_required')})
    return row


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=str(Path.home() / '.local/state/shared-compute'))
    parser.add_argument('--bundle', required=True)
    parser.add_argument('--worktree', required=True)
    parser.add_argument('--expected-branch', required=True)
    parser.add_argument('--native-foreground', action='store_true', help='Keep agent on Orca controlling PTY; supervisor retains admission/deadline ownership')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    result = run(args.root, json.loads(Path(args.bundle).read_text()), args.worktree, args.expected_branch, command, stream=True, native_foreground=args.native_foreground)
    raise SystemExit(result.get('exit_code', 1) if result['state'] == 'succeeded' else 1)
