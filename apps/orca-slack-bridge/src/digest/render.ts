import { createHash } from 'node:crypto';
import type { SlackBlock } from '../slack/post.js';
import type { Risk } from '../summarize/validate.js';
import type { CheckFact } from '../github/pull-request.js';
import type { FindingFacts } from '../summarize/contract.js';
import type { DigestStatus, ProjectedPr, RenderInput } from './types.js';

/**
 * PR digest 카드 renderer.
 *
 * **LLM을 호출하지 않는다.** layout, 상태 문구, 링크, 표시할 사실의 선택은 전부 이 파일의
 * 코드가 결정한다. 모델이 만든 것은 `SummaryDraft`의 title/what/why/reviewGist 문자열뿐이고
 * renderer는 그 문자열을 자리에 놓기만 한다(스펙 §5.3, 로드맵 §5 출구 조건).
 *
 * 카드에 나타나는 사실의 유일한 source는 `RenderInput`이다. 여기서 GitHub·Orca·Slack을
 * 다시 읽지 않는다. 그래서 같은 입력이면 항상 같은 출력이고 `renderFingerprint`가 의미를
 * 가진다.
 *
 * 주장하지 않는 것: 성공·안전성·검증·테스트 통과. source fact에 있는 값만 옮긴다.
 * `병합 준비 완료`도 만들지 않는다. review·CI·merge 조건의 결합 판정은 C2다.
 */

/** 게시할 카드 한 장. `SlackPoster`의 `text`/`blocks`에 그대로 넘긴다. */
export type RenderedCard = {
  /** blocks를 그리지 못하는 자리(알림, 검색 결과)용 대체 텍스트. 비지 않는다. */
  readonly text: string;
  readonly blocks: readonly SlackBlock[];
};

/**
 * 상태 라벨.
 *
 * emoji와 텍스트 라벨을 항상 함께 둔다. 색이나 emoji만으로 상태를 구분하지 않는다(UX §1).
 *
 * 문구는 관찰된 사실을 넘지 않는다. `awaiting_review`는 "리뷰 진행 중"이 아니라
 * "reviewer_result가 없다"는 뜻이고, `review_approved`는 병합 준비 완료라는 주장이 아니다.
 */
const STATUS_LABEL: Readonly<
  Record<DigestStatus, { readonly emoji: string; readonly label: string }>
> = {
  merged: { emoji: '✅', label: '병합 완료' },
  closed: { emoji: '⛔', label: '병합 없이 닫힘' },
  changes_requested: { emoji: '⚠️', label: '리뷰에서 수정 요청' },
  review_approved: { emoji: '🟢', label: '리뷰 통과' },
  awaiting_review: { emoji: '🟡', label: '리뷰 결과 없음' },
};

const RISK_LABEL: Readonly<Record<Risk, string>> = {
  high: '높음',
  medium: '보통',
  low: '낮음',
};

/**
 * finding 한 줄의 문구 상한.
 *
 * `FindingFacts.summary`는 reviewer가 쓰는 자유 문자열이고 계약에 상한이 없다. Slack
 * section text는 3000자를 넘을 수 없고 findings는 최대 10건이므로(OD-033) 줄마다 상한을
 * 둔다. 자른 줄은 말줄임표로 잘렸음을 드러낸다. 조용히 지우지 않는다.
 */
const FINDING_SUMMARY_CAP = 200;

/** 요약 실패 사유 문구 상한. provider 오류와 검증 위반이 누적되면 길어진다. */
const FAILURE_REASON_CAP = 300;

/**
 * Slack mrkdwn 예약 문자를 이스케이프한다.
 *
 * PR 제목, 모델 출력, 파일 경로에 `<`나 `&`가 들어오면 Slack이 링크나 entity로 해석해
 * 원문과 다른 것을 보여준다. 대상은 Slack이 명시한 세 문자뿐이다.
 */
function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cut(value: string, cap: number): string {
  const v = value.trim();
  return v.length <= cap ? v : `${v.slice(0, cap)}…`;
}

function section(text: string): SlackBlock {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function labelled(label: string, lines: readonly string[]): SlackBlock {
  return section([`*${label}*`, ...lines].join('\n'));
}

/**
 * 카드가 표시할 상태를 사실에서 파생한다.
 *
 * 순서는 `digest/types.ts`의 `DigestStatus`가 고정한 것이고 여기서 바꾸지 않는다.
 * CI 결론, `worker_done` 유무, draft 여부, risk는 이 값에 섞이지 않는다. 각각 따로 표시한다.
 */
export function deriveStatus(pr: ProjectedPr): DigestStatus {
  if (pr.state === 'merged') return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.review?.verdict === 'request_changes') return 'changes_requested';
  if (pr.review?.verdict === 'approve') return 'review_approved';
  return 'awaiting_review';
}

/**
 * 카드 최상단 identity.
 *
 * Project가 설정에 있으면 `[Project] owner/repo #N`, 없으면 `owner/repo #N`이다(OD-047).
 * repository 이름은 표시용이며 동등성 판정에 쓰지 않는다.
 */
export function identityLine(pr: ProjectedPr): string {
  const base = `${pr.repository.nameWithOwner} #${pr.number}`;
  return pr.project === null ? base : `[${pr.project}] ${base}`;
}

function findingLine(f: FindingFacts): string {
  const where = f.line === null ? f.file : `${f.file}:${f.line}`;
  return `• [${f.severity}] ${esc(where)} — ${esc(cut(f.summary, FINDING_SUMMARY_CAP))}`;
}

function checkLine(c: CheckFact): string {
  // 집계하지 않고 required/optional을 판정하지도 않는다(OD-032). 결론을 그대로 옮긴다.
  const conclusion = c.conclusion ?? (c.status !== '' ? c.status : 'unknown');
  return `• ${esc(c.name === '' ? '(이름 없음)' : c.name)}: ${esc(conclusion)}`;
}

/**
 * 카드를 그린다.
 *
 * 요약이 실패해도 카드를 만든다. 요약 없이 사실만 남은 축소 카드를 만들고 "요약 실패"를
 * 표시한다(OD-035). 실패를 성공처럼 숨기지 않는다.
 */
export function renderCard(input: RenderInput): RenderedCard {
  const { pr, summary } = input;
  const status = deriveStatus(pr);
  const { emoji, label } = STATUS_LABEL[status];
  const identity = identityLine(pr);
  // 요약이 실패하면 PR 원문 제목이 카드 제목의 fallback이다(OD-035).
  const title = summary.kind === 'ok' ? summary.draft.title : pr.title;

  const blocks: SlackBlock[] = [];
  blocks.push(section(`${emoji} *${esc(identity)}* · ${esc(title)}`));

  if (summary.kind === 'ok') {
    blocks.push(labelled('무엇이 바뀌나', [esc(summary.draft.what)]));
    blocks.push(labelled('왜 필요한가', [esc(summary.draft.why)]));
  } else {
    blocks.push(
      labelled('요약 실패', [
        '이 카드는 요약 없이 관찰된 사실만 담는다. 제목은 PR 원문 제목이다.',
        `사유: ${esc(cut(summary.reason, FAILURE_REASON_CAP))}`,
      ]),
    );
  }

  const now = [label];
  if (pr.isDraft) now.push('• 초안(draft) PR이다');
  blocks.push(labelled('현재', now));

  const review: string[] = [];
  if (pr.review === null) {
    review.push('reviewer_result가 관찰되지 않았다');
  } else {
    review.push(`판정: ${pr.review.verdict}`);
    if (pr.review.headMatch === 'different') {
      // 사실 진술이다. 이전 approval이 아직 유효한지 판정하지 않는다(OD-031, C2).
      review.push('reviewer가 본 commit이 현재 head와 다르다');
    } else if (pr.review.headMatch === 'unknown') {
      review.push('reviewer가 본 commit을 알 수 없어 현재 head와 대조하지 못했다');
    }
    if (pr.review.findings.length === 0) {
      review.push('보고된 finding 없음');
    } else {
      review.push(...pr.review.findings.map(findingLine));
      if (pr.review.findingsTotal > pr.review.findings.length) {
        const hidden = pr.review.findingsTotal - pr.review.findings.length;
        review.push(`외 ${hidden}건은 카드에 싣지 않았다`);
      }
    }
  }
  blocks.push(labelled('리뷰', review));

  // reviewGist는 review 사실이 있을 때만 존재한다. 검증이 그것을 이미 강제한다(validate.ts).
  if (summary.kind === 'ok' && summary.draft.reviewGist !== null) {
    blocks.push(labelled('리뷰 핵심', [esc(summary.draft.reviewGist)]));
  }

  if (summary.risk !== null) {
    // risk는 reviewer findings severity에서 파생한다. 모델이 정하지 않는다(OD-037).
    blocks.push(
      labelled('위험도', [`${RISK_LABEL[summary.risk]} (reviewer findings severity 기준)`]),
    );
  }

  blocks.push(
    labelled('CI', pr.checks.length === 0 ? ['관찰된 check 없음'] : pr.checks.map(checkLine)),
  );

  const worker: string[] = [];
  if (pr.workerReport === null) {
    // worker-read fallback을 쓰지 않으므로 없음이 곧 최종 관찰이다(OD-025, OD-070).
    worker.push('worker 보고 없음');
  } else {
    worker.push(`결과: ${pr.workerReport.outcome}`);
    // 요약이 성공했다면 이 본문은 이미 요약 입력이었다. 실패했을 때만 사실 텍스트로 싣는다.
    if (summary.kind === 'failed') worker.push(esc(pr.workerReport.body));
  }
  blocks.push(labelled('worker 보고', worker));

  const truncated: string[] = [];
  if (pr.truncation.prBody) truncated.push('PR 본문이 상한에서 잘려 요약이 전체를 보지 못했다');
  if (pr.truncation.changedFiles) truncated.push('변경 파일 목록을 일부만 관측했다');
  if (truncated.length > 0) blocks.push(labelled('관측 범위', truncated));

  // PR 링크는 모든 상태에서 존재한다. C1 카드의 유일한 action이며 URL만 싣는다.
  // C1에는 interaction handler가 없다. 이 버튼은 링크를 여는 것 외에 아무 일도 하지 않는다.
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        action_id: 'pr_open',
        text: { type: 'plain_text', text: 'PR 보기' },
        url: pr.url,
      },
    ],
  });

  // blocks를 그리지 못하는 자리에서도 identity·상태·링크가 남아야 한다.
  const text = `${emoji} ${identity} · ${title} — ${label} — ${pr.url}`;

  return { text, blocks };
}

/**
 * 렌더 지문.
 *
 * 카드가 실제로 표시하는 값에서만 계산한다. 관찰 시각처럼 카드에 없는 값을 넣으면 사실이
 * 바뀌지 않아도 매 실행이 `chat.update`를 만든다(`store/schema.ts`).
 *
 * 렌더 결과 자체를 해싱한다. 필드를 손으로 나열하면 카드에 새 사실을 추가할 때 지문에 넣는
 * 것을 빠뜨려도 컴파일이 막지 못한다. 결과를 해싱하면 "지문이 같다"와 "게시할 내용이 같다"가
 * 같은 말이 된다. `renderCard`가 blocks를 고정된 순서로 만들므로 `JSON.stringify`의 키
 * 순서도 고정된다.
 */
export function renderFingerprint(card: RenderedCard): string {
  const canonical = JSON.stringify({ text: card.text, blocks: card.blocks });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}
