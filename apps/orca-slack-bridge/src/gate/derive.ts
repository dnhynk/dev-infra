import { createHash } from 'node:crypto';

import { dispatchKey, gateKey, runKey, taskKey } from '../identity/keys.js';
import type { OrcaGate } from '../orca/client.js';
import type { GateMetadata, GateOptionMetadata } from './types.js';

/** 파생 option ID 접두사. 등록된 ID와 섞이지 않게 한 자리에서만 정한다. */
export const DERIVED_ID_PREFIX = 'orca_';

/**
 * label에서 정하는 안정 option ID. Orca에는 Gate를 수정하는 명령이 없어 label이 불변이므로,
 * 같은 Gate를 다시 관측해도 같은 ID가 나온다. 순번을 함께 넣는 것은 label이 중복일 때 ID가
 * 겹치는 것을 막기 위해서다.
 */
export function derivedOptionId(label: string, index: number): string {
  const digest = createHash('sha256').update(`${index} ${label}`, 'utf8').digest('hex');
  return `${DERIVED_ID_PREFIX}${digest.slice(0, 16)}`;
}

/**
 * sidecar를 등록하지 않은 Gate를 Orca `options`만으로 채운 축소된 행으로 만든다.
 *
 * 이것이 없으면 `gate-create`만 부른 Gate는 선택지 버튼도 `직접 입력` 버튼도 없는 카드로
 * 뜨고(`render.ts`의 `actionable`/`directActionable`), 사용자는 Slack에서 그 Gate를 해결할 수
 * 없다. coordinator가 등록을 한 번 빠뜨리는 것으로 무인 루프가 멈추면 안 되므로 관측이 직접
 * 만든다.
 *
 * 등록된 행을 덮어쓰지 않는다. 호출자가 metadata 부재를 확인한 뒤에만 부른다.
 * options를 읽지 못했거나 등록 문서와 같은 상한을 넘으면 null이고, 그 Gate는 지금처럼
 * 누를 수 없는 카드로 남는다.
 */
export function deriveGateMetadata(gate: OrcaGate, at: string): GateMetadata | null {
  if (gate.options.kind === 'unreadable') return null;
  const labels = gate.options.value;
  if (labels.length === 0 || labels.length > 25) return null;
  const options: GateOptionMetadata[] = [];
  for (const [index, label] of labels.entries()) {
    // 상한을 넘는 label은 자르지 않고 파생을 포기한다. 자르면 Orca에 쓰는 resolution이
    // 사용자가 고른 원문과 달라진다.
    if (label.trim() === '' || label.length > 75) return null;
    options.push({
      id: derivedOptionId(label, index),
      label,
      description: null,
      // 사용자가 고른 선택지를 Orca에 그대로 되돌려준다. 등록 행의 `resolution`과 같은 자리다.
      resolution: label,
    });
  }
  return {
    gateKey: gateKey(gate.id),
    runKey: runKey(gate.runId),
    taskKey: taskKey(gate.taskId),
    // 파생 행에는 worker ask가 없다. Gate ID로 유일성만 만들고, 카드는 correlation을
    // 등록된 값이 아니라고 표시한다.
    dispatchKey: dispatchKey(`derived-${gate.id}`),
    askMessageId: `derived:${gate.id}`,
    questionThreadId: `derived:${gate.id}`,
    options,
    source: 'derived',
    recommendation: null,
    impact: null,
    registeredAt: at,
  };
}
