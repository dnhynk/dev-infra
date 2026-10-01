import { createHash } from 'node:crypto';
import { SUMMARY_CONTRACT_REVISION, type SummaryFacts } from './contract.js';

/**
 * 사실 지문.
 *
 * 관찰마다 호출하지 않고 지문이 바뀔 때만 호출한다. 비용이 polling 횟수가 아니라
 * 의미 있는 전이 횟수에 비례한다(OD-035).
 */
export function factsFingerprint(facts: SummaryFacts): string {
  // 키 순서에 의존하지 않도록 명시적으로 직렬화한다.
  const canonical = JSON.stringify([
    // 요약 계약이 바뀌면 같은 사실에서 다른 요약이 나온다. 이것이 없으면 이미 요약한 PR은
    // 사실이 다시 움직일 때까지 옛 계약의 요약을 그대로 들고 있는다.
    SUMMARY_CONTRACT_REVISION,
    facts.taskPurpose,
    facts.workerDone,
    facts.prTitle,
    facts.prBody,
    [...facts.changedPaths].sort(),
    facts.review === null
      ? null
      : [
          facts.review.verdict,
          [...facts.review.findings]
            .map((f) => [f.severity, f.file, f.line, f.summary])
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        ],
    [...facts.checks].map((c) => [c.name, c.conclusion]).sort((a, b) => String(a).localeCompare(String(b))),
    facts.truncated,
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}
