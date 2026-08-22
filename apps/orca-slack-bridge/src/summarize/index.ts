import type { SummaryDraft, SummaryFacts } from './contract.js';
import { factsFingerprint } from './fingerprint.js';
import { deriveRisk, validateDraft, type Risk } from './validate.js';
import { SummaryProviderError, type SummaryProvider } from './openai.js';

export * from './contract.js';
export * from './validate.js';
export * from './fingerprint.js';
export * from './openai.js';

/**
 * 요약 결과.
 *
 * 실패를 성공처럼 숨기지 않는다. renderer는 `failed`를 받으면 사실만으로 축소 카드를 만들고
 * 요약이 없다는 사실을 표시한다(OD-035).
 */
export type SummaryResult =
  | {
      readonly kind: 'ok';
      readonly draft: SummaryDraft;
      readonly risk: Risk | null;
      readonly truncated: boolean;
      readonly fingerprint: string;
    }
  | {
      readonly kind: 'failed';
      readonly reason: string;
      readonly risk: Risk | null;
      readonly fingerprint: string;
    };

/** 지문 → 결과. 사실이 바뀌지 않으면 다시 호출하지 않는다. */
export interface SummaryCache {
  get(fingerprint: string): SummaryResult | undefined;
  set(fingerprint: string, result: SummaryResult): void;
}

export class MemorySummaryCache implements SummaryCache {
  private readonly map = new Map<string, SummaryResult>();
  get(fingerprint: string): SummaryResult | undefined {
    return this.map.get(fingerprint);
  }
  set(fingerprint: string, result: SummaryResult): void {
    this.map.set(fingerprint, result);
  }
}

/**
 * durable store에 남길 요약의 직렬화 형식.
 *
 * 담는 것은 카드에 실제로 실리는 값뿐이다. `SummaryDraft`의 네 필드와, 사실에서 파생한
 * `risk`·`truncated`다. **summarizer 입력(`prBody`, `changedPaths`, `workerDone` 등)은 담지
 * 않는다.** 지문만 있으면 재사용 판정이 되고, 입력 원문을 로컬에 쌓으면 OD-036이 정한
 * 전송 경계와 별개의 저장 경계가 새로 생긴다. 여기 담는 문구는 이미 Slack에 게시되는 값이라
 * 새 노출이 아니다.
 *
 * `fingerprint`는 담지 않는다. 이 값을 읽는 순간 그 행의 `facts_fingerprint`와 같다는 것이
 * 이미 판정돼 있으므로, 함께 저장하면 같은 사실을 두 곳에 두고 어긋날 자리를 만든다.
 */
type PersistedSummary = {
  readonly title: string;
  readonly what: string;
  readonly why: string;
  readonly reviewGist: string | null;
  readonly risk: Risk | null;
  readonly truncated: boolean;
};

/**
 * 재사용할 요약을 문자열로 만든다. 남길 것이 없으면 null이다.
 *
 * **실패한 요약은 저장하지 않는다.** `summarize`가 실패를 프로세스 내 캐시에 넣는 것과 다르게
 * 판단한 것이고, 이유는 캐시의 수명이다. 프로세스 내 캐시는 관찰 1회만 살아서 같은 실행에서
 * 같은 사실을 두 번 요약하는 낭비만 막는다. durable store에 넣으면 provider 장애가 지나간
 * 뒤에도 사실이 바뀔 때까지 축소 카드가 굳는다. C1에는 캐시를 비우는 수단이 없으므로 오래
 * 조용한 PR은 영영 요약 없는 카드로 남는다. 실패는 사실이 아니라 그때의 provider 상태이므로
 * 사실 지문으로 색인할 값이 아니다.
 *
 * 실패한 관찰도 `facts_fingerprint`는 기록한다. 그 조합에서 다음 관찰이 다시 시도하는 것은
 * `summaryJson`이 null이어서 재사용 판정이 miss가 되기 때문이다.
 */
export function serializeSummary(result: SummaryResult): string | null {
  if (result.kind !== 'ok') return null;
  const persisted: PersistedSummary = {
    title: result.draft.title,
    what: result.draft.what,
    why: result.draft.why,
    reviewGist: result.draft.reviewGist,
    risk: result.risk,
    truncated: result.truncated,
  };
  return JSON.stringify(persisted);
}

/**
 * 저장된 요약을 되살린다. 되살릴 수 없으면 null이고, 호출자는 그것을 캐시 miss로 다룬다.
 *
 * **던지지 않는다.** 저장 형식이 바뀌었거나 행이 손상됐다고 해서 카드가 멈추면 안 된다.
 * 되살리지 못하면 provider를 부르면 되고, 그 결과가 행을 다시 채운다.
 *
 * `fingerprint`는 호출자가 준다. 이 값을 되살리는 조건 자체가 "저장된 사실 지문이 이번
 * 관찰의 사실 지문과 같다"이므로, 그 지문이 곧 이 결과의 지문이다.
 */
export function parseSummary(json: string | null, fingerprint: string): SummaryResult | null {
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v['title'] !== 'string') return null;
  if (typeof v['what'] !== 'string') return null;
  if (typeof v['why'] !== 'string') return null;
  if (v['reviewGist'] !== null && typeof v['reviewGist'] !== 'string') return null;
  if (v['risk'] !== null && !isRisk(v['risk'])) return null;
  if (typeof v['truncated'] !== 'boolean') return null;
  return {
    kind: 'ok',
    draft: {
      title: v['title'],
      what: v['what'],
      why: v['why'],
      reviewGist: v['reviewGist'],
    },
    risk: v['risk'],
    truncated: v['truncated'],
    fingerprint,
  };
}

function isRisk(value: unknown): value is Risk {
  return value === 'high' || value === 'medium' || value === 'low';
}

export type SummarizeOptions = {
  readonly provider: SummaryProvider;
  readonly cache?: SummaryCache;
  /** 검증 실패 시 재시도 횟수. 기본 1회. */
  readonly retries?: number;
};

export async function summarize(
  facts: SummaryFacts,
  options: SummarizeOptions,
): Promise<SummaryResult> {
  const fingerprint = factsFingerprint(facts);
  const cached = options.cache?.get(fingerprint);
  if (cached !== undefined) return cached;

  const risk = deriveRisk(facts);
  const attempts = (options.retries ?? 1) + 1;
  const reasons: string[] = [];

  for (let i = 0; i < attempts; i += 1) {
    let raw: unknown;
    try {
      raw = await options.provider.complete(facts);
    } catch (e) {
      const retryable = e instanceof SummaryProviderError ? e.retryable : false;
      reasons.push(e instanceof Error ? e.message : String(e));
      if (!retryable) break;
      continue;
    }
    const validated = validateDraft(raw, facts);
    if (validated.ok) {
      const result: SummaryResult = {
        kind: 'ok',
        draft: validated.draft,
        risk,
        truncated: facts.truncated,
        fingerprint,
      };
      options.cache?.set(fingerprint, result);
      return result;
    }
    reasons.push(validated.violations.join('; '));
  }

  const failed: SummaryResult = {
    kind: 'failed',
    reason: reasons.join(' | ') || '알 수 없는 실패',
    risk,
    fingerprint,
  };
  // 실패도 캐시한다. 같은 사실로 매번 재시도해 비용을 태우지 않는다.
  options.cache?.set(fingerprint, failed);
  return failed;
}
