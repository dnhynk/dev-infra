import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from common import atomic_json, pack, unpack
from delegation import prepare, replay, route, git, fingerprint
import agent_guard
import remote


class DelegationFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        git(self.repo, 'init')
        git(self.repo, 'config', 'user.name', 'Local fixture')
        git(self.repo, 'config', 'user.email', 'fixture@example.invalid')
        (self.repo / 'input.txt').write_text('base')
        (self.repo / 'deleted.txt').write_text('old')
        git(self.repo, 'add', '.')
        git(self.repo, 'commit', '-m', 'fixture base')
        self.branch = 'compute-fixture'
        self.worktree = self.root / 'worktrees' / 'task'
        self.worktree.parent.mkdir()
        git(self.repo, 'worktree', 'add', '-b', self.branch, str(self.worktree))
        self.request = {'objective': 'Reproduce and improve the measured algorithm', 'acceptance': ['Run the fixture and report evidence'],
            'needs_edits': True, 'iterative': True, 'requires_judgment': True,
            'resources': {'cpu': 1, 'memory_mb': 256, 'timeout': 4, 'gpus': []},
            'allowed_paths': ['input.txt'], 'commit_allowed': True, 'shared_data': []}

    def tearDown(self):
        self.temp.cleanup()

    def bundle(self, dirty=False, timeout=4, gpus=None):
        if dirty:
            (self.repo / 'input.txt').write_text('dirty input')
            (self.repo / 'deleted.txt').unlink()
            (self.repo / 'untracked.txt').write_text('new input')
            (self.repo / '.env').write_text('never copy')
        request = copy.deepcopy(self.request)
        request['resources']['timeout'] = timeout
        if gpus is not None:
            request['resources']['gpus'] = gpus
        destination = self.root / ('prepared-' + __import__('uuid').uuid4().hex)
        result = prepare(self.repo, request, destination, {'host': None})
        return result, json.loads((destination / 'bundle.json').read_text()), destination


class DelegationTests(DelegationFixture):
    def test_compute_size_alone_command_and_iterative_editing_delegate(self):
        self.assertEqual(route({'objective': 'A huge benchmark', 'resources': {'cpu': 96}})['mode'], 'command')
        self.assertEqual(route({'iterative': True})['mode'], 'delegate')
        self.assertEqual(route({'needs_edits': True})['mode'], 'delegate')
        self.assertEqual(route({'requires_judgment': True})['mode'], 'delegate')
        self.assertEqual(route({'mode': 'command', 'needs_edits': True})['mode'], 'command')
        with self.assertRaises(ValueError): route({'iterative': 'yes'})

    def test_dirty_replay_preserves_base_omits_secret_and_disallows_inherited_commit(self):
        result, bundle, destination = self.bundle(dirty=True)
        self.assertFalse(result['live_ready'])
        self.assertFalse(result['commit_allowed'])
        self.assertFalse(result['orca_commands_executed'])
        replay(bundle, self.worktree, self.branch)
        self.assertEqual((self.worktree / 'input.txt').read_text(), 'dirty input')
        self.assertEqual((self.worktree / 'untracked.txt').read_text(), 'new input')
        self.assertFalse((self.worktree / 'deleted.txt').exists())
        self.assertFalse((self.worktree / '.env').exists())
        self.assertEqual(git(self.worktree, 'rev-parse', 'HEAD'), bundle['base_commit'])
        self.assertEqual((self.repo / 'input.txt').read_text(), 'dirty input')

    def test_hash_wrong_base_branch_existing_dirty_or_main_checkout_refuses_without_overwrite(self):
        _, bundle, _ = self.bundle()
        tampered = copy.deepcopy(bundle); tampered['resources']['cpu'] = 20
        with self.assertRaisesRegex(ValueError, 'hash'): replay(tampered, self.worktree, self.branch)
        with self.assertRaisesRegex(ValueError, 'branch'): replay(bundle, self.worktree, 'different')
        with self.assertRaisesRegex(ValueError, 'main checkout'): replay(bundle, self.repo, git(self.repo, 'branch', '--show-current'))
        (self.worktree / 'input.txt').write_text('other worker edit')
        with self.assertRaisesRegex(ValueError, 'clean'): replay(bundle, self.worktree, self.branch)
        self.assertEqual((self.worktree / 'input.txt').read_text(), 'other worker edit')

    def test_tracked_secret_requires_separate_safe_base(self):
        (self.repo / '.env').write_text('tracked secret')
        git(self.repo, 'add', '.env'); git(self.repo, 'commit', '-m', 'fixture forbidden base')
        with self.assertRaisesRegex(ValueError, 'sanitized Git base'): self.bundle()

    def test_shared_data_request_and_duplicate_output_resource_validation(self):
        self.request['shared_data'] = 'not a list'
        with self.assertRaisesRegex(ValueError, 'Shared data'): self.bundle()
        self.request['shared_data'] = []
        self.request['resources']['gpus'] = [0, 0]
        with self.assertRaisesRegex(ValueError, 'GPU'): self.bundle()
        self.request['resources']['gpus'] = []
        result, _, destination = self.bundle()
        with self.assertRaisesRegex(ValueError, 'new'):
            prepare(self.repo, self.request, destination)
        self.assertEqual(result['base_commit'], git(self.repo, 'rev-parse', 'HEAD'))


@unittest.skipUnless(sys.platform.startswith('linux'), 'Real PTY guard requires Linux')
class AgentGuardTests(DelegationFixture):
    def setUp(self):
        super().setUp()
        self.state = self.root / 'state'
        self.state.mkdir(mode=0o700)
        self.policy = {'cpu': 1, 'memory_mb': 256, 'gpus': [0], 'max_timeout': 8, 'max_jobs': 1,
            'allow_agent_guards': True, 'agent_worktree_roots': [str(self.worktree.parent)],
            'agent_executables': [sys.executable]}
        atomic_json(self.state / 'policy.json', self.policy)

    def start(self, code, *, timeout=4, gpus=None):
        _, bundle, destination = self.bundle(timeout=timeout, gpus=gpus)
        replay(bundle, self.worktree, self.branch)
        args = [sys.executable, '-B', agent_guard.__file__, '--root', str(self.state), '--bundle', str(destination / 'bundle.json'),
                '--worktree', str(self.worktree), '--expected-branch', self.branch, '--', sys.executable, '-c', code]
        process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if (self.state / bundle['job'] / 'job.json').exists(): break
            if process.poll() is not None: self.fail(process.communicate()[1].decode())
            time.sleep(.02)
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        return process, bundle

    def finish(self, process, bundle):
        process.communicate(timeout=8)
        return remote.record(self.state / bundle['job'])

    def native_start(self, code, timeout=4):
        import pty
        _, bundle, destination = self.bundle(timeout=timeout)
        replay(bundle, self.worktree, self.branch)
        args=[sys.executable,'-B',agent_guard.__file__,'--root',str(self.state),'--bundle',str(destination/'bundle.json'),
              '--worktree',str(self.worktree),'--expected-branch',self.branch,'--native-foreground','--',sys.executable,'-c',code]
        pid,fd=pty.fork()
        if pid==0: os.execv(sys.executable,args)
        self.addCleanup(os.close,fd)
        deadline=time.monotonic()+6
        while time.monotonic()<deadline:
            path=self.state/bundle['job']
            if (path/'job.json').exists() and remote.record(path).get('process_group'):return pid,bundle
            time.sleep(.02)
        self.fail('Native admission did not finish')

    def test_native_foreground_real_tty_affinity_and_exit_provenance(self):
        code="import os,json;from pathlib import Path;Path(os.environ['SHARED_COMPUTE_OUTPUT'],'tty.json').write_text(json.dumps({'foreground':os.tcgetpgrp(0)==os.getpgrp(),'cpu':len(os.sched_getaffinity(0)),'gpus':os.environ['CUDA_VISIBLE_DEVICES'],'ssh_client':os.environ.get('SSH_CLIENT'),'orca_identity':os.environ.get('ORCA_TERMINAL_HANDLE')}))"
        with patch.dict(os.environ, {'SSH_CLIENT':'fixture','ORCA_TERMINAL_HANDLE':'term_fixture'}):
            pid,bundle=self.native_start(code)
        os.waitpid(pid,0)
        row=remote.record(self.state/bundle['job'])
        self.assertEqual(row['state'],'succeeded')
        self.assertEqual(row['terminal_transport'],'orca_native_pty')
        self.assertEqual(json.loads((self.state/bundle['job']/'outputs/tty.json').read_text()),{'foreground':True,'cpu':1,'gpus':'','ssh_client':None,'orca_identity':'term_fixture'})
        self.assertFalse(remote.alive(row['process_group']))

    def test_native_foreground_timeout_reaps_owned_group(self):
        pid,bundle=self.native_start('import time;time.sleep(20)',timeout=1)
        os.waitpid(pid,0)
        row=remote.record(self.state/bundle['job'])
        self.assertEqual(row['state'],'timed_out')
        self.assertFalse(remote.alive(row['process_group']))

    def test_native_foreground_resident_memory_excess_kills_owned_group(self):
        pid,bundle=self.native_start('import time;data=bytearray(300*1048576);time.sleep(10)')
        os.waitpid(pid,0)
        row=remote.record(self.state/bundle['job'])
        self.assertEqual(row['state'],'failed')
        self.assertEqual(row['error'],'MemoryLimitExceeded')
        self.assertGreater(row['peak_resident_bytes'],256*1048576)
        self.assertFalse(remote.alive(row['process_group']))

    def command(self):
        job = __import__('uuid').uuid4().hex
        remote.dispatch(self.state, {'action': 'submit', 'job': job, 'command': [sys.executable, '-c', 'import time; time.sleep(.5)'],
            'cpu': 1, 'memory_mb': 256, 'timeout': 3, 'gpus': [0], 'snapshot': pack({'x.txt': b'fixture'})})
        return job

    def test_agent_blocks_command_and_releases_same_gpu_and_cpu_reservation(self):
        # Spare CPU/RAM/job slots: only the overlapping GPU can reject this command.
        if len(os.sched_getaffinity(0)) < 2: self.skipTest('Two affinity slots required')
        self.policy.update(cpu=2, memory_mb=512, max_jobs=2)
        atomic_json(self.state / 'policy.json', self.policy)
        process, bundle = self.start('import time; print("guarded agent"); time.sleep(.5)', gpus=[0])
        with self.assertRaisesRegex(ValueError, 'busy'): self.command()
        row = self.finish(process, bundle)
        self.assertEqual(row['state'], 'succeeded')
        self.assertEqual(row['gpus'], [0])
        self.assertIn('guarded agent', remote.dispatch(self.state, {'action': 'logs', 'job': bundle['job']})['text'])
        result = remote.dispatch(self.state, {'action': 'fetch', 'job': bundle['job']})
        unpack(result['result'], self.root / 'results')
        self.assertEqual(json.loads((self.root / 'results/agent-provenance.json').read_text())['base_commit'], bundle['base_commit'])
        command_job = self.command()
        while remote.record(self.state / command_job)['state'] not in remote.TERMINAL: time.sleep(.02)

    def test_command_blocks_agent_without_starting_it(self):
        job = self.command()
        _, bundle, _ = self.bundle(gpus=[0]); replay(bundle, self.worktree, self.branch)
        with self.assertRaisesRegex(ValueError, 'busy'):
            agent_guard.run(self.state, bundle, self.worktree, self.branch, [sys.executable, '-c', 'pass'])
        self.assertFalse((self.state / bundle['job']).exists())
        while remote.record(self.state / job)['state'] not in remote.TERMINAL: time.sleep(.02)

    def test_timeout_kills_agent_and_shared_cancel_marker(self):
        process, bundle = self.start('import time; time.sleep(20)', timeout=1)
        self.assertEqual(self.finish(process, bundle)['state'], 'timed_out')

    def test_unread_stdout_cannot_block_timeout_or_cancellation(self):
        for cancelled in (False, True):
            with self.subTest(cancelled=cancelled):
                # Each case needs a fresh worktree and replay marker.
                if cancelled:
                    git(self.repo, 'worktree', 'remove', '--force', str(self.worktree))
                    git(self.repo, 'worktree', 'add', str(self.worktree), self.branch)
                process, bundle = self.start("while True: print('x'*65536, flush=True)", timeout=1 if not cancelled else 8)
                if cancelled:
                    # Cancellation must exercise unread output, not race interpreter startup.
                    output_deadline = time.monotonic() + 4
                    metadata = self.state / bundle['job'] / 'log-meta.json'
                    while time.monotonic() < output_deadline:
                        if metadata.exists() and json.loads(metadata.read_text()).get('bytes', 0) >= 131072:
                            break
                        time.sleep(.02)
                    self.assertTrue(metadata.exists())
                    self.assertGreaterEqual(json.loads(metadata.read_text())['bytes'], 131072)
                    remote.dispatch(self.state, {'action': 'cancel', 'job': bundle['job']})
                deadline = time.monotonic() + 4
                while remote.record(self.state / bundle['job'])['state'] not in remote.TERMINAL and time.monotonic() < deadline:
                    time.sleep(.02)  # Deliberately never drain process.stdout.
                row = remote.record(self.state / bundle['job'])
                self.assertEqual(row['state'], 'cancelled' if cancelled else 'timed_out')
                self.assertFalse(remote.alive(row['process_group']))
                self.assertGreater(row['terminal_output_dropped_bytes'], 0)
                process.communicate(timeout=3)

    def test_cancel_via_command_backend_and_no_restart_of_same_job(self):
        process, bundle = self.start('import time; time.sleep(20)')
        remote.dispatch(self.state, {'action': 'cancel', 'job': bundle['job']})
        self.assertEqual(self.finish(process, bundle)['state'], 'cancelled')
        with self.assertRaisesRegex(ValueError, 'already exists'):
            agent_guard.run(self.state, bundle, self.worktree, self.branch, [sys.executable, '-c', 'pass'])

    def test_unapproved_guard_or_worktree_and_changed_replay_refuse(self):
        _, bundle, _ = self.bundle(); replay(bundle, self.worktree, self.branch)
        self.policy['allow_agent_guards'] = False; atomic_json(self.state / 'policy.json', self.policy)
        with self.assertRaisesRegex(ValueError, 'not approved'):
            agent_guard.run(self.state, bundle, self.worktree, self.branch, [sys.executable, '-c', 'pass'])
        self.policy['allow_agent_guards'] = True; atomic_json(self.state / 'policy.json', self.policy)
        (self.worktree / 'input.txt').write_text('changed after replay')
        with self.assertRaisesRegex(ValueError, 'changed before'):
            agent_guard.run(self.state, bundle, self.worktree, self.branch, [sys.executable, '-c', 'pass'])
        self.assertEqual(remote.inventory(self.state), [])

    def test_added_input_after_replay_refuses_before_reserving_or_starting(self):
        _, bundle, _ = self.bundle(); replay(bundle, self.worktree, self.branch)
        (self.worktree / 'inherited.txt').write_text('another writer')
        with self.assertRaisesRegex(ValueError, 'manifest differs'):
            agent_guard.run(self.state, bundle, self.worktree, self.branch, [sys.executable, '-c', 'pass'])
        self.assertEqual(remote.inventory(self.state), [])

    def test_codex_shared_daemon_refused_before_reserving(self):
        _, bundle, _ = self.bundle(); replay(bundle, self.worktree, self.branch)
        self.policy['agent_executables']=['/usr/bin/codex']
        atomic_json(self.state/'policy.json',self.policy)
        with self.assertRaisesRegex(ValueError,'--no-daemon'):
            agent_guard.run(self.state,bundle,self.worktree,self.branch,['/usr/bin/codex'])
        self.assertEqual(remote.inventory(self.state),[])

    def test_edits_are_measured_against_input_and_out_of_scope_changes_are_handed_back(self):
        process, bundle = self.start("from pathlib import Path; Path('outside.txt').write_text('not owned')")
        row = self.finish(process, bundle)
        self.assertEqual(row['state'], 'failed')
        self.assertEqual(row['error'], 'OutOfScopeEdits')
        self.assertEqual(row['modified_since_input'], ['outside.txt'])
        self.assertTrue((self.worktree / 'outside.txt').exists())  # Preserve conflict evidence.

    def test_unauthorized_commit_is_reported_without_reset_or_push(self):
        self.request['commit_allowed'] = False
        code = "import subprocess; from pathlib import Path; Path('input.txt').write_text('worker change'); subprocess.run(['git','add','input.txt'],check=True); subprocess.run(['git','commit','-m','fixture unauthorized commit'],check=True)"
        process, bundle = self.start(code)
        row = self.finish(process, bundle)
        self.assertEqual(row['state'], 'failed')
        self.assertEqual(row['error'], 'UnauthorizedBranchOrCommit')
        self.assertNotEqual(row['result_commit'], bundle['base_commit'])
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), bundle['base_commit'])
