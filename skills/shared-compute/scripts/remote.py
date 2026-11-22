"""Linux-only job supervisor. Executed over authenticated SSH, never installed locally."""
import contextlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

from common import JOB_RE, MAX_BYTES, atomic_json, pack, read_regular, regular_path, unpack

TERMINAL = {'succeeded', 'failed', 'cancelled', 'timed_out'}
LOG_LIMIT = 4 * 1024 * 1024


def checked_root(root):
    root = Path(root)
    if not root.is_absolute() or root.is_symlink() or root.resolve() != root:
        raise ValueError('Server state root must be an absolute path without links')
    st = root.stat()
    if st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise ValueError('Server state root must be private and owned by this user')
    return root


def read_policy(root):
    path = regular_path(root, 'policy.json')
    st = path.stat()
    if st.st_uid != os.getuid() or st.st_mode & 0o022:
        raise ValueError('Policy must be owned by user and not writable by others')
    policy = json.loads(path.read_text())
    mode = policy.get('capacity_mode', 'fixed')
    if mode not in ('fixed', 'adaptive'):
        raise ValueError('Invalid capacity mode')
    if mode == 'adaptive':
        if any(key in policy for key in ('cpu', 'memory_mb', 'max_timeout', 'max_jobs')):
            raise ValueError('Adaptive policy must not retain invented fixed capacity caps')
    else:
        for key in ('cpu', 'memory_mb', 'max_timeout', 'max_jobs'):
            if type(policy.get(key)) is not int or policy[key] < 1:
                raise ValueError(f'Invalid server policy {key}')
    if (not isinstance(policy.get('gpus'), list)
            or any(type(g) is not int or g < 0 for g in policy['gpus'])
            or len(set(policy['gpus'])) != len(policy['gpus'])):
        raise ValueError('Invalid server policy gpus')
    gpu_limits = ('gpu_idle_max_memory_mb', 'gpu_idle_max_utilization_percent')
    if any(key in policy for key in gpu_limits):
        if (not all(type(policy.get(key)) is int and policy[key] >= 0 for key in gpu_limits)
                or policy['gpu_idle_max_utilization_percent'] > 100):
            raise ValueError('Invalid external GPU occupancy limits')
    return policy


@contextlib.contextmanager
def locked(root):
    import fcntl
    if (root / 'admission.lock').is_symlink():
        raise ValueError('Unsafe lock')
    fd = os.open(root / 'admission.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def job_path(root, job):
    if not JOB_RE.fullmatch(job):
        raise ValueError('Invalid job ID')
    path = root / job
    if path.is_symlink() or (path.exists() and path.resolve() != path):
        raise ValueError('Unsafe job directory')
    return path


def alive(pid):
    if type(pid) is not int or pid <= 1:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def record(path):
    row = json.loads(regular_path(path, 'job.json').read_text())
    if row['state'] not in TERMINAL and not alive(row.get('worker_pid')):
        return dict(row, state='orphaned')
    return row


def inventory(root):
    return [record(job_path(root, p.name)) for p in sorted(root.iterdir())
            if JOB_RE.fullmatch(p.name)]


def gpu_occupancy_admission(policy, gpus):
    if not gpus or 'gpu_idle_max_memory_mb' not in policy:
        return
    try:
        result = subprocess.run(['nvidia-smi', '--id=' + ','.join(map(str, gpus)),
            '--query-gpu=index,memory.used,utilization.gpu', '--format=csv,noheader,nounits'],
            capture_output=True, text=True, check=True, timeout=5)
        rows = {}
        for line in result.stdout.splitlines():
            index, memory, utilization = [int(value.strip()) for value in line.split(',')]
            if index in rows or min(index, memory, utilization) < 0 or utilization > 100:
                raise ValueError('Invalid GPU occupancy')
            rows[index] = memory, utilization
        if set(rows) != set(gpus):
            raise ValueError('Missing requested GPU occupancy')
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        raise ValueError('GPU occupancy unavailable; no admission') from exc
    if any(memory > policy['gpu_idle_max_memory_mb'] or utilization > policy['gpu_idle_max_utilization_percent']
           for memory, utilization in rows.values()):
        raise ValueError('External GPU resources busy; no admission')


def capacity_snapshot():
    affinity = sorted(os.sched_getaffinity(0))
    def counters():
        result = {}
        for line in Path('/proc/stat').read_text().splitlines():
            fields = line.split()
            if fields and fields[0].startswith('cpu') and fields[0][3:].isdigit():
                values = [int(value) for value in fields[1:9]]
                if len(values) != 8:
                    raise ValueError('Incomplete CPU capacity metadata')
                result[int(fields[0][3:])] = sum(values), values[3] + values[4]
        return result
    before = counters()
    time.sleep(.1)  # Read-only utilization sample, not a job or a fixed capacity cap.
    after = counters()
    idle = {}
    for cpu in affinity:
        total = after[cpu][0] - before[cpu][0]
        available = after[cpu][1] - before[cpu][1]
        if total < 0 or available < 0:
            raise ValueError('CPU capacity metadata changed unexpectedly')
        idle[cpu] = min(1.0, available / total) if total else 1.0
    memory = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key = line.split(':', 1)[0]
        if key in ('MemTotal', 'MemAvailable'):
            memory[key] = int(line.split()[1]) // 1024
    if not affinity or not 0 <= memory['MemAvailable'] <= memory['MemTotal']:
        raise ValueError('Available hardware metadata missing or invalid')
    return {'cpu_ids': affinity, 'cpu_idle_fraction': idle,
            'memory_total_mb': memory['MemTotal'], 'memory_available_mb': memory['MemAvailable']}


def active_group_resident_mb(active):
    groups = {row.get('process_group'): row['job'] for row in active
              if type(row.get('process_group')) is int and row['process_group'] > 1}
    resident = {row['job']: 0 for row in active}
    for process in Path('/proc').iterdir():
        if not process.name.isdecimal():
            continue
        try:
            if process.stat().st_uid != os.getuid():
                continue
            fields = (process / 'stat').read_text().rsplit(')', 1)[1].split()
            job = groups.get(int(fields[2]))
            if job is not None:
                resident[job] += max(0, int(fields[21])) * os.sysconf('SC_PAGE_SIZE')
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            pass
    # Round down measured consumption: slightly over-reserve the still-pending part.
    return {job: amount // 1048576 for job, amount in resident.items()}


def admission(root, policy, request, *, observation=None):
    adaptive = policy.get('capacity_mode') == 'adaptive'
    for key in ('cpu', 'memory_mb', 'timeout'):
        if type(request.get(key)) is not int or request[key] < 1:
            raise ValueError('Explicit positive CPU, RAM and finite job deadline required')
    if request['timeout'] > 2**31 - 1:
        raise ValueError('Job deadline exceeds portable finite timer representation')
    if not adaptive:
        for key, ceiling in (('cpu', policy['cpu']), ('memory_mb', policy['memory_mb']),
                             ('timeout', policy['max_timeout'])):
            if request[key] > ceiling:
                raise ValueError(f'Request exceeds policy: {key}')
    gpus = request.get('gpus')
    if (not isinstance(gpus, list) or len(gpus) != len(set(gpus))
            or any(type(g) is not int or g not in policy['gpus'] for g in gpus)):
        raise ValueError('Requested GPUs not permitted')
    rows = inventory(root)
    if any(row['state'] == 'orphaned' for row in rows):
        raise ValueError('Orphaned job: inspect server processes before more submissions')
    active = [row for row in rows if row['state'] not in TERMINAL]
    if set(gpus).intersection(g for row in active for g in row['gpus']):
        raise ValueError('Server wrapper resources busy')
    used_cpu_ids = {cpu for row in active for cpu in row.get('cpu_ids', [])}
    if adaptive:
        snapshot = capacity_snapshot()
        if request['cpu'] > len(snapshot['cpu_ids']) or request['memory_mb'] > snapshot['memory_total_mb']:
            raise ValueError('Request exceeds actual free-host hardware capacity')
        # A legacy/malformed reservation cannot safely reveal which slots remain free.
        if any(len(row.get('cpu_ids', [])) != row['cpu'] for row in active):
            raise ValueError('Existing CPU reservation identity incomplete; inspect before admission')
        if sum(row['cpu'] for row in active) + request['cpu'] > len(snapshot['cpu_ids']):
            raise ValueError('Reservations exceed actual hardware thread count')
        available = [cpu for cpu in snapshot['cpu_ids'] if cpu not in used_cpu_ids]
        idle_slots = max(0, min(len(available), round(sum(snapshot['cpu_idle_fraction'][cpu] for cpu in available))))
        resident = active_group_resident_mb(active)
        pending_ram = sum(max(0, row['memory_mb'] - resident.get(row['job'], 0)) for row in active)
        physical_unreserved_ram = max(0, snapshot['memory_total_mb'] - sum(row['memory_mb'] for row in active))
        available_ram = min(physical_unreserved_ram, max(0, snapshot['memory_available_mb'] - pending_ram))
        if request['cpu'] > idle_slots or request['memory_mb'] > available_ram:
            raise ValueError('Current available hardware or ongoing reservations busy; no admission')
        available.sort(key=lambda cpu: (-snapshot['cpu_idle_fraction'][cpu], cpu))
        details = {'capacity_mode': 'adaptive', 'logical_threads': len(snapshot['cpu_ids']),
            'memory_total_mb': snapshot['memory_total_mb'], 'memory_available_mb': snapshot['memory_available_mb'],
            'currently_idle_unreserved_slots_estimate': idle_slots, 'available_after_pending_reservations_mb': available_ram,
            'pending_ram_reservations_mb': pending_ram, 'active_job_count': len(active),
            'reserved_cpu_ids': sorted(used_cpu_ids), 'declared_timeout_seconds': request['timeout']}
    else:
        if (len(active) >= policy['max_jobs']
                or sum(row['cpu'] for row in active) + request['cpu'] > policy['cpu']
                or sum(row['memory_mb'] for row in active) + request['memory_mb'] > policy['memory_mb']):
            raise ValueError('Server wrapper resources busy')
        affinity = sorted(os.sched_getaffinity(0))
        if request['cpu'] > len(affinity):
            raise ValueError('CPU request exceeds current affinity')
        available = sorted(set(affinity[:policy['cpu']]) - used_cpu_ids)
        details = {'capacity_mode': 'fixed', 'declared_timeout_seconds': request['timeout']}
    if len(available) < request['cpu']:
        raise ValueError('Reserved CPU affinity unavailable')
    gpu_occupancy_admission(policy, gpus)
    if observation is not None:
        observation.update(details)
    return available[:request['cpu']]


def dispatch(root, request, sources=None):
    root = checked_root(root)
    policy = read_policy(root)
    action = request['action']
    if action == 'status':
        with locked(root):
            rows = ([record(job_path(root, request['job']))] if request.get('job')
                    else inventory(root))
        result = {'policy': policy, 'jobs': rows, 'ready': not any(r['state'] == 'orphaned' for r in rows)}
        if policy.get('capacity_mode') == 'adaptive':
            result['capacity'] = capacity_snapshot()
            result['capacity']['outside_usage_not_isolated'] = True
        return result
    path = job_path(root, request['job'])
    if action == 'submit':
        command = request.get('command')
        if (not isinstance(command, list) or not command
                or any(not isinstance(a, str) or '\x00' in a for a in command)):
            raise ValueError('Command must be a nonempty argument list')
        with locked(root):
            admission_observation = {}
            cpu_ids = admission(root, policy, request, observation=admission_observation)
            if path.exists():
                raise ValueError('Job ID already exists; inspect its status')
            path.mkdir(mode=0o700)
            row = {k: request[k] for k in ('job', 'command', 'cpu', 'memory_mb', 'timeout', 'gpus')}
            row.update(state='queued', created=time.time(), cpu_ids=cpu_ids, admission_observation=admission_observation)
            try:
                unpack(request['snapshot'], path / 'workspace')
                (path / 'outputs').mkdir(mode=0o700)
                atomic_json(path / 'manifest.json', request['snapshot']['manifest'])
                if not sources:
                    sources = {n: Path(__file__).with_name(n).read_text()
                               for n in ('common.py', 'remote.py')}
                for name in ('common.py', 'remote.py'):
                    (path / name).write_text(sources[name])
                atomic_json(path / 'job.json', row)
                with (path / 'supervisor.log').open('xb') as log:
                    worker = subprocess.Popen([sys.executable, '-B', str(path / 'remote.py'),
                                               '--worker', str(path)],
                                              stdin=subprocess.DEVNULL, stdout=log,
                                              stderr=log, start_new_session=True)
                row['worker_pid'] = worker.pid
                atomic_json(path / 'job.json', row)
                # Reap when embedded in a long-lived local test/process. The SSH RPC
                # may exit immediately; the detached worker then belongs to init.
                threading.Thread(target=worker.wait, daemon=True).start()
            except Exception as exc:
                row.update(state='failed', error=type(exc).__name__, finished=time.time())
                atomic_json(path / 'job.json', row)
                raise
        return {'job': row['job'], 'state': row['state']}
    if action == 'cancel':
        with locked(root):
            row = record(path)
            if row['state'] == 'orphaned':
                raise ValueError('Worker missing; operator inspection required')
            if row['state'] not in TERMINAL:
                fd = os.open(path / 'cancel', os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
                os.close(fd)
        return {'job': request['job'], 'state': row['state'], 'cancel_requested': row['state'] not in TERMINAL}
    if action == 'logs':
        record(path)
        log = path / 'stdout.log'
        if not log.exists():
            return {'job': request['job'], 'text': ''}
        with locked(root):
            meta = json.loads(regular_path(path, 'log-meta.json').read_text())
            size = min(meta['bytes'], LOG_LIMIT)
            count = min(size, 65536)
            start = (meta['bytes'] - count) % LOG_LIMIT
            with regular_path(path, 'stdout.log').open('rb') as stream:
                stream.seek(start)
                data = stream.read(min(count, LOG_LIMIT - start))
                if len(data) < count:
                    stream.seek(0)
                    data += stream.read(count - len(data))
            return {'job': request['job'], 'text': data.decode('utf-8', 'replace')}
    if action == 'fetch':
        if record(path)['state'] not in TERMINAL:
            raise ValueError('Fetch requires a terminal job')
        output = path / 'outputs'
        if output.is_symlink() or output.resolve() != output:
            raise ValueError('Unsafe output directory')
        files = {}
        size = 0
        for current, dirs, names in os.walk(output, followlinks=False):
            for name in dirs:
                if (Path(current) / name).is_symlink():
                    raise ValueError('Output directory link forbidden')
            for name in names:
                p = Path(current) / name
                rel = p.relative_to(output).as_posix()
                if len(files) >= 10000:
                    raise ValueError('Output exceeds limits')
                data, _ = read_regular(output, rel, MAX_BYTES - size)
                size += len(data)
                files[rel] = data
        return {'job': request['job'], 'result': pack(files)}
    raise ValueError('Unsupported action')


def kill_group(process, sig):
    try:
        os.killpg(process.pid, sig)
    except ProcessLookupError:
        pass


def worker(path):
    import resource
    import selectors
    path = Path(path)
    root = checked_root(path.parent)
    process = None
    with locked(root):
        row = json.loads((path / 'job.json').read_text())
        row.update(state='running', started=time.time())
        atomic_json(path / 'job.json', row)
    try:
        def limits():
            resource.setrlimit(resource.RLIMIT_AS, (row['memory_mb'] * 1048576,) * 2)
            resource.setrlimit(resource.RLIMIT_CPU, (row['timeout'] * row['cpu'],) * 2)
            os.sched_setaffinity(0, row['cpu_ids'])
        env = os.environ.copy()
        env.update({n: str(row['cpu']) for n in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS')})
        env.update(CUDA_VISIBLE_DEVICES=','.join(map(str, row['gpus'])),
                   SHARED_COMPUTE_OUTPUT=str(path / 'outputs'))
        process = subprocess.Popen(row['command'], cwd=path / 'workspace', env=env,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, start_new_session=True, preexec_fn=limits)
        with locked(root):
            row['process_group'] = process.pid
            atomic_json(path / 'job.json', row)
        os.set_blocking(process.stdout.fileno(), False)
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + row['timeout']
        stop_at = None
        outcome = None
        written = 0
        with locked(root):
            atomic_json(path / 'log-meta.json', {'bytes': 0})
        with (path / 'stdout.log').open('xb+') as log:
            while True:
                if outcome is None and (path / 'cancel').exists():
                    outcome = 'cancelled'
                if outcome is None and time.monotonic() >= deadline:
                    outcome = 'timed_out'
                if outcome is not None and stop_at is None:
                    kill_group(process, signal.SIGTERM)
                    stop_at = time.monotonic() + 1
                if stop_at is not None and time.monotonic() >= stop_at:
                    kill_group(process, signal.SIGKILL)
                for key, _ in selector.select(0.1):
                    data = os.read(key.fd, 65536)
                    if data:
                        with locked(root):
                            cursor = written % LOG_LIMIT
                            first = min(len(data), LOG_LIMIT - cursor)
                            log.seek(cursor)
                            log.write(data[:first])
                            if first < len(data):
                                log.seek(0)
                                log.write(data[first:])
                            log.flush()
                            written += len(data)
                            atomic_json(path / 'log-meta.json', {'bytes': written})
                    else:
                        selector.unregister(key.fileobj)
                if process.poll() is not None:
                    # Kill background descendants in this job group before releasing reservations.
                    kill_group(process, signal.SIGKILL)
                    if not selector.get_map():
                        break
            row.update(state=outcome or ('succeeded' if process.returncode == 0 else 'failed'),
                       exit_code=process.returncode, log_truncated=written >= LOG_LIMIT)
        selector.close()
        process.stdout.close()
    except Exception as exc:
        row.update(state='failed', error=type(exc).__name__)
    finally:
        if process is not None:
            kill_group(process, signal.SIGKILL)
            process.wait()
        row['finished'] = time.time()
        with locked(root):
            atomic_json(path / 'job.json', row)


def rpc(request, sources):
    try:
        result = dispatch(Path.home() / '.local/state/shared-compute', request, sources)
        print(json.dumps({'ok': True, 'data': result}))
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}))


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--worker':
        worker(sys.argv[2])
    else:
        raise SystemExit('Use the local compute wrapper')
