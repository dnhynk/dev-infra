import { readFile } from 'node:fs/promises';
import { dispatchKey, gateKey, runKey, taskKey } from '../identity/keys.js';
import { listGates, type OrcaRunner } from '../orca/client.js';
import type { GateStore } from '../store/schema.js';
import {
  GATE_REGISTRATION_SCHEMA_VERSION,
  type GateMetadata,
  type GateOptionMetadata,
  type GateRegistrationDocument,
} from './types.js';

function record(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${at}이(가) object가 아니다`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  at: string,
): void {
  const allowed = new Set(expected);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) throw new TypeError(`${at}에 알 수 없는 필드가 있다: ${unknown.join(', ')}`);
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) throw new TypeError(`${at}에 필수 필드가 없다: ${missing.join(', ')}`);
}

function nonEmptyString(value: unknown, at: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${at}이(가) 비어 있지 않은 string이 아니다`);
  }
  return value;
}

function boundedString(value: unknown, at: string, cap: number): string {
  const text = nonEmptyString(value, at);
  if (text.length > cap) throw new TypeError(`${at}이(가) ${cap}자 상한을 넘었다`);
  return text;
}

/** Strict option-array parser shared with durable-store reads. */
export function parseGateOptionMetadataArray(
  value: unknown,
  at = 'gate registration.options',
  /**
   * 등록 문서는 설명을 반드시 요구한다. durable store 읽기만 null을 허용하는데, 파생 행에는
   * Orca가 주지 않는 설명이 없기 때문이다. 기본값이 strict인 것이 의도다.
   */
  nullableDescription = false,
): readonly GateOptionMetadata[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 25) {
    throw new TypeError(`${at}이(가) 1..25개 array가 아니다`);
  }
  const options = value.map((raw, index) => {
    const optionAt = `${at}[${index}]`;
    const option = record(raw, optionAt);
    exactKeys(option, ['id', 'label', 'description', 'resolution'], optionAt);
    const id = boundedString(option['id'], `${optionAt}.id`, 64);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new TypeError(`${optionAt}.id가 stable option ID 형식이 아니다`);
    }
    const rawDescription = option['description'];
    return {
      id,
      label: boundedString(option['label'], `${optionAt}.label`, 75),
      description:
        nullableDescription && rawDescription === null
          ? null
          : boundedString(rawDescription, `${optionAt}.description`, 3000),
      resolution: boundedString(option['resolution'], `${optionAt}.resolution`, 3000),
    };
  });
  const ids = new Set<string>();
  for (const option of options) {
    if (ids.has(option.id)) throw new TypeError(`${at}에 중복 option id가 있다: ${option.id}`);
    ids.add(option.id);
  }
  return options;
}

/** Parse and validate the complete code-owned registration document; no coercion is performed. */
export function parseGateRegistrationDocument(value: unknown): GateRegistrationDocument {
  const root = record(value, 'gate registration');
  exactKeys(
    root,
    [
      'schemaVersion',
      'runId',
      'askMessageId',
      'questionThreadId',
      'dispatchId',
      'taskId',
      'gateId',
      'options',
      'recommendation',
      'impact',
    ],
    'gate registration',
  );
  if (root['schemaVersion'] !== GATE_REGISTRATION_SCHEMA_VERSION) {
    throw new TypeError(
      `gate registration.schemaVersion이 ${GATE_REGISTRATION_SCHEMA_VERSION}이 아니다: ` +
        String(root['schemaVersion']),
    );
  }
  const options = parseGateOptionMetadataArray(root['options']);
  const recommendation = record(root['recommendation'], 'gate registration.recommendation');
  exactKeys(recommendation, ['optionId', 'reason'], 'gate registration.recommendation');
  const optionId = nonEmptyString(
    recommendation['optionId'],
    'gate registration.recommendation.optionId',
  );
  if (!options.some((option) => option.id === optionId)) {
    throw new TypeError(`gate registration.recommendation.optionId가 options에 없다: ${optionId}`);
  }
  return {
    schemaVersion: GATE_REGISTRATION_SCHEMA_VERSION,
    runId: boundedString(root['runId'], 'gate registration.runId', 500),
    askMessageId: boundedString(root['askMessageId'], 'gate registration.askMessageId', 500),
    questionThreadId: boundedString(
      root['questionThreadId'],
      'gate registration.questionThreadId',
      500,
    ),
    dispatchId: boundedString(root['dispatchId'], 'gate registration.dispatchId', 500),
    taskId: boundedString(root['taskId'], 'gate registration.taskId', 500),
    gateId: boundedString(root['gateId'], 'gate registration.gateId', 500),
    options,
    recommendation: {
      optionId,
      reason: boundedString(recommendation['reason'], 'gate registration.recommendation.reason', 3000),
    },
    impact: boundedString(root['impact'], 'gate registration.impact', 3000),
  };
}

/** Read JSON only from the required file transport. stdin and free-text parsing are intentionally absent. */
export async function readGateRegistrationDocument(path: string): Promise<GateRegistrationDocument> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    throw new Error(
      `Gate registration JSON 파일을 읽을 수 없다: ${path}: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new SyntaxError(
      `Gate registration 파일이 JSON이 아니다: ${path}: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  return parseGateRegistrationDocument(parsed);
}

function sameOptions(a: readonly GateOptionMetadata[], b: readonly GateOptionMetadata[]): boolean {
  return (
    a.length === b.length &&
    a.every((option, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        option.id === other.id &&
        option.label === other.label &&
        option.description === other.description &&
        option.resolution === other.resolution
      );
    })
  );
}

function sameMetadata(a: GateMetadata, b: GateMetadata): boolean {
  return (
    a.gateKey === b.gateKey &&
    a.runKey === b.runKey &&
    a.taskKey === b.taskKey &&
    a.dispatchKey === b.dispatchKey &&
    a.askMessageId === b.askMessageId &&
    a.questionThreadId === b.questionThreadId &&
    sameOptions(a.options, b.options) &&
    a.source === b.source &&
    a.recommendation?.optionId === b.recommendation?.optionId &&
    a.recommendation?.reason === b.recommendation?.reason &&
    a.impact === b.impact
  );
}

export type GateRegistrationResult = {
  readonly action: 'registered' | 'already_registered';
  readonly metadata: GateMetadata;
};

/** Verify the complete Orca Gate identity through one read-only `gate-list`. */
export async function validateGateRegistrationIdentity(
  orca: OrcaRunner,
  document: GateRegistrationDocument,
  now: () => Date = () => new Date(),
): Promise<GateMetadata> {
  const gates = await listGates(orca, document.runId);
  const matches = gates.filter((gate) => gate.id === document.gateId);
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `Orca Run ${document.runId}에서 Gate ${document.gateId}를 찾지 못했다`
        : `Orca Run ${document.runId}에 Gate ${document.gateId}가 ${matches.length}개다`,
    );
  }
  const gate = matches[0];
  if (gate === undefined) throw new Error(`Gate ${document.gateId} identity를 읽지 못했다`);
  if (gate.runId !== document.runId) {
    throw new Error(`Gate ${document.gateId}의 runId가 입력과 어긋난다`);
  }
  if (gate.taskId !== document.taskId) {
    throw new Error(
      `Gate ${document.gateId}의 taskId가 입력과 어긋난다: Orca=${gate.taskId}, input=${document.taskId}`,
    );
  }
  if (gate.options.kind === 'unreadable') {
    throw new Error(`Gate ${document.gateId}의 options를 읽지 못해 identity를 확인할 수 없다: ${gate.options.reason}`);
  }
  const labels = document.options.map((option) => option.label);
  if (
    gate.options.value.length !== labels.length ||
    !gate.options.value.every((label, index) => label === labels[index])
  ) {
    throw new Error(
      `Gate ${document.gateId}의 options가 입력과 어긋난다: ` +
        `Orca=${JSON.stringify(gate.options.value)}, input=${JSON.stringify(labels)}`,
    );
  }

  return {
    gateKey: gateKey(document.gateId),
    runKey: runKey(document.runId),
    taskKey: taskKey(document.taskId),
    dispatchKey: dispatchKey(document.dispatchId),
    askMessageId: document.askMessageId,
    questionThreadId: document.questionThreadId,
    options: document.options,
    source: 'registered',
    recommendation: document.recommendation,
    impact: document.impact,
    registeredAt: now().toISOString(),
  };
}

/** Persist an already identity-validated candidate without any Orca or Slack call. */
export function persistGateMetadata(
  store: GateStore,
  candidate: GateMetadata,
): GateRegistrationResult {
  const existing = store.findGateMetadata(candidate.gateKey);
  // 관측이 만든 파생 행은 등록을 막지 않는다. 등록된 문서가 파생 행보다 항상 낫고, 파생 행은
  // 등록을 빠뜨렸을 때의 대체물이지 등록과 겨루는 값이 아니다.
  if (existing !== null && existing.source !== 'derived') {
    if (!sameMetadata(existing, candidate)) {
      throw new Error(
        `Gate ${candidate.gateKey.slice('gate:'.length)}가 이미 다른 sidecar metadata로 등록돼 있다`,
      );
    }
    return { action: 'already_registered', metadata: existing };
  }
  store.insertGateMetadata(candidate);
  return { action: 'registered', metadata: candidate };
}

/**
 * Verify the exact Orca Gate identity through a read-only `gate-list`, then persist locally.
 * CLI callers validate before constructing the store; this wrapper remains useful to callers that
 * already own a store. No Orca mutation and no Slack call exists on either path.
 */
export async function registerGateMetadata(
  orca: OrcaRunner,
  store: GateStore,
  document: GateRegistrationDocument,
  now: () => Date = () => new Date(),
): Promise<GateRegistrationResult> {
  const candidate = await validateGateRegistrationIdentity(orca, document, now);
  return persistGateMetadata(store, candidate);
}
