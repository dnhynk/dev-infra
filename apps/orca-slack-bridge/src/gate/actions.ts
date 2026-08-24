import { createHash } from 'node:crypto';
import type { GateKey } from '../identity/keys.js';
import { GATE_ACTION_PREFIX, GATE_BLOCK_PREFIX } from './resolution-types.js';

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24);
}

/** Code-owned opaque Block Kit identities. Human Gate prose is never encoded or parsed. */
export function gateBlockId(gateKey: GateKey): string {
  return `${GATE_BLOCK_PREFIX}:${digest(gateKey)}`;
}

export function gateActionId(gateKey: GateKey, optionId: string): string {
  return `${GATE_ACTION_PREFIX}:${digest(`${gateKey}\0${optionId}`)}`;
}
