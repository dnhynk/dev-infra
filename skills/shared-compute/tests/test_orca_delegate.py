import copy
import json
import multiprocessing
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import orca_delegate as bridge


def concurrent_launch(bundle,target,directory,worktree,terminal,event,results):
    created = False
    def call(args):
        nonlocal created
        verb = ' '.join(args[:2])
        if verb == 'project setups':
            return {'setups':[{'id':target['setup_id'],'hostId':target['host_id'],
                'projectId':target['project_id'],'setupState':'ready'}]}
        if verb == 'worktree list': return {'worktrees':[worktree]}
        if verb == 'terminal list': return {'terminals':[terminal] if created else []}
        if verb == 'terminal create':
            with (Path(directory)/'terminal-creates.txt').open('a') as stream: stream.write('create\n')
            time.sleep(.4)
            created = True
            return {}
        if verb == 'terminal wait': return {'satisfied':True}
        if verb == 'orchestration worker-start': return {'dispatchId':'dispatch_fixture'}
        raise AssertionError(args)
    event.wait(5)
    try:
        with patch.object(bridge,'checked_bundle'):
            result=bridge.execute(bundle,target,{'host':'compute'},'launch',directory,call)
        results.put(result['stage'])
    except Exception as exc:results.put(type(exc).__name__)


class OrcaAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)/'receipt'
        self.bundle={'job':'a'*32,'bundle_sha256':'b'*64,'base_commit':'c'*40,
            'resources':{'gpus':[]},
            'input_manifest_sha256':'d'*64,'orca_worktree_name':'COMPUTE-aaaaaaaaaaaa',
            'request':{'orca_context':{'run_id':'run_fixture','task_id':'task_fixture'}}}
        self.target={'enabled':True,'host_alias':'compute','host_id':'ssh:ssh-fixture',
            'setup_id':'setup-fixture','project_id':'fixture:reviewed','run_id':'run_fixture','task_id':'task_fixture',
            'strict_host_verified':True,'remote_codex_authenticated':True,'shared_policy_approved':True,
            'task_spec_bound':True,'guarded_tui_adoption_verified':True,'posix_shell_verified':True,
            'worktree_root':'/home/hyun/worktrees','scripts':'/home/hyun/.local/share/shared-compute/scripts',
            'remote_bundle':'/home/hyun/bundles/fixture.json','state_root':'/home/hyun/.local/state/shared-compute',
            'python':'/usr/bin/python3','codex':'/home/hyun/.local/bin/codex'}
        self.worktree={'id':'repo::/home/hyun/worktrees/COMPUTE-aaaaaaaaaaaa','repoId':'repo',
            'path':'/home/hyun/worktrees/COMPUTE-aaaaaaaaaaaa','hostId':self.target['host_id'],
            'projectHostSetupId':self.target['setup_id'],'projectId':self.target['project_id'],
            'head':self.bundle['base_commit'],'branch':'refs/heads/COMPUTE-aaaaaaaaaaaa','isMainWorktree':False,'isBare':False}
        self.terminal={'handle':'term_fixture','incarnationId':'10000000-0000-4000-8000-000000000001','worktreeId':self.worktree['id'],
            'executionHostId':self.target['host_id'],'agentIdentity':'codex','connected':True}
        self.calls=[]; self.worktree_created=False; self.terminal_created=False
        self.wait_satisfied=True;self.change_incarnation=False

    def call(self,args):
        self.calls.append(args)
        verb=' '.join(args[:2])
        if verb=='project setups':return {'setups':[{'id':self.target['setup_id'],'hostId':self.target['host_id'],
            'projectId':self.target['project_id'],'setupState':'ready'}]}
        if verb=='orchestration run-show':return {'run':{'id':self.target['run_id'],'coordinator_handle':'term_owned_coordinator'}}
        if verb=='worktree list':return {'worktrees':[self.worktree] if self.worktree_created else []}
        if verb=='worktree create':self.worktree_created=True;return {'unknown_creation_fields':'not guessed'}
        if verb=='terminal list':return {'terminals':[self.terminal] if self.terminal_created else []}
        if verb=='terminal create':self.terminal_created=True;return {'unknown_creation_fields':'not guessed'}
        if verb=='terminal wait':
            if self.change_incarnation:self.terminal['incarnationId']='10000000-0000-4000-8000-000000000002'
            return {'satisfied':self.wait_satisfied}
        if verb=='orchestration worker-start':return {'exact_mock_receipt':True,'dispatchId':'dispatch_fixture'}
        self.fail(args)

    def execute(self,phase):
        with patch.object(bridge,'checked_bundle'):
            return bridge.execute(self.bundle,self.target,{'host':'compute'},phase,self.root,self.call)

    def replay_receipt(self):
        receipt={'job':self.bundle['job'],'bundle_sha256':self.bundle['bundle_sha256'],
            'base_commit':self.bundle['base_commit'],'input_manifest_sha256':self.bundle['input_manifest_sha256'],
            'worktree':self.worktree['path'],'branch':self.worktree['branch'].removeprefix('refs/heads/'),'replayed':True}
        (self.root/'replay-receipt.json').write_text(json.dumps(receipt))

    def test_staged_native_ssh_worktree_replay_guarded_terminal_and_worker_handoff(self):
        self.assertEqual(self.execute('worktree')['stage'],'awaiting_replay')
        self.replay_receipt()
        result=self.execute('launch')
        self.assertEqual(result['stage'],'worker_receipt_requires_reconciliation')
        create=next(a for a in self.calls if a[:2]==['terminal','create'])
        self.assertIn('agent_guard.py',create[create.index('--command')+1])
        self.assertIn('--no-daemon',create[create.index('--command')+1])
        self.assertIn('allow_login_shell=false',create[create.index('--command')+1])
        self.assertIn('shell_snapshot',create[create.index('--command')+1])
        self.assertIn('CUDA_VISIBLE_DEVICES=',create[create.index('--command')+1])
        self.assertIn('--add-dir',create[create.index('--command')+1])
        adopt=next(a for a in self.calls if a[:2]==['orchestration','worker-start'])
        self.assertNotIn('--on',adopt);self.assertNotIn('--agent',adopt)
        self.assertEqual(adopt[adopt.index('--terminal')+1],'term_fixture')
        self.assertFalse(any(a[:2]==['terminal','send'] for a in self.calls))
        for args in [a for a in self.calls if a[:2]==['terminal','list']]:
            self.assertEqual(args[args.index('--worktree')+1],'id:'+self.worktree['id'])

    def test_disabled_or_auth_unready_or_wrong_context_zero_calls(self):
        for key in ['enabled','remote_codex_authenticated','shared_policy_approved','task_spec_bound']:
            with self.subTest(key=key):
                self.target[key]=False
                with self.assertRaises(ValueError):self.execute('worktree')
                self.target[key]=True
        self.assertEqual(self.calls,[])

    def test_unknown_create_outcome_preserved_and_never_automatically_retried(self):
        def uncertain(args):
            if args[:2]==['worktree','create']:raise TimeoutError('transport unknown')
            return self.call(args)
        with patch.object(bridge,'checked_bundle'),self.assertRaises(TimeoutError):
            bridge.execute(self.bundle,self.target,{'host':'compute'},'worktree',self.root,uncertain)
        state=json.loads((self.root/'orca-receipt.json').read_text())
        self.assertEqual(state['stage'],'creating_worktree')
        self.assertEqual(state['commands'][-1]['outcome'],'uncertain')
        with self.assertRaisesRegex(ValueError,'New receipt'):self.execute('worktree')

    def test_replay_wrong_input_or_tui_identity_no_worker_injection(self):
        self.execute('worktree');self.replay_receipt()
        self.terminal['agentIdentity']='claude'
        with self.assertRaisesRegex(ValueError,'Codex incarnation'):self.execute('launch')
        self.assertFalse(any(a[:2]==['orchestration','worker-start'] for a in self.calls))
        with self.assertRaisesRegex(ValueError,'relaunch'):self.execute('launch')

    def test_wrong_host_or_main_worktree_is_not_adopted(self):
        self.worktree['isMainWorktree']=True
        with self.assertRaisesRegex(ValueError,'ownership'):self.execute('worktree')
        self.assertEqual(json.loads((self.root/'orca-receipt.json').read_text())['stage'],'creating_worktree')

    def test_no_ready_setup_causes_no_mutation(self):
        with patch.object(bridge,'checked_bundle'), self.assertRaisesRegex(ValueError,'Ready native'):
            bridge.execute(self.bundle,self.target,{'host':'compute'},'worktree',self.root,lambda a:{'setups':[]})
        self.assertFalse(self.worktree_created)

    def test_structured_failure_preserves_authoritative_residuals(self):
        failure={'ok':False,'result':{'failedStage':'agent_ready','residualResources':{'worktreeId':'observed-owned-id'}}}
        def rejected(args):
            if args[:2]==['worktree','create']:raise bridge.CliRejected(failure)
            return self.call(args)
        with patch.object(bridge,'checked_bundle'),self.assertRaises(bridge.CliRejected):
            bridge.execute(self.bundle,self.target,{'host':'compute'},'worktree',self.root,rejected)
        state=json.loads((self.root/'orca-receipt.json').read_text())
        self.assertEqual(state['cli_failure_receipt'],failure)
        self.assertEqual(state['commands'][-1]['outcome'],'uncertain')

    def test_unsatisfied_or_missing_wait_never_adopts(self):
        for satisfied in (False,None):
            with self.subTest(satisfied=satisfied):
                self.root=Path(self.temp.name)/('wait-'+str(satisfied))
                self.worktree_created=False;self.terminal_created=False;self.calls=[]
                self.execute('worktree');self.replay_receipt();self.wait_satisfied=satisfied
                with self.assertRaisesRegex(ValueError,'explicitly satisfy'):self.execute('launch')
                self.assertFalse(any(a[:2]==['orchestration','worker-start'] for a in self.calls))

    def test_missing_invalid_or_changed_incarnation_never_adopts(self):
        for incarnation in (None,'','invalid','changed'):
            with self.subTest(incarnation=incarnation):
                self.root=Path(self.temp.name)/('incarnation-'+str(incarnation))
                self.worktree_created=False;self.terminal_created=False;self.calls=[]
                self.execute('worktree');self.replay_receipt()
                self.change_incarnation=incarnation=='changed'
                self.terminal['incarnationId']='10000000-0000-4000-8000-000000000001' if self.change_incarnation else incarnation
                with self.assertRaisesRegex(ValueError,'incarnation'):self.execute('launch')
                self.assertFalse(any(a[:2]==['orchestration','worker-start'] for a in self.calls))

    def test_two_processes_launch_only_one_terminal(self):
        self.execute('worktree');self.replay_receipt()
        context=multiprocessing.get_context('spawn')
        event=context.Event();results=context.Queue()
        processes=[context.Process(target=concurrent_launch,args=(self.bundle,self.target,str(self.root),
                    self.worktree,self.terminal,event,results)) for _ in range(2)]
        for process in processes:process.start()
        event.set()
        outcomes=[results.get(timeout=10) for _ in processes]
        for process in processes:
            process.join(10)
            if process.is_alive():process.kill();self.fail('Fixture process stuck')
            self.assertEqual(process.exitcode,0)
        self.assertEqual(outcomes.count('worker_receipt_requires_reconciliation'),1)
        self.assertEqual(outcomes.count('ValueError'),1)
        self.assertEqual((self.root/'terminal-creates.txt').read_text().splitlines(),['create'])

    def test_explicit_sender_bound_to_own_run_before_mutation(self):
        self.target['coordinator_handle']='term_unrelated'
        with self.assertRaisesRegex(ValueError,'Run coordinator'):self.execute('worktree')
        self.assertFalse(self.worktree_created)
        self.root=Path(self.temp.name)/'owned-sender';self.target['coordinator_handle']='term_owned_coordinator'
        self.execute('worktree');self.replay_receipt()
        self.execute('launch')
        adopt=next(a for a in self.calls if a[:2]==['orchestration','worker-start'])
        self.assertEqual(adopt[adopt.index('--from')+1],'term_owned_coordinator')
