import { createHash } from 'node:crypto';
import type { GateKey } from '../identity/keys.js';
import { GATE_ACTION_PREFIX, GATE_BLOCK_PREFIX } from './resolution-types.js';

export const GATE_DIRECT_ACTION_PREFIX = 'orca_gate_direct_open_v1';
export const GATE_DIRECT_BLOCK_PREFIX = 'orca_gate_direct_controls_v1';
export const GATE_DIRECT_VALUE_PREFIX = 'orca_gate_direct_value_v1';
export const GATE_DIRECT_CALLBACK_PREFIX = 'orca_gate_direct_submit_v1';
export const GATE_DIRECT_INPUT_BLOCK_PREFIX = 'orca_gate_direct_input_v1';
export const GATE_DIRECT_INPUT_ACTION_PREFIX = 'orca_gate_direct_text_v1';

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

/** Direct-input identities use disjoint prefixes and remain specific to one Gate. */
export function gateDirectBlockId(gateKey: GateKey): string {
  return `${GATE_DIRECT_BLOCK_PREFIX}:${digest(gateKey)}`;
}

export function gateDirectActionId(gateKey: GateKey): string {
  return `${GATE_DIRECT_ACTION_PREFIX}:${digest(gateKey)}`;
}

export function gateDirectActionValue(gateKey: GateKey): string {
  return `${GATE_DIRECT_VALUE_PREFIX}:${digest(gateKey)}`;
}

export function gateDirectCallbackId(gateKey: GateKey): string {
  return `${GATE_DIRECT_CALLBACK_PREFIX}:${digest(gateKey)}`;
}

export function gateDirectInputBlockId(gateKey: GateKey): string {
  return `${GATE_DIRECT_INPUT_BLOCK_PREFIX}:${digest(gateKey)}`;
}

export function gateDirectInputActionId(gateKey: GateKey): string {
  return `${GATE_DIRECT_INPUT_ACTION_PREFIX}:${digest(gateKey)}`;
}

export function isGateDirectActionId(value: string): boolean {
  return value.startsWith(`${GATE_DIRECT_ACTION_PREFIX}:`);
}

export function isGateDirectCallbackId(value: string): boolean {
  return value.startsWith(`${GATE_DIRECT_CALLBACK_PREFIX}:`);
}
