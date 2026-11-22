import base64
from concurrent.futures import ThreadPoolExecutor
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import signal
import shlex
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import common
import compute
import remote


class AdaptiveAdmissionTests(unittest.TestCase):
    policy = {'capacity_mode': 'adaptive', 'gpus': [0, 1, 2]}

    def snapshot(self, threads=8, total=32768, available=16384, idle=1):
        return {'cpu_ids': list(range(threads)), 'cpu_idle_fraction': {cpu: idle for cpu in range(threads)},
                'memory_total_mb': total, 'memory_available_mb': available}

    def request(self, cpu=1, memory=1024, timeout=600, gpus=None):
        return {'cpu': cpu, 'memory_mb': memory, 'timeout': timeout, 'gpus': gpus or []}

    def row(self, job='a', cpu_ids=(0, 1), memory=8192, gpus=None, state='running'):
        return {'job': job, 'state': state, 'cpu': len(cpu_ids), 'cpu_ids': list(cpu_ids),
                'memory_mb': memory, 'gpus': gpus or []}

    def test_actual_hardware_allows_more_than_removed_profile_caps(self):
        snapshot = self.snapshot(threads=96, total=257535, available=248000)
        observation = {}
        with patch('remote.inventory', return_value=[]), patch('remote.capacity_snapshot', return_value=snapshot), patch('remote.active_group_resident_mb', return_value={}):
            cpus = remote.admission(None, self.policy, self.request(cpu=72, memory=204800, timeout=43200), observation=observation)
        self.assertEqual(len(cpus), 72)
        self.assertEqual(observation['declared_timeout_seconds'], 43200)

    def test_pending_memory_and_cpu_reservations_prevent_overlap_without_double_charge(self):
        rows = [self.row()]
        with patch('remote.inventory', return_value=rows), patch('remote.capacity_snapshot', return_value=self.snapshot(available=12288)), patch('remote.active_group_resident_mb', return_value={'a': 1024}):
            self.assertEqual(remote.admission(None, self.policy, self.request(cpu=2, memory=5120)), [2, 3])
            with self.assertRaisesRegex(ValueError, 'ongoing reservations busy'):
                remote.admission(None, self.policy, self.request(memory=5121))
        self.assertEqual(rows[0]['cpu_ids'], [0, 1])

    def test_current_availability_is_rechecked_and_physical_ram_bounds_remain(self):
        with patch('remote.inventory', return_value=[]), patch('remote.active_group_resident_mb', return_value={}), patch('remote.capacity_snapshot', side_effect=[self.snapshot(available=16384), self.snapshot(available=4096)]) as capacity:
            remote.admission(None, self.policy, self.request(memory=8192))
            with self.assertRaisesRegex(ValueError, 'available hardware'):
                remote.admission(None, self.policy, self.request(memory=8192))
            self.assertEqual(capacity.call_count, 2)
        with patch('remote.inventory', return_value=[self.row(memory=16000)]), patch('remote.capacity_snapshot', return_value=self.snapshot(available=20000)), patch('remote.active_group_resident_mb', return_value={'a': 20000}):
            with self.assertRaisesRegex(ValueError, 'available hardware'):
                remote.admission(None, self.policy, self.request(memory=18000))

    def test_job_count_is_resource_derived_and_cpu_load_is_observed(self):
        rows = [self.row(job=str(cpu), cpu_ids=(cpu,), memory=1024) for cpu in range(3)]
        with patch('remote.inventory', return_value=rows), patch('remote.capacity_snapshot', return_value=self.snapshot()), patch('remote.active_group_resident_mb', return_value={}):
            self.assertEqual(remote.admission(None, self.policy, self.request()), [3])
        with patch('remote.inventory', return_value=[]), patch('remote.capacity_snapshot', return_value=self.snapshot(idle=.125)), patch('remote.active_group_resident_mb', return_value={}):
            with self.assertRaisesRegex(ValueError, 'available hardware'):
                remote.admission(None, self.policy, self.request(cpu=2))

    def test_gpu_collision_orphan_and_missing_finite_lifetime_fail_closed(self):
        with patch('remote.inventory', return_value=[self.row(gpus=[0])]):
            with self.assertRaisesRegex(ValueError, 'wrapper resources busy'):
                remote.admission(None, self.policy, self.request(gpus=[0]))
        with patch('remote.inventory', return_value=[self.row(state='orphaned')]):
            with self.assertRaisesRegex(ValueError, 'Orphaned'):
                remote.admission(None, self.policy, self.request())
        for deadline in (None, 0, -1, True, 2**31):
            with self.subTest(deadline=deadline), self.assertRaises(ValueError):
                remote.admission(None, self.policy, self.request(timeout=deadline))

    def test_cli_requires_workload_specific_resources_instead_of_invented_defaults(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            compute.parser().parse_args(['submit', 'fixture'])
        args = compute.parser().parse_args(['submit', 'fixture', '--cpu', '3', '--memory-mb', '2048', '--timeout', '37'])
        self.assertEqual((args.cpu, args.memory_mb, args.timeout), (3, 2048, 37))


class GPUOccupancyTests(unittest.TestCase):
    policy = {'gpu_idle_max_memory_mb': 64, 'gpu_idle_max_utilization_percent': 0}

    def test_busy_card_refused_idle_card_allowed_and_cpu_skips_query(self):
        with patch('remote.subprocess.run') as run:
            remote.gpu_occupancy_admission(self.policy, [])
            run.assert_not_called()
            run.return_value = subprocess.CompletedProcess([], 0, stdout='0, 8, 0\n')
            remote.gpu_occupancy_admission(self.policy, [0])
            run.return_value = subprocess.CompletedProcess([], 0, stdout='2, 1980, 89\n')
            with self.assertRaisesRegex(ValueError, 'External GPU resources busy'):
                remote.gpu_occupancy_admission(self.policy, [2])

    def test_missing_malformed_or_failed_metadata_refuses(self):
        for output in ('', '1, 8, 0\n', '0, N/A, 0\n', '0, 8, 0\n0, 8, 0\n'):
            with self.subTest(output=output), patch('remote.subprocess.run', return_value=subprocess.CompletedProcess([], 0, stdout=output)):
                with self.assertRaisesRegex(ValueError, 'occupancy unavailable'):
                    remote.gpu_occupancy_admission(self.policy, [0])
        with patch('remote.subprocess.run', side_effect=subprocess.CalledProcessError(1, 'nvidia-smi')):
            with self.assertRaisesRegex(ValueError, 'occupancy unavailable'):
                remote.gpu_occupancy_admission(self.policy, [0])


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp.name)
        self.git('init', '-q')

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.repo), *args], check=True, capture_output=True)

    def write(self, name, content):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def test_dirty_untracked_deleted_ignored_and_tracked_secrets(self):
        for name, content in {'app.py': 'old', 'gone.txt': 'delete', '.env': 'value',
                              'config.txt': 'api_key = "abcdefghijklmnopqrstuv"',
                              'ssh.pem': 'private', '.gitignore': 'ignored.dat\n'}.items():
            self.write(name, content)
        self.git('add', '.')
        self.write('app.py', 'dirty')
        (self.repo / 'gone.txt').unlink()
        self.write('new.txt', 'untracked')
        self.write('ignored.dat', 'ignored')
        snap = compute.snapshot(self.repo)
        self.assertEqual({r['path'] for r in snap['manifest']}, {'app.py', 'new.txt', '.gitignore'})
        self.assertEqual({r['path'] for r in snap['excluded']}, {'.env', 'config.txt', 'ssh.pem'})
        self.assertEqual(snap['deleted'], ['gone.txt'])
        dest = self.repo / 'extracted'
        common.unpack(snap, dest)
        self.assertEqual((dest / 'app.py').read_text(), 'dirty')

    def test_executable_git_mode(self):
        self.write('run.sh', '#!/bin/sh\nexit 0\n')
        self.git('add', 'run.sh')
        self.git('update-index', '--chmod=+x', 'run.sh')
        if os.name != 'nt':
            (self.repo / 'run.sh').chmod(0o700)
        self.assertEqual(compute.snapshot(self.repo)['manifest'][0]['mode'], 0o700)

    @unittest.skipIf(os.name == 'nt', 'Windows uses the Git-index executable fallback')
    def test_dirty_and_untracked_posix_executable_mode(self):
        self.write('run.sh', '#!/bin/sh\nexit 0\n')
        path = self.repo / 'run.sh'
        path.chmod(0o700)
        snap = compute.snapshot(self.repo)
        self.assertEqual(snap['manifest'][0]['mode'], 0o700)
        dest = self.repo / 'extract'
        common.unpack(snap, dest)
        subprocess.run([str(dest / 'run.sh')], check=True)
        self.git('add', 'run.sh')
        path.chmod(0o600)
        snap = compute.snapshot(self.repo)
        row = next(r for r in snap['manifest'] if r['path'] == 'run.sh')
        self.assertEqual(row['mode'], 0o600)
        self.git('update-index', '--chmod=-x', 'run.sh')
        path.chmod(0o700)
        row = next(r for r in compute.snapshot(self.repo)['manifest'] if r['path'] == 'run.sh')
        self.assertEqual(row['mode'], 0o700)

    def test_benign_names_and_credential_names(self):
        for name in ('tokenizer.py', 'secretary.py', 'token.json', 'secrets.json',
                     'auth.json', 'credentials.txt', 'id_ed25519', 'server.pem', '.env.production',
                     'github_token.json', 'service-secret.txt'):
            self.write(name, 'fixture')
        self.git('add', '.')
        snap = compute.snapshot(self.repo)
        self.assertEqual({r['path'] for r in snap['manifest']}, {'tokenizer.py', 'secretary.py'})
        self.assertEqual(len(snap['excluded']), 9)

    @unittest.skipIf(os.name == 'nt', 'POSIX descriptor-swap fixture')
    def test_symlink_swap_at_descriptor_open_fails(self):
        self.write('run.txt', 'inside')
        outside = self.repo.parent / (self.repo.name + '-outside.txt')
        outside.write_text('OUTSIDE_FILE_FIXTURE')
        original_open = os.open
        def swapped_open(path, flags, *args, **kwargs):
            if path == 'run.txt':
                (self.repo / 'run.txt').unlink()
                (self.repo / 'run.txt').symlink_to(outside)
            return original_open(path, flags, *args, **kwargs)
        try:
            with patch.object(common.os, 'open', side_effect=swapped_open), self.assertRaises(ValueError):
                compute.snapshot(self.repo)
        finally:
            outside.unlink()

    @unittest.skipIf(os.name == 'nt', 'POSIX parent descriptor-swap fixture')
    def test_parent_symlink_swap_at_descriptor_open_fails(self):
        self.write('sub/run.txt', 'inside')
        original_open = os.open
        def swapped_open(path, flags, *args, **kwargs):
            if path == 'sub':
                (self.repo / 'sub').rename(self.repo / 'old-sub')
                (self.repo / 'sub').symlink_to(self.repo.parent, target_is_directory=True)
            return original_open(path, flags, *args, **kwargs)
        with patch.object(common.os, 'open', side_effect=swapped_open), self.assertRaises(ValueError):
            compute.snapshot(self.repo)

    def test_snapshot_does_not_reopen_path_read_bytes(self):
        self.write('run.txt', 'inside')
        with patch.object(Path, 'read_bytes', side_effect=AssertionError('unsafe path reopen')):
            snap = compute.snapshot(self.repo)
        self.assertEqual(snap['manifest'][0]['sha256'], hashlib.sha256(b'inside').hexdigest())

    @unittest.skipIf(os.name == 'nt', 'Windows denies simultaneous writers instead')
    def test_concurrent_content_change_fails(self):
        self.write('run.txt', 'inside')
        original_read = os.read
        touched = False
        def changed_read(fd, size):
            nonlocal touched
            data = original_read(fd, size)
            if data and not touched:
                touched = True
                (self.repo / 'run.txt').write_text('changed content')
            return data
        with patch.object(common.os, 'read', side_effect=changed_read), self.assertRaises(ValueError):
            common.read_regular(self.repo, 'run.txt')

    @unittest.skipUnless(os.name == 'nt', 'Windows pinned-handle sharing fixture')
    def test_windows_handles_block_file_parent_swaps_and_writes(self):
        self.write('sub/run.txt', 'inside')
        path = self.repo / 'sub/run.txt'
        original_read = os.read
        touched = False
        def attempt_swaps(fd, size):
            nonlocal touched
            if not touched:
                touched = True
                with self.assertRaises(OSError):
                    path.unlink()
                with self.assertRaises(OSError):
                    path.parent.rename(self.repo / 'renamed')
                with self.assertRaises(OSError):
                    path.write_text('OUTSIDE_FILE_FIXTURE')
            return original_read(fd, size)
        with patch.object(common.os, 'read', side_effect=attempt_swaps):
            data, _ = common.read_regular(self.repo, 'sub/run.txt')
        self.assertTrue(touched)
        self.assertEqual(data, b'inside')

    def test_link_outside_fails(self):
        try:
            os.symlink(self.repo.parent, self.repo / 'escape', target_is_directory=True)
        except OSError:
            self.skipTest('Symlink creation unavailable')
        # Git lists a directory symlink as a file.
        with self.assertRaises(ValueError):
            compute.snapshot(self.repo)

    def test_byte_limit(self):
        self.write('large.dat', 'x' * 1024)
        with patch.object(compute, 'MAX_BYTES', 512), self.assertRaises(ValueError):
            compute.snapshot(self.repo)


class ArchiveTests(unittest.TestCase):
    def test_unsafe_names(self):
        for name in ('../x', '/x', 'a/../x', 'a//x', 'a\\x', 'C:x', '.git/config',
                     'a/NUL.txt', 'a.', 'a\nfile'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                common.safe_name(name)

    def test_tampered_hash_and_no_destination_created(self):
        payload = common.pack({'x.txt': b'x'})
        payload['manifest'][0]['sha256'] = '0' * 64
        with tempfile.TemporaryDirectory() as root:
            dest = Path(root) / 'new'
            with self.assertRaises(ValueError):
                common.unpack(payload, dest)
            self.assertFalse(dest.exists())

    def test_archive_link_and_traversal(self):
        for name, kind in (('../escape', tarfile.REGTYPE), ('link', tarfile.SYMTYPE)):
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode='w:') as tar:
                member = tarfile.TarInfo(name)
                member.type, member.linkname, member.mode = kind, '/etc/passwd', 0o600
                tar.addfile(member)
            payload = {'archive': base64.b64encode(buf.getvalue()).decode(), 'manifest': []}
            with tempfile.TemporaryDirectory() as root, self.assertRaises(ValueError):
                common.unpack(payload, Path(root) / 'new')

    def test_existing_destination_and_duplicate_manifest(self):
        payload = common.pack({'x': b'x'})
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError):
                common.unpack(payload, root)
            payload['manifest'].append(payload['manifest'][0])
            with self.assertRaises(ValueError):
                common.unpack(payload, Path(root) / 'new')


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.capture = self.root / 'capture.json'
        self.response = self.root / 'response.json'
        self.response.write_text(json.dumps({'ok': True, 'data': {'jobs': [], 'ready': True}}))
        self.env = patch.dict(os.environ, {'FAKE_SSH_CAPTURE': str(self.capture),
                                           'FAKE_SSH_RESPONSE': str(self.response), 'FAKE_SSH_MODE': 'ok'})
        self.env.start()
        original = subprocess.run
        fake = Path(__file__).with_name('fake_ssh.py')
        self.fake = patch.object(compute.subprocess, 'run',
                                 side_effect=lambda args, **kw: original([sys.executable, '-B', str(fake), *args[1:]], **kw))

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def test_fake_ssh_exact_auth_and_transport(self):
        with self.fake:
            data = compute.transport({'host': 'fixture'}, {'action': 'status'})
        self.assertTrue(data['ready'])
        captured = json.loads(self.capture.read_text())
        self.assertIn('StrictHostKeyChecking=yes', captured['argv'])
        self.assertIn('BatchMode=yes', captured['argv'])
        self.assertLess(len(captured['argv'][-1]), 4096)
        self.assertEqual(captured['request'], {'action': 'status'})

    def test_unset_and_invalid_hosts_never_transport(self):
        with patch.object(compute.subprocess, 'run') as run:
            for host in (None, '-oProxyCommand=evil', 'user@host'):
                with self.assertRaises(ValueError):
                    compute.transport({'host': host}, {'action': 'status'})
            run.assert_not_called()

    def test_fake_ssh_exit_invalid_response_remote_error(self):
        with self.fake:
            with patch.dict(os.environ, {'FAKE_SSH_MODE': 'exit'}), self.assertRaises(RuntimeError):
                compute.transport({'host': 'fixture'}, {'action': 'status'})
            with patch.dict(os.environ, {'FAKE_SSH_MODE': 'invalid'}), self.assertRaises(ValueError):
                compute.transport({'host': 'fixture'}, {'action': 'status'})
            self.response.write_text(json.dumps({'ok': False, 'error': 'busy'}))
            with self.assertRaisesRegex(RuntimeError, 'busy'):
                compute.transport({'host': 'fixture'}, {'action': 'status'})

    def test_transport_timeout(self):
        with patch.object(compute.subprocess, 'run', side_effect=subprocess.TimeoutExpired('ssh', 60)):
            with self.assertRaises(subprocess.TimeoutExpired):
                compute.transport({'host': 'fixture'}, {'action': 'status'})

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux offline RPC fixture')
    def test_bootstrap_executes_stdin_bundle_without_ssh(self):
        root = self.root / '.local/state/shared-compute'
        root.mkdir(parents=True, mode=0o700)
        root.chmod(0o700)
        common.atomic_json(root / 'policy.json', {'cpu': 1, 'memory_mb': 256,
                                               'gpus': [], 'max_timeout': 10, 'max_jobs': 1})
        original = subprocess.run
        def local_bootstrap(args, **kw):
            command = shlex.split(args[-1])
            self.assertEqual(command[:3], ['python3', '-B', '-c'])
            return original([sys.executable, *command[1:]], **kw)
        with patch.dict(os.environ, {'HOME': str(self.root)}), \
                patch.object(compute.subprocess, 'run', side_effect=local_bootstrap):
            data = compute.transport({'host': 'fixture'}, {'action': 'status'})
        self.assertTrue(data['ready'])
        self.assertEqual(data['jobs'], [])

    def test_fetch_new_destination_hashes_and_wrong_job(self):
        job = 'a' * 32
        result = {'job': job, 'result': common.pack({'out.txt': b'fresh'})}
        target = self.root / 'results'
        with patch.object(compute, 'config', return_value={'host': 'fixture'}), \
                patch.object(compute, 'transport', return_value=result), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(compute.main(['fetch', job, str(target)]), 0)
            self.assertEqual((target / 'out.txt').read_text(), 'fresh')
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(compute.main(['fetch', job, str(target)]), 1)
            result['job'] = 'b' * 32
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(compute.main(['fetch', job, str(self.root / 'wrong')]), 1)
            self.assertFalse((self.root / 'wrong').exists())

    def test_status_unset_guard(self):
        with patch.object(compute, 'config', return_value={'host': None}), \
                patch.object(compute, 'transport') as ssh, contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(compute.main(['status']), 0)
            self.assertFalse(json.loads(out.getvalue())['configured'])
            ssh.assert_not_called()

    def test_config_blocked_hosts_extend_guard(self):
        settings = {'host': 'Private.Example', 'blocked_hosts': ['private.example']}
        with self.assertRaises(ValueError):
            compute.checked_host(settings)
        self.assertEqual(compute.checked_host({'host': 'compute'}), 'compute')

    def test_submit_receipt_survives_uncertain_transport(self):
        repo = self.root / 'repo'
        repo.mkdir()
        subprocess.run(['git', '-C', str(repo), 'init', '-q'], check=True)
        (repo / 'code.py').write_text('pass')
        receipts = self.root / 'receipts'
        with patch.object(compute, 'config', return_value={'host': 'fixture'}), \
                patch.dict(os.environ, {'SHARED_COMPUTE_STATE': str(receipts)}), \
                patch.object(compute, 'transport', side_effect=subprocess.TimeoutExpired('ssh', 60)), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(compute.main(['submit', str(repo), '--cpu', '1', '--memory-mb', '256', '--timeout', '5', '--', 'python3', 'code.py']), 1)
        rows = list(receipts.glob('*.json'))
        self.assertEqual(len(rows), 1)
        row = json.loads(rows[0].read_text())
        self.assertEqual(row['submission'], 'uncertain')
        self.assertTrue(common.JOB_RE.fullmatch(row['job']))
        self.assertNotIn('command', row)


@unittest.skipUnless(sys.platform.startswith('linux'), 'Linux supervisor fixtures require Linux/WSL')
class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.root.chmod(0o700)
        self.policy(cpu=min(2, len(os.sched_getaffinity(0))), memory_mb=1024,
                    gpus=[0], max_timeout=10, max_jobs=2)
        self.jobs = []

    def policy(self, **data):
        common.atomic_json(self.root / 'policy.json', data)

    def tearDown(self):
        for job in self.jobs:
            try:
                remote.dispatch(self.root, {'action': 'cancel', 'job': job})
                self.wait(job)
            except Exception:
                pass
        self.temp.cleanup()

    def submit(self, code, **kw):
        job = __import__('uuid').uuid4().hex
        request = dict(action='submit', job=job, command=[sys.executable, '-c', code],
                       cpu=1, memory_mb=256, timeout=5, gpus=[], snapshot=common.pack({'input.txt': b'dirty'}))
        request.update(kw)
        self.jobs.append(job)
        remote.dispatch(self.root, request)
        return job

    def wait(self, job):
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            row = remote.record(self.root / job)
            if row['state'] in remote.TERMINAL:
                return row
            time.sleep(0.05)
        self.fail(f'Job did not terminate: {job}')

    def test_success_limits_outputs_and_stale_results(self):
        job = self.submit("import os,resource,pathlib,json; print(json.dumps({'cpu':len(os.sched_getaffinity(0)),'memory':resource.getrlimit(resource.RLIMIT_AS)[0]})); pathlib.Path(os.environ['SHARED_COMPUTE_OUTPUT'],'result.txt').write_text(pathlib.Path('input.txt').read_text())")
        self.assertEqual(self.wait(job)['state'], 'succeeded')
        limits = json.loads(remote.dispatch(self.root, {'action': 'logs', 'job': job})['text'])
        self.assertEqual(limits, {'cpu': 1, 'memory': 256 * 1048576})
        data = remote.dispatch(self.root, {'action': 'fetch', 'job': job})
        common.unpack(data['result'], self.root / 'fetched')
        self.assertEqual((self.root / 'fetched/result.txt').read_text(), 'dirty')
        second = self.submit('pass')
        self.wait(second)
        self.assertEqual(remote.dispatch(self.root, {'action': 'fetch', 'job': second})['result']['manifest'], [])

    def test_failure_timeout_and_cancel(self):
        bad = self.submit('raise SystemExit(7)')
        self.assertEqual(self.wait(bad)['exit_code'], 7)
        self.assertEqual(remote.record(self.root / bad)['state'], 'failed')
        timed = self.submit('import time; time.sleep(30)', timeout=1)
        self.assertEqual(self.wait(timed)['state'], 'timed_out')
        cancelled = self.submit('import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)')
        remote.dispatch(self.root, {'action': 'cancel', 'job': cancelled})
        self.assertEqual(self.wait(cancelled)['state'], 'cancelled')

    def test_concurrent_admission_and_release(self):
        self.policy(cpu=1, memory_mb=256, gpus=[], max_timeout=10, max_jobs=1)
        def attempt(_):
            try:
                return self.submit('import time; time.sleep(1)')
            except ValueError:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            accepted = [j for j in pool.map(attempt, range(2)) if j]
        self.assertEqual(len(accepted), 1)
        self.wait(accepted[0])
        self.assertEqual(self.wait(self.submit('pass'))['state'], 'succeeded')

    def test_gpu_reservation_and_limit_rejection(self):
        job = self.submit('import time; time.sleep(1)', gpus=[0])
        with self.assertRaisesRegex(ValueError, 'busy'):
            self.submit('pass', gpus=[0])
        with self.assertRaises(ValueError):
            self.submit('pass', gpus=[99])
        with self.assertRaises(ValueError):
            self.submit('pass', timeout=100)
        self.wait(job)

    def test_missing_policy_orphan_and_unsafe_job(self):
        with self.assertRaises(ValueError):
            remote.dispatch(self.root, {'action': 'logs', 'job': '../escape'})
        (self.root / 'policy.json').unlink()
        with self.assertRaises(FileNotFoundError):
            self.submit('pass')
        self.policy(cpu=1, memory_mb=256, gpus=[], max_timeout=10, max_jobs=1)
        orphan = self.root / ('f' * 32)
        orphan.mkdir()
        common.atomic_json(orphan / 'job.json', {'state': 'running', 'worker_pid': 99999999})
        with self.assertRaisesRegex(ValueError, 'Orphaned'):
            self.submit('pass')

    def test_worker_launch_failure_releases_reservation(self):
        with patch.object(remote.subprocess, 'Popen', side_effect=OSError('fixture launch failure')):
            with self.assertRaises(OSError):
                self.submit('pass')
        failed = [p for p in self.root.iterdir() if common.JOB_RE.fullmatch(p.name)]
        self.assertEqual(remote.record(failed[0])['state'], 'failed')
        self.assertEqual(self.wait(self.submit('pass'))['state'], 'succeeded')

    def test_running_fetch_forbidden_and_output_link(self):
        job = self.submit('import time; time.sleep(1)')
        with self.assertRaises(ValueError):
            remote.dispatch(self.root, {'action': 'fetch', 'job': job})
        self.wait(job)
        os.symlink('/etc/passwd', self.root / job / 'outputs/escape')
        with self.assertRaises(ValueError):
            remote.dispatch(self.root, {'action': 'fetch', 'job': job})

    def test_bounded_logs(self):
        job = self.submit("import sys; sys.stdout.write('x'*(5*1024*1024)); sys.stdout.flush(); raise RuntimeError('FINAL_FAILURE_FIXTURE')")
        self.assertTrue(self.wait(job)['log_truncated'])
        self.assertEqual(remote.record(self.root / job)['state'], 'failed')
        self.assertEqual((self.root / job / 'stdout.log').stat().st_size, remote.LOG_LIMIT)
        text = remote.dispatch(self.root, {'action': 'logs', 'job': job})['text']
        self.assertEqual(len(text), 65536)
        self.assertIn('FINAL_FAILURE_FIXTURE', text)

    def test_cpu_affinity_reservations_do_not_overlap(self):
        if len(os.sched_getaffinity(0)) < 2:
            self.skipTest('Needs two fixture CPUs')
        first = self.submit('import time; time.sleep(1)')
        second = self.submit('import time; time.sleep(1)')
        self.assertFalse(set(remote.record(self.root / first)['cpu_ids']) &
                         set(remote.record(self.root / second)['cpu_ids']))
        self.wait(first)
        self.wait(second)

    def test_primary_exit_kills_background_group_descendants(self):
        job = self.submit("import subprocess,sys,pathlib,os; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); pathlib.Path(os.environ['SHARED_COMPUTE_OUTPUT'],'child.txt').write_text(str(p.pid))")
        self.assertEqual(self.wait(job)['state'], 'succeeded')
        pid = int((self.root / job / 'outputs/child.txt').read_text())
        state = Path(f'/proc/{pid}/stat')
        self.assertTrue(not state.exists() or state.read_text().split()[2] == 'Z')


if __name__ == '__main__':
    unittest.main()
