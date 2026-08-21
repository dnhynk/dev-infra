/** Orca CLI가 `--json`으로 반환하는 응답 봉투. */

export type OrcaOk<T> = {
  id: string;
  ok: true;
  result: T;
  _meta?: { runtimeId?: string };
};

export type OrcaErr = {
  id: string;
  ok: false;
  error: {
    code: string;
    message: string;
    data?: {
      /** 실패 시 mutation이 실제로 적용됐는지. 복구 판단의 근거다. */
      effectsApplied?: boolean;
      nextCommandArgs?: string[];
      nextSteps?: string[];
    };
  };
};

export type OrcaEnvelope<T> = OrcaOk<T> | OrcaErr;

export class OrcaCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** 알 수 없으면 undefined. false로 단정하지 않는다. */
    readonly effectsApplied: boolean | undefined,
    readonly nextSteps: readonly string[],
  ) {
    super(message);
    this.name = 'OrcaCommandError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * 봉투를 검증하고 result를 꺼낸다.
 * 형태가 다르면 조용히 통과시키지 않는다. Orca 계약이 바뀐 것이므로 즉시 드러내야 한다.
 */
export function unwrap<T>(raw: unknown): T {
  if (!isRecord(raw)) {
    throw new TypeError(`Orca 응답이 객체가 아니다: ${typeof raw}`);
  }
  if (raw['ok'] === true) {
    if (!('result' in raw)) {
      throw new TypeError('Orca 응답에 ok:true이지만 result가 없다');
    }
    return raw['result'] as T;
  }
  if (raw['ok'] === false) {
    const err = isRecord(raw['error']) ? raw['error'] : {};
    const data = isRecord(err['data']) ? err['data'] : {};
    const applied = data['effectsApplied'];
    const steps = data['nextSteps'];
    throw new OrcaCommandError(
      typeof err['code'] === 'string' ? err['code'] : 'unknown',
      typeof err['message'] === 'string' ? err['message'] : 'Orca 명령 실패',
      typeof applied === 'boolean' ? applied : undefined,
      Array.isArray(steps) ? steps.filter((s): s is string => typeof s === 'string') : [],
    );
  }
  throw new TypeError('Orca 응답에 ok 필드가 없다');
}
