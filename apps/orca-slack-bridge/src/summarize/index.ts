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
