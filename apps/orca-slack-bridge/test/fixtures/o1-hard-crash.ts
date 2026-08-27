import { writeSync } from 'node:fs';

import { runKey } from '../../src/identity/keys.js';
import { SqliteDigestStore } from '../../src/store/sqlite.js';

const databasePath = process.argv[2];
if (databasePath === undefined) throw new Error('database path is required');

const AT0 = '2026-08-27T00:00:00.000Z';
const AT1 = '2026-08-27T00:00:01.000Z';
const entity = { kind: 'run', key: runKey('o1_acceptance') } as const;
const store = new SqliteDigestStore(databasePath);

store.recordDaemonStart({
  instanceId: 'old-instance',
  buildFingerprint: 'build.1',
  configFingerprint: 'config.1',
  at: AT0,
});
const job = store.startDaemonJob('run-observer', AT0);
if (job === null) throw new Error('daemon job claim failed');
store.advanceDaemonJobCheckpoint(job, 0, 7, AT1);
store.prepareSlackRootIntent({
  ...entity,
  channelId: 'C1',
  renderFingerprint: 'render.1',
  at: AT0,
});
if (store.claimSlackRootIntent(entity, 'old-instance', AT1)?.kind !== 'claimed') {
  throw new Error('root intent claim failed');
}

writeSync(1, JSON.stringify({ externalCalls: 0 }));
process.exit(23);
