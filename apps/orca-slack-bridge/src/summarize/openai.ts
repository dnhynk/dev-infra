import { SUMMARY_JSON_SCHEMA, SYSTEM_PROMPT, renderFactsPrompt, type SummaryFacts } from './contract.js';

/** summarizer provider. 교체 가능하게 인터페이스 뒤에 둔다(OD-034). */
export interface SummaryProvider {
  /** 검증되지 않은 원시 출력을 반환한다. 검증은 호출자가 한다. */
  complete(facts: SummaryFacts): Promise<unknown>;
}

export const OPENAI_KEY_VAR = 'ORCA_SLACK_BRIDGE_OPENAI_KEY';
export const DEFAULT_MODEL = 'gpt-5.6-luna';
const ENDPOINT = 'https://api.openai.com/v1/responses';

export class SummaryProviderError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'SummaryProviderError';
  }
}

/**
 * 응답에서 생성 텍스트를 꺼낸다.
 *
 * 응답 객체의 정확한 컨테이너 이름을 문서로 확정하지 못했으므로 경로를 하드코딩하지 않는다.
 * 대신 알려진 말단 형태(`type: "output_text"`의 `text`, 또는 `refusal`)를 탐색하고,
 * 찾지 못하면 조용히 넘어가지 않고 실패한다.
 */
export function extractOutputText(response: unknown): string {
  let text: string | null = null;
  let refusal: string | null = null;

  const walk = (node: unknown, depth: number): void => {
    if (depth > 8 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const o = node as Record<string, unknown>;
    if (o['type'] === 'output_text' && typeof o['text'] === 'string') {
      text ??= o['text'];
    }
    if (typeof o['refusal'] === 'string' && o['refusal'] !== '') {
      refusal ??= o['refusal'];
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(response, 0);

  if (refusal !== null) {
    throw new SummaryProviderError(`모델이 응답을 거부했다: ${refusal}`, false);
  }
  if (text === null) {
    throw new SummaryProviderError('응답에서 output_text를 찾지 못했다', false);
  }
  return text;
}

export type OpenAiOptions = {
  readonly apiKey: string;
  readonly model?: string;
  readonly maxOutputTokens?: number;
  readonly fetchImpl?: typeof fetch;
};

export class OpenAiSummaryProvider implements SummaryProvider {
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAiOptions) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxOutputTokens = options.maxOutputTokens ?? 1024;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(facts: SummaryFacts): Promise<unknown> {
    const body = {
      model: this.model,
      input: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: renderFactsPrompt(facts) },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'pr_summary',
          strict: true,
          schema: SUMMARY_JSON_SCHEMA,
        },
      },
      max_output_tokens: this.maxOutputTokens,
    };

    let res: Response;
    try {
      res = await this.fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new SummaryProviderError(`요청 실패: ${e instanceof Error ? e.message : String(e)}`, true);
    }

    if (!res.ok) {
      // 429와 5xx는 재시도할 수 있고 4xx는 대개 계약 문제다.
      const retryable = res.status === 429 || res.status >= 500;
      throw new SummaryProviderError(`HTTP ${res.status}`, retryable);
    }

    const json: unknown = await res.json();
    const status = (json as Record<string, unknown>)['status'];
    if (status === 'incomplete') {
      const details = (json as Record<string, unknown>)['incomplete_details'];
      const reason =
        typeof details === 'object' && details !== null
          ? String((details as Record<string, unknown>)['reason'])
          : 'unknown';
      throw new SummaryProviderError(`응답이 잘렸다: ${reason}`, reason === 'max_output_tokens');
    }

    const text = extractOutputText(json);
    try {
      return JSON.parse(text);
    } catch {
      throw new SummaryProviderError(`출력이 JSON이 아니다: ${text.slice(0, 200)}`, true);
    }
  }
}
