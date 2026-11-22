"""Small staged official-CLI adapter; dry-run by default, no auth/SSH setup."""
import argparse
import contextlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess
import uuid

from common import atomic_json
from delegation import checked_bundle


class CliRejected(RuntimeError):
    def __init__(self, receipt):
        super().__init__('Orca rejected or could not prove operation; inspect saved authoritative receipt')
        self.receipt = receipt


def absolute(value):
    if not isinstance(value, str) or not value.startswith('/') or '\x00' in value or '..' in PurePosixPath(value).parts:
        raise ValueError('Reviewed absolute remote paths required')
    return value


def validate(bundle, target, settings, *, launch=False):
    checked_bundle(bundle)
    if target.get('enabled') is not True:
        raise ValueError('Orca delegation remains disabled until explicit onboarding acceptance')
    if settings.get('host') != 'compute' or target.get('host_alias') != settings['host']:
        raise ValueError('Only the explicitly verified free compute alias is supported')
    if not re.fullmatch(r'ssh:ssh-[A-Za-z0-9-]+', str(target.get('host_id', ''))):
        raise ValueError('Exact observed native SSH host ID required; paired runtimes unsupported')
    if (not target.get('setup_id') or not target.get('project_id') or 'dongbot' in target['project_id'].lower()
            or bundle['request'].get('orca_context', {}) != {'run_id': target.get('run_id'), 'task_id': target.get('task_id')}):
        raise ValueError('Exact approved setup/project and Coordinator-owned Task context required')
    for gate in ('strict_host_verified', 'remote_codex_authenticated', 'shared_policy_approved', 'task_spec_bound'):
        if target.get(gate) is not True:
            raise ValueError('Onboarding gate missing: ' + gate)
    if launch and (target.get('guarded_tui_adoption_verified') is not True or target.get('posix_shell_verified') is not True):
        raise ValueError('Live guarded-TUI adoption and POSIX-shell acceptance required before agent launch')
    for key in ('worktree_root', 'scripts', 'remote_bundle', 'state_root', 'python', 'codex'):
        absolute(target.get(key))
    if target.get('coordinator_handle') is not None and (not isinstance(target['coordinator_handle'], str)
            or not 1 <= len(target['coordinator_handle']) <= 512
            or any(ord(c) < 32 for c in target['coordinator_handle'])):
        raise ValueError('Exact own coordinator terminal handle required')
    if target['state_root'] != '/home/hyun/.local/state/shared-compute':
        raise ValueError('Both modes must use the verified shared state root')


def create_args(bundle, target):
    args = ['worktree', 'create', '--project-host-setup', target['setup_id'], '--name', bundle['orca_worktree_name'],
            '--base-branch', bundle['base_commit'], '--setup', 'skip']
    parent = target.get('parent_worktree_id')
    if parent:
        if '::' not in parent: raise ValueError('Full observed parent worktree ID required')
        args += ['--parent-worktree', 'worktree:' + parent]
    else:
        args += ['--no-parent']
    return args


def checked_worktree(row, bundle, target):
    path = absolute(row.get('path'))
    if (row.get('hostId') != target['host_id'] or row.get('projectHostSetupId') != target['setup_id']
            or row.get('projectId') != target['project_id'] or row.get('head') != bundle['base_commit']
            or row.get('isMainWorktree') is not False or row.get('isBare') is not False
            or row.get('id') != str(row.get('repoId')) + '::' + path
            or PurePosixPath(path) == PurePosixPath(target['worktree_root'])
            or not PurePosixPath(path).is_relative_to(PurePosixPath(target['worktree_root']))):
        raise ValueError('Returned worktree host/setup/base/ownership differs; preserve for inspection')
    branch = row.get('branch', '')
    if not branch.startswith('refs/heads/') or branch in ('refs/heads/main', 'refs/heads/master'):
        raise ValueError('Owned non-main branch required')
    return {k: row[k] for k in ('id', 'path', 'repoId', 'hostId', 'projectHostSetupId', 'projectId', 'head', 'branch')}


@contextlib.contextmanager
def receipt_lock(directory):
    """Exclusive nonblocking lock held through receipt checks and external calls."""
    path = directory / '.orca-adapter.lock'
    if path.is_symlink(): raise ValueError('Receipt lock link forbidden')
    fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    acquired = False
    try:
        if os.fstat(fd).st_size == 0: os.write(fd, b'0')
        os.lseek(fd, 0, os.SEEK_SET)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except OSError as exc:
            raise ValueError('Receipt busy; inspect same job, never launch concurrently') from exc
        yield
    finally:
        if acquired:
            if os.name == 'nt':
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def execute(bundle, target, settings, phase, directory, call):
    validate(bundle, target, settings, launch=phase == 'launch')
    directory = Path(directory).absolute()
    if directory.is_symlink() or directory.resolve() != directory:
        raise ValueError('Receipt directory must be exact without links')
    if phase == 'worktree':
        if directory.exists(): raise ValueError('New receipt directory required; reconcile uncertain calls, never retry automatically')
        directory.mkdir(mode=0o700, parents=True)
    elif phase != 'launch' or not directory.is_dir():
        raise ValueError('Existing launch receipt directory required')
    with receipt_lock(directory):
        return _execute_locked(bundle, target, settings, phase, directory, call)


def _execute_locked(bundle, target, settings, phase, directory, call):
    """call accepts argv only; production uses bounded subprocess, tests inject a mock."""
    validate(bundle, target, settings, launch=phase == 'launch')
    directory = Path(directory)
    receipt = directory / 'orca-receipt.json'
    if phase == 'worktree':
        state = {'job': bundle['job'], 'bundle_sha256': bundle['bundle_sha256'], 'target': target,
                 'stage': 'preflight', 'mode': 'native_ssh', 'commands': []}
    else:
        state = json.loads(receipt.read_text(encoding='utf-8'))
        if (state.get('stage') != 'awaiting_replay' or state['job'] != bundle['job']
                or state['bundle_sha256'] != bundle['bundle_sha256'] or state['target'] != target):
            raise ValueError('Receipt state/identity differs; inspect, never relaunch')

    def invoke(args, mutation=False):
        state['commands'].append({'argv': args, 'mutation': mutation, 'outcome': 'uncertain'})
        atomic_json(receipt, state)  # Persist before every possibly irreversible invocation.
        result = call([*args, '--json'])
        if not isinstance(result, dict): raise ValueError('Structured CLI result required')
        state['commands'][-1]['outcome'] = 'accepted'
        atomic_json(receipt, state)
        return result

    try:
        if target.get('coordinator_handle'):
            run = invoke(['orchestration', 'run-show', '--id', target['run_id']])['run']
            if run.get('id') != target['run_id'] or run.get('coordinator_handle') != target['coordinator_handle']:
                raise ValueError('Explicit sender does not match the observed Run coordinator; no mutation')
        setups = invoke(['project', 'setups', '--project', target['project_id'], '--host', target['host_id']])['setups']
        if not any(r.get('id') == target['setup_id'] and r.get('hostId') == target['host_id']
                   and r.get('projectId') == target['project_id'] and r.get('setupState') == 'ready' for r in setups):
            raise ValueError('Ready native SSH setup not observed; no mutation')
        if phase == 'worktree':
            before = {r['id'] for r in invoke(['worktree', 'list'])['worktrees']}
            state['stage'] = 'creating_worktree'; atomic_json(receipt, state)
            invoke(create_args(bundle, target), True)  # Do not assume unverified create response fields.
            rows = invoke(['worktree', 'list'])['worktrees']
            candidates = [r for r in rows if r['id'] not in before and r.get('hostId') == target['host_id']
                          and r.get('projectHostSetupId') == target['setup_id']
                          and bundle['orca_worktree_name'] in r.get('branch', '')]
            if len(candidates) != 1: raise ValueError('Unique newly owned worktree not provable; preserve residuals')
            state['worktree'] = checked_worktree(candidates[0], bundle, target)
            state['stage'] = 'awaiting_replay'
        else:
            w = state['worktree']
            replay = json.loads((directory / 'replay-receipt.json').read_text(encoding='utf-8'))
            expected = {'job':bundle['job'],'bundle_sha256':bundle['bundle_sha256'], 'base_commit':bundle['base_commit'],
                'input_manifest_sha256':bundle['input_manifest_sha256'], 'worktree':w['path'],
                'branch':w['branch'].removeprefix('refs/heads/'), 'replayed':True}
            if any(replay.get(k) != v for k, v in expected.items()): raise ValueError('Verified remote replay receipt required')
            rows = invoke(['worktree', 'list'])['worktrees']
            current = next((r for r in rows if r['id'] == w['id']), None)
            if current is None or checked_worktree(current, bundle, target) != w: raise ValueError('Worktree changed; return conflict')
            before = {r['handle'] for r in invoke(['terminal', 'list', '--worktree', 'id:' + w['id']])['terminals']}
            command = shlex.join([target['python'], target['scripts'] + '/agent_guard.py', '--root', target['state_root'],
                '--bundle', target['remote_bundle'], '--worktree', w['path'], '--expected-branch', expected['branch'], '--native-foreground', '--', target['codex'],
                '--no-daemon', '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request',
                '--disable', 'shell_snapshot', '-c', 'allow_login_shell=false',
                '-c', 'shell_environment_policy.set.CUDA_VISIBLE_DEVICES=' + json.dumps(','.join(map(str, bundle['resources']['gpus']))),
                '-c', 'shell_environment_policy.set.CUDA_DEVICE_ORDER="PCI_BUS_ID"',
                '--add-dir', target['state_root'] + '/' + bundle['job'] + '/outputs'])
            state['stage'] = 'creating_terminal'; atomic_json(receipt, state)
            invoke(['terminal','create','--worktree','id:'+w['id'],'--title',bundle['orca_worktree_name'],'--command',command], True)
            terms = invoke(['terminal','list','--worktree','id:'+w['id']])['terminals']
            candidates = [r for r in terms if r['handle'] not in before and r.get('worktreeId') == w['id']
                          and r.get('executionHostId') == target['host_id']]
            if len(candidates) != 1: raise ValueError('Unique guarded terminal not provable; no injection')
            term = candidates[0]
            incarnation = term.get('incarnationId')
            try:
                if not isinstance(incarnation, str) or str(uuid.UUID(incarnation)) != incarnation:
                    raise ValueError('Canonical UUID required')
            except (ValueError, AttributeError):
                raise ValueError('Nonempty valid terminal incarnation required; no injection')
            state['terminal_handle'] = term['handle']; state['terminal_incarnation'] = incarnation
            waited = invoke(['terminal','wait','--terminal',term['handle'],'--for','tui-idle','--timeout-ms','60000'])
            if waited.get('satisfied') is not True:
                raise ValueError('Terminal wait did not explicitly satisfy tui-idle; no injection')
            terms = invoke(['terminal','list','--worktree','id:'+w['id']])['terminals']
            if not any(r.get('handle') == term['handle'] and r.get('incarnationId') == state['terminal_incarnation']
                       and r.get('agentIdentity') in (None, 'codex') and r.get('connected') is True
                       and r.get('executionHostId') == target['host_id'] and r.get('worktreeId') == w['id'] for r in terms):
                raise ValueError('Exact guarded Codex incarnation/readiness not provable; no injection')
            state['stage'] = 'adopting_worker'; atomic_json(receipt, state)
            argv = ['orchestration','worker-start','--run',target['run_id'],'--task',target['task_id'],
                    '--worktree','id:'+w['id'],'--terminal',term['handle']]
            if target.get('coordinator_handle'):
                argv += ['--from', target['coordinator_handle']]
            result = invoke(argv, True)
            state['worker_start_receipt'] = result
            # Worker response fields are not inferred. Keep exact authoritative receipt for Coordinator reconciliation.
            state['stage'] = 'worker_receipt_requires_reconciliation'
        atomic_json(receipt, state)
        return state
    except BaseException as exc:
        state['failure'] = type(exc).__name__
        if isinstance(exc, CliRejected):
            state['cli_failure_receipt'] = exc.receipt
        state['recovery'] = 'Inspect the same receipts/residual worktree/terminal; no automatic retry, reset, cleanup or prompt resend'
        atomic_json(receipt, state)
        raise


def cli_call(executable, args):
    result = subprocess.run([executable, *args], capture_output=True, timeout=75)
    if len(result.stdout) > 8 * 1024 * 1024: raise ValueError('CLI metadata exceeds bound')
    data = json.loads(result.stdout)
    if result.returncode or data.get('ok') is not True: raise CliRejected(data)
    return data['result']


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', required=True); parser.add_argument('--target', required=True)
    parser.add_argument('--phase', choices=('worktree','launch'), required=True)
    parser.add_argument('--receipt-directory', required=True); parser.add_argument('--execute', action='store_true')
    parser.add_argument('--orca', default='C:/Users/dongh/AppData/Local/Programs/orca/resources/bin/orca.exe')
    args = parser.parse_args()
    bundle = json.loads(Path(args.bundle).read_text(encoding='utf-8-sig'))
    target = json.loads(Path(args.target).read_text(encoding='utf-8-sig'))
    from compute import config
    if not args.execute:
        checked_bundle(bundle)
        print(json.dumps({'execute':False,'phase':args.phase,'worktree_argv':create_args(bundle,target),
            'next':'Verify ready setup/auth/policy and exact replay receipt; explicitly execute staged adapter only after acceptance'}))
    else:
        print(json.dumps(execute(bundle,target,config(),args.phase,args.receipt_directory,lambda a:cli_call(args.orca,a)),indent=2))
