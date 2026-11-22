"""Local routing and sanitized replay preparation; never calls SSH or Orca."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import uuid

from common import JOB_RE, atomic_json, read_regular, safe_name, unpack


def git(root, *args):
    result = subprocess.run(['git', '-C', str(root), *args], capture_output=True, check=True)
    return os.fsdecode(result.stdout).strip()


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def route(request):
    mode = request.get('mode', 'auto')
    if mode not in ('auto', 'command', 'delegate'):
        raise ValueError('mode must be auto, command or delegate')
    flags = ('needs_edits', 'iterative', 'requires_judgment')
    if any(type(request.get(k, False)) is not bool for k in flags):
        raise ValueError('Routing flags must be booleans')
    chosen = mode if mode != 'auto' else ('delegate' if any(request.get(k, False) for k in flags) else 'command')
    return {'mode': chosen, 'reason': ('Use an isolated worker for editing/debugging/iterative judgment' if chosen == 'delegate'
            else 'A bounded command can run directly over the existing SSH backend'),
            'large_compute_alone_requires_agent': False, 'cloud_calls': False}


def validate_request(request):
    allowed_fields = {'mode', 'needs_edits', 'iterative', 'requires_judgment', 'objective', 'acceptance',
                      'resources', 'allowed_paths', 'commit_allowed', 'shared_data', 'orca_context'}
    if set(request) - allowed_fields:
        raise ValueError('Only documented task fields allowed; no credentials, host options or arbitrary environment')
    if route(request)['mode'] != 'delegate':
        raise ValueError('This task routes to command mode; use submit, not delegate-prepare')
    objective = request.get('objective')
    acceptance = request.get('acceptance')
    allowed = request.get('allowed_paths')
    if (not isinstance(objective, str) or not 1 <= len(objective) <= 10000
            or not isinstance(acceptance, list) or not acceptance
            or any(not isinstance(a, str) or not a.strip() or len(a) > 2000 for a in acceptance)
            or not isinstance(allowed, list) or not allowed):
        raise ValueError('Objective, observable acceptance and explicit owned paths required')
    for name in allowed:
        safe_name(name)
    resources = request.get('resources', {})
    if set(resources) != {'cpu', 'memory_mb', 'timeout', 'gpus'}:
        raise ValueError('Explicit shared CPU-thread, RAM, wall-time and GPU-index request required')
    if any(type(resources[k]) is not int or not 1 <= resources[k] <= 10**9 for k in ('cpu', 'memory_mb', 'timeout')):
        raise ValueError('Invalid positive resource request')
    if (not isinstance(resources['gpus'], list) or any(type(g) is not int or g < 0 for g in resources['gpus'])
            or len(set(resources['gpus'])) != len(resources['gpus'])):
        raise ValueError('GPU indexes must be unique nonnegative integers')
    if type(request.get('commit_allowed', False)) is not bool:
        raise ValueError('commit_allowed records existing task authority as a boolean')
    context = request.get('orca_context', {})
    if (not isinstance(context, dict) or set(context) - {'run_id', 'task_id'}
            or any(not re.fullmatch(r'(run|task)_[A-Za-z0-9_-]{1,80}', str(v))
                   or not v.startswith(k.removesuffix('_id') + '_') for k, v in context.items())):
        raise ValueError('Orca context accepts only exact observed Run/Task IDs; dispatch comes from live adoption')
    if not isinstance(request.get('shared_data', []), list):
        raise ValueError('Shared data must be a list of explicit immutable inputs')
    for data in request.get('shared_data', []):
        if (not isinstance(data, dict) or set(data) != {'path', 'sha256', 'read_only_verified'}
                or not isinstance(data['path'], str) or not data['path'].startswith('/')
                or '..' in Path(data['path']).parts or not re.fullmatch('[a-f0-9]{64}', str(data['sha256']))
                or type(data['read_only_verified']) is not bool):
            raise ValueError('Shared data needs an external absolute path, content hash and read-only evidence')
    return resources


def prepare(repo, request, destination, settings=None):
    from compute import snapshot, SECRET_CONTENT
    resources = validate_request(request)
    if SECRET_CONTENT.search(json.dumps(request).encode()):
        raise ValueError('Secret-looking task input forbidden')
    repo = Path(repo).resolve(strict=True)
    destination = Path(destination).absolute()
    if destination.exists() or destination.is_symlink():
        raise ValueError('Delegation output directory must be new')
    base = git(repo, 'rev-parse', 'HEAD')
    if not re.fullmatch('[a-f0-9]{40}|[a-f0-9]{64}', base):
        raise ValueError('A committed Git base is required')
    tracked = set(git(repo, 'ls-files', '-z').split('\x00'))
    snap = snapshot(repo)
    if any(row['path'] in tracked for row in snap['excluded']):
        raise ValueError('Tracked excluded/secret input requires a separately sanitized Git base; never transfer history or credentials')
    dirty = bool(git(repo, 'status', '--porcelain', '-z'))
    if base != git(repo, 'rev-parse', 'HEAD'):
        raise ValueError('Git base changed while preparing; inspect and prepare again')
    job = uuid.uuid4().hex
    request = json.loads(json.dumps(request))
    blockers = ['Confirmed free-server SSH alias, strict host verification and approved shared server policy required',
                'Ready Orca SSH project setup and independently authenticated remote Codex required',
                'Guarded terminal readiness/lifecycle adoption needs live acceptance before dispatch']
    if any(not item['read_only_verified'] for item in request.get('shared_data', [])):
        blockers.append('Shared data read-only verification pending')
    bundle = {'schema_version': 1, 'mode': 'agent_delegation', 'job': job, 'base_commit': base,
        'input_manifest_sha256': snap['manifest_sha256'], 'snapshot': snap, 'request': request,
        'resources': resources, 'dirty_input': dirty,
        'commit_allowed': bool(request.get('commit_allowed') and not dirty),
        'commit_rule': 'Dirty input: return changes relative to the input manifest; no inherited-change commit without separate baseline authority' if dirty
                       else 'Commit only when existing task authority permits; never push or merge automatically',
        'orca_worktree_name': 'COMPUTE-' + job[:12], 'host_alias': (settings or {}).get('host'),
        'live_ready': False, 'blockers': blockers}
    bundle['bundle_sha256'] = fingerprint(bundle)
    destination.mkdir(mode=0o700, parents=True)
    atomic_json(destination / 'bundle.json', bundle)
    prompt = ('COMPUTE task\n' + request['objective'] + '\n\nAcceptance:\n- ' + '\n- '.join(request['acceptance'])
        + '\n\nOwned paths: ' + ', '.join(request['allowed_paths'])
        + '\nBase commit: ' + base + '\nInput manifest: ' + snap['manifest_sha256']
        + '\nJob: ' + job + '\n' + bundle['commit_rule']
        + '\nRecord exact Orca Run/Task/Dispatch/worktree/branch IDs from live context; never invent them.'
        + '\nReplay only into a new clean task-owned remote worktree. Use the shared agent guard before work.'
        + '\nShared immutable data stays outside worktrees; do not copy credentials or change authentication.'
        + '\nReport edits relative to the input, tests/results, resource usage, commit SHA if authorized, and conflicts.'
        + '\nWrite the report and any reviewed patch relative to input into SHARED_COMPUTE_OUTPUT. The guard never commits, pushes or merges for you.'
        + '\nReturn to the supervising Coordinator; no push, merge, production migration or nested dispatch without task authority.\n')
    (destination / 'task.txt').write_text(prompt, encoding='utf-8')
    return {'job': job, 'directory': str(destination), 'bundle_sha256': bundle['bundle_sha256'],
            'input_manifest_sha256': snap['manifest_sha256'], 'base_commit': base, 'dirty_input': dirty,
            'commit_allowed': bundle['commit_allowed'], 'blockers': blockers, 'live_ready': False,
            'remote_mutations': False, 'orca_commands_executed': False}


def checked_bundle(bundle):
    unsigned = dict(bundle)
    expected = unsigned.pop('bundle_sha256', None)
    if (bundle.get('schema_version') != 1 or bundle.get('mode') != 'agent_delegation'
            or not JOB_RE.fullmatch(str(bundle.get('job', ''))) or fingerprint(unsigned) != expected):
        raise ValueError('Delegation bundle identity/hash differs')
    validate_request(bundle['request'])
    if bundle['resources'] != bundle['request']['resources']:
        raise ValueError('Delegation resources differ')
    if hashlib.sha256(json.dumps(bundle['snapshot']['manifest'], sort_keys=True).encode()).hexdigest() != bundle['input_manifest_sha256']:
        raise ValueError('Input manifest hash differs')
    return bundle


def marker_path(worktree):
    path = Path(git(worktree, 'rev-parse', '--git-path', 'shared-compute-input.json'))
    return path if path.is_absolute() else worktree / path


def checked_worktree(worktree, base, expected_branch):
    worktree = Path(worktree).absolute()
    if worktree.is_symlink() or worktree.resolve() != worktree:
        raise ValueError('Task worktree path must be absolute without links')
    if Path(git(worktree, 'rev-parse', '--show-toplevel')).resolve() != worktree:
        raise ValueError('Exact worktree root required')
    if not (worktree / '.git').is_file():
        raise ValueError('Replay requires an isolated linked Git worktree, never the main checkout')
    if (git(worktree, 'rev-parse', 'HEAD') != base or git(worktree, 'branch', '--show-current') != expected_branch
            or not expected_branch or expected_branch in ('main', 'master')):
        raise ValueError('Base/owned branch differs; hand off conflict without resetting')
    return worktree


def replay(bundle, worktree, expected_branch):
    checked_bundle(bundle)
    worktree = checked_worktree(worktree, bundle['base_commit'], expected_branch)
    if git(worktree, 'status', '--porcelain', '-z') or marker_path(worktree).exists():
        raise ValueError('Replay requires a new clean worktree; inspect conflicts instead of overwriting')
    snap = bundle['snapshot']
    tracked = set(git(worktree, 'ls-files', '-z').split('\x00'))
    if any(row['path'] in tracked for row in snap['excluded']):
        raise ValueError('Remote base contains excluded tracked files; sanitize independently')
    with tempfile.TemporaryDirectory() as temporary:
        incoming = Path(temporary) / 'input'
        unpack(snap, incoming)  # Verify the complete archive before touching the worktree.
        for item in snap['manifest']:
            name = item['path']; safe_name(name)
            target = worktree / name
            for parent in (target, *target.parents):
                if parent == worktree:
                    break
                if parent.is_symlink():
                    raise ValueError('Replay target link forbidden')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(read_regular(incoming, name)[0])
            target.chmod(item.get('mode', 0o600))
        for name in snap['deleted']:
            safe_name(name)
            if name in tracked:
                target = worktree / name
                read_regular(worktree, name)
                target.unlink()
    marker = {'job': bundle['job'], 'bundle_sha256': bundle['bundle_sha256'],
              'base_commit': bundle['base_commit'], 'input_manifest_sha256': bundle['input_manifest_sha256'],
              'branch': expected_branch, 'worktree': str(worktree)}
    atomic_json(marker_path(worktree), marker)
    return {**marker, 'replayed': True, 'commits_created': False, 'pushed_or_merged': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', required=True)
    parser.add_argument('--worktree', required=True)
    parser.add_argument('--expected-branch', required=True)
    args = parser.parse_args()
    print(json.dumps(replay(json.loads(Path(args.bundle).read_text(encoding='utf-8-sig')), args.worktree, args.expected_branch), indent=2))
