import { createHash } from 'node:crypto';
import type { SlackAttachment, SlackBlock } from '../slack/post.js';
import {
  cut,
  esc,
  kst,
  listText,
  renderCardShell,
  type CardField,
  type CardTone,
} from '../slack/card.js';
import type { Risk } from '../summarize/validate.js';
import type { CheckFact } from '../github/pull-request.js';
import type { FindingFacts } from '../summarize/contract.js';
import { deriveDigestStatus } from './state.js';
import type { PrTransition, PrTransitionKind } from './transition.js';
import type { DigestStatus, MergePolicy, ProjectedPr, RenderInput } from './types.js';

/**
 * PR digest 카드 renderer.
 *
 * **LLM을 호출하지 않는다.** layout, 상태 문구, 링크, 표시할 사실의 선택은 전부 이 파일의
 * 코드가 결정한다. 모델이 만든 것은 `SummaryDraft`의 title/what/why/reviewGist 문자열뿐이고
 * renderer는 그 문자열을 자리에 놓기만 한다(스펙 §5.3, 로드맵 §5 출구 조건).
 *
 * 카드에 나타나는 사실의 유일한 source는 `RenderInput`이다. 여기서 GitHub·Orca·Slack을
 * 다시 읽지 않는다. 그래서 같은 입력이면 항상 같은 출력이고 `renderFingerprint`가 의미를
 * 가진다. 예외는 게시 직전에 찍는 "갱신" 시각 하나이고, 지문은 그 시각을 비운 렌더에서
 * 계산한다(`digest/digest.ts`).
 *
 * 주장하지 않는 것: 성공·안전성·검증·테스트 통과. source fact에 있는 값만 옮긴다.
 * `병합 준비`는 `mergePolicy` 축이 `passing`이고 그 check가 현재 head의 것일 때만 `완료`이고,
 * 같은 칸이 판정하지 않은 조건(merge queue·required review·up-to-date·conversation resolution)을
 * 함께 밝힌다(OD-032).
 *
 * 껍데기와 시각 문법은 `slack/card.ts`가 정한다(DL-074). 이 카드는 commit SHA와 finding의 파일
 * 경로를 싣지 않는다. 그 사실은 PR 원문(버튼)에 있다.
 */

/** 게시할 카드 한 장. `SlackPoster`의 `text`/`blocks`/`attachments`에 그대로 넘긴다. */
export type RenderedCard = {
  /**
   * blocks를 그리지 못하는 자리(알림, 검색 결과)용 대체 텍스트. 비지 않는다.
   *
   * blocks와 **같은** 이스케이프를 거친 값으로 만든다. 이 자리도 mrkdwn으로 해석된다.
   */
  readonly text: string;
  /** 카드 머리와 버튼. 버튼은 이 자리에만 둔다(`slack/card.ts`). */
  readonly blocks: readonly SlackBlock[];
  /** 색 바를 입힌 카드 본문. 없으면 transport가 보내지 않는다. */
  readonly attachments?: readonly SlackAttachment[];
};

/**
 * 상태별 카드 머리.
 *
 * emoji와 텍스트 라벨을 항상 함께 둔다. 색이나 emoji만으로 상태를 구분하지 않는다(UX §1).
 *
 * 문구는 관찰된 사실을 넘지 않는다. `awaiting_review`는 "리뷰 진행 중"이 아니라
 * "reviewer_result가 없다"는 뜻이고, `review_approved`는 병합 준비 완료라는 주장이 아니다.
 * draft·checks·mergePolicy는 머리에 접히지 않는다. fields가 따로 표시한다.
 */
const STATUS_HEAD: Readonly<
  Record<DigestStatus, { readonly tone: CardTone; readonly emoji: string; readonly kind: string }>
> = {
  merged: { tone: 'change', emoji: '✅', kind: '병합 완료' },
  closed: { tone: 'status', emoji: '⛔', kind: '병합 없이 닫힘' },
  changes_requested: { tone: 'attention', emoji: '⚠️', kind: '수정 요청' },
  review_approved: { tone: 'success', emoji: '🟢', kind: '리뷰 통과' },
  awaiting_review: { tone: 'entry', emoji: '🟡', kind: '리뷰 결과 없음' },
};

/**
 * required check 축 한 칸(`CI`).
 *
 * `mergePolicy`는 base branch의 effective required rule과 head rollup의 조인을 접은 값이고
 * 파생은 `digest/state.ts`의 `deriveMergePolicy`가 한다. renderer는 그 값을 문구로 옮기기만
 * 한다. 여기서 다시 판정하면 두 곳이 어긋난다.
 *
 * `통과`는 `passing`에만 붙는다. 다른 값에는 그 문구를 붙이지 않는다.
 *
 * - `no_required_rules`: required가 0개면 통과한 check가 없고 `CI 통과`는 그대로 거짓이다.
 *   아무것도 돌지 않은 PR을 통과로 그리지 않는다. 이 축이 막지 않는다는 사실만 적는다.
 * - `rules_unreadable`: rule 집합을 모르므로 어떤 충족 주장도 관측을 넘는다.
 * - `missing`과 `indeterminate`를 같은 문구로 합치지 않는다. 앞은 아무도 보고하지 않았다는
 *   확정이고 뒤는 보고 주체를 관측할 수 없어 판정 자체가 불가능한 상태다
 *   (`github/required-checks.ts`).
 */
const MERGE_POLICY_VALUE: Readonly<Record<MergePolicy, string>> = {
  no_required_rules: '지정 없음 · merge를 막지 않음',
  rules_unreadable: '확인 불가 · required 규칙 미판독',
  passing: '통과',
  pending: '진행 중',
  failing: '실패',
  missing: '미보고 · required check 누락',
  indeterminate: '판정 불가 · 보고 주체 미확인',
};

/**
 * required check 축이 보지 않는 merge 조건(OD-032).
 *
 * required review·conversation resolution(리뷰), merge queue, up-to-date(최신화)다. `병합 준비` 칸과
 * `required check 통과` 전이가 이 문구를 함께 단다. 범위를 밝히지 않으면 required review로 막힌
 * PR을 병합 가능으로 읽게 된다.
 */
const UNJUDGED_CONDITIONS = '리뷰·merge queue·최신화 조건 미확인';

const RISK_LABEL: Readonly<Record<Risk, string>> = {
  high: '높음',
  medium: '보통',
  low: '낮음',
};

/** finding severity. 위험도 파생(`summarize/validate.ts`의 `deriveRisk`)과 같은 순서다. */
const SEVERITY_LABEL: Readonly<Record<FindingFacts['severity'], string>> = {
  blocker: '높음',
  major: '보통',
  minor: '낮음',
};

/**
 * finding 한 줄의 문구 상한.
 *
 * `FindingFacts.summary`는 reviewer가 쓰는 자유 문자열이고 계약에 상한이 없다. findings는 최대
 * 10건이므로(OD-033) 줄마다 상한을 둔다. 자른 줄은 말줄임표로 잘렸음을 드러낸다.
 */
const FINDING_SUMMARY_CAP = 200;

/** 요약 실패 사유 문구 상한. provider 오류와 검증 위반이 누적되면 길어진다. */
const FAILURE_REASON_CAP = 300;

/** check 이름 한 줄의 상한. 이름은 workflow가 정하는 자유 문자열이다. */
const CHECK_NAME_CAP = 100;

/** check 목록에 싣는 줄 수. 나머지는 수로 남긴다. */
const CHECK_LIST_CAP = 10;

/**
 * GitHub check 결론의 우리말. 모르는 값은 원문 그대로 둔다 — 이름이 없다고 사실을 지우지 않는다.
 *
 * `CheckRun.conclusion`·`CheckRun.status`·`StatusContext.state`가 같은 표를 쓴다.
 */
const CHECK_CONCLUSION: Readonly<Record<string, string>> = {
  SUCCESS: '성공',
  FAILURE: '실패',
  ERROR: '오류',
  NEUTRAL: '중립',
  CANCELLED: '취소',
  SKIPPED: '건너뜀',
  TIMED_OUT: '시간 초과',
  ACTION_REQUIRED: '조치 필요',
  STALE: '오래됨',
  STARTUP_FAILURE: '시작 실패',
  PENDING: '대기',
  EXPECTED: '보고 대기',
  QUEUED: '대기',
  WAITING: '대기',
  REQUESTED: '요청됨',
  IN_PROGRESS: '진행 중',
  COMPLETED: '완료',
};

/**
 * 요약 실패 카드가 싣는 worker 본문 상한.
 *
 * 계약은 정확히 세 문장이지만(contracts §3) 실제 worker는 지키지 않는다. 실측에서 한 건이
 * 1,000자를 넘어 카드 전체가 그 덤프가 됐다. 사실을 지우지 않되 카드를 삼키지도 않는다.
 */
const WORKER_BODY_CAP = 400;

/**
 * PR identity.
 *
 * Project가 설정에 있으면 `[Project] owner/repo #N`, 없으면 `owner/repo #N`이다(OD-047).
 * repository 이름은 표시용이며 동등성 판정에 쓰지 않는다. 카드에서는 대체 텍스트와 thread
 * 전이의 머리가 쓰고, 루트 카드 본문은 같은 사실을 `저장소`·`Project` 칸으로 나눠 싣는다.
 */
export function identityLine(pr: ProjectedPr): string {
  const base = `${pr.repository.nameWithOwner} #${pr.number}`;
  return pr.project === null ? base : `[${pr.project}] ${base}`;
}

function reviewValue(pr: ProjectedPr): string {
  if (pr.review === null) return '결과 없음';
  const total = pr.review.findingsTotal;
  return [
    pr.review.verdict === 'approve' ? '통과' : '수정 요청',
    total === 0 ? 'finding 없음' : `finding ${total}건`,
    // 사실 진술이다. 이전 approval이 아직 유효한지 판정하지 않는다(OD-031, C2).
    pr.review.headMatch === 'different'
      ? '이전 커밋 기준'
      : pr.review.headMatch === 'unknown'
        ? '커밋 대조 불가'
        : null,
  ].filter((part): part is string => part !== null).join(' · ');
}

function ciValue(pr: ProjectedPr): string {
  const axis = MERGE_POLICY_VALUE[pr.mergePolicy];
  // 조회 계층의 bounded 재관측(OD-044) 뒤에도 남은 불일치다. 이 한정 없이 축을 그리면 다른
  // commit의 결론이 현재 head의 것으로 읽힌다.
  return pr.checksHeadSha === pr.headSha ? axis : `${axis} · 최신 커밋 기준 아님`;
}

/**
 * `병합 준비` 칸.
 *
 * `docs/contracts/observation-and-correlation.md` §6은 `Merge Ready`를 GitHub 단일 필드가 아니라
 * **required check만으로 판정하는 derived state**로 정의했고 OD-032가 그렇게 확정했다. 그래서
 * `완료`는 축이 `passing`일 때만 나오고 같은 칸이 판정하지 않은 조건을 밝힌다. check가 현재
 * head의 것이 아니면 `passing`은 다른 commit의 사실이므로 `완료`라고 쓰지 않는다.
 */
function mergeReadyValue(pr: ProjectedPr): string {
  return pr.mergePolicy === 'passing' && pr.checksHeadSha === pr.headSha
    ? `완료 · required check 기준 · ${UNJUDGED_CONDITIONS}`
    : `미판정 · ${UNJUDGED_CONDITIONS}`;
}

/** 관측이 잘린 지점. 원인이 다르므로 둘을 한 표시로 합치지 않는다(UX §6). */
function observedScope(pr: ProjectedPr): string {
  const parts = [
    // 카드 본문이 아니라 요약 입력이 잘렸다. 요약이 본문 전체를 보지 못했다는 뜻이다.
    pr.truncation.prBody ? '요약 입력 PR 본문 일부' : null,
    pr.truncation.changedFiles ? '변경 파일 일부' : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? '전체' : parts.join(' · ');
}

function findingLine(f: FindingFacts): string {
  // 파일 경로를 싣지 않는다(DL-074). 위치는 PR 원문에서 본다.
  return `${SEVERITY_LABEL[f.severity]} · ${esc(cut(f.summary, FINDING_SUMMARY_CAP))}`;
}

/**
 * check 한 줄.
 *
 * 집계하지 않고 required/optional을 판정하지도 않는다(OD-032). 결론을 그대로 옮긴다. merge를 막는지는
 * `CI` 칸(required check 축)이 말한다. 이 목록이 없으면 required rule이 없는 저장소에서 실패한 check가
 * 카드 어디에도 나타나지 않고, 그 실패는 카드를 갱신하지도 못한다.
 */
function checkLine(c: CheckFact): string {
  // StatusContext row에는 conclusion도 status도 없고 state만 있다.
  const raw = c.conclusion ?? c.state ?? (c.status !== '' ? c.status : null);
  const conclusion = raw === null ? '확인 불가' : CHECK_CONCLUSION[raw] ?? esc(raw);
  const name = c.name.trim() === '' ? '확인 불가 · 이름 없음' : esc(cut(c.name, CHECK_NAME_CAP));
  return `${name} · ${conclusion}`;
}

/**
 * 카드를 그린다.
 *
 * 요약이 실패해도 카드를 만든다. 요약 없이 사실만 남은 축소 카드를 만들고 "요약 실패"를
 * 표시한다(OD-035). 실패를 성공처럼 숨기지 않는다.
 *
 * `refreshedAt`은 게시 직전의 "갱신" 시각이다. null이면 시각 없이 그린다 — 렌더 지문은 그
 * 렌더에서 계산하므로 시각만 바뀐 관찰은 `chat.update`를 만들지 않는다.
 */
export function renderCard(input: RenderInput, refreshedAt: string | null = null): RenderedCard {
  const { pr, summary } = input;
  // 파생은 `digest/state.ts` 하나뿐이다. renderer가 같은 판정을 다시 쓰지 않는다.
  const status = deriveDigestStatus(pr);
  const head = STATUS_HEAD[status];
  // 요약이 실패하면 PR 원문 제목이 카드 제목의 fallback이다(OD-035).
  const title = summary.kind === 'ok' ? summary.draft.title : pr.title;

  const fields: CardField[] = [
    ['저장소', `${esc(pr.repository.nameWithOwner)} · #${pr.number}${pr.isDraft ? ' · 초안' : ''}`],
    ['Project', pr.project === null ? '미등록' : esc(pr.project)],
    ['리뷰', reviewValue(pr)],
    ['CI', ciValue(pr)],
    // 위험도는 reviewer findings severity에서만 나온다(OD-037). 리뷰가 없으면 셀 근거가 없다.
    ['위험도', summary.risk === null ? '계산 불가 · 리뷰 결과 없음' : RISK_LABEL[summary.risk]],
    ['병합 준비', mergeReadyValue(pr)],
  ];

  const sections: string[] = [];
  if (summary.kind === 'ok') {
    sections.push(`${esc(summary.draft.what)} ${esc(summary.draft.why)}`);
  } else if (pr.workerReport !== null) {
    // 요약이 없으면 worker 보고 본문이 사람이 읽는 유일한 사실 텍스트다. 성공했다면 그 본문은 이미
    // 위 요약의 입력이었으므로 다시 싣지 않는다.
    sections.push(esc(cut(pr.workerReport.body, WORKER_BODY_CAP)));
  }
  if (pr.review !== null) {
    const items: string[] = [];
    // reviewGist는 review findings가 있을 때만 존재한다. 검증이 그것을 이미 강제한다(validate.ts).
    if (summary.kind === 'ok' && summary.draft.reviewGist !== null) {
      items.push(`_${esc(summary.draft.reviewGist)}_`);
    }
    items.push(...pr.review.findings.map(findingLine));
    const hidden = pr.review.findingsTotal - pr.review.findings.length;
    if (hidden > 0) items.push(`외 ${hidden}건은 카드에 싣지 않았다`);
    if (items.length > 0) sections.push(listText('finding', items));
  }
  if (pr.checks.length > 0) {
    const checks = pr.checks.slice(0, CHECK_LIST_CAP).map(checkLine);
    const hidden = pr.checks.length - checks.length;
    if (hidden > 0) checks.push(`외 ${hidden}개는 카드에 싣지 않았다`);
    sections.push(listText('check', checks));
  }

  // worker-read fallback을 쓰지 않으므로 없음이 곧 최종 관찰이다(OD-025, OD-070).
  const dashboard: CardField[] = [
    [
      'worker 보고',
      pr.workerReport === null ? '없음' : pr.workerReport.outcome === 'succeeded' ? '완료' : '실패',
    ],
    ['관측 범위', observedScope(pr)],
    ['요약', summary.kind === 'ok' ? '있음' : `실패 · ${esc(cut(summary.reason, FAILURE_REASON_CAP))}`],
  ];

  return renderCardShell({
    tone: head.tone,
    emoji: head.emoji,
    kind: head.kind,
    head: title,
    // blocks와 fallback text가 **같은** 이스케이프를 쓴다. 두 경로가 각자 이스케이프하면 한쪽만
    // 고쳐지고, 그때 새는 쪽은 항상 fallback이다. PR 제목은 untrusted input이고(스펙 §10)
    // 이스케이프하지 않은 `<!channel>` 하나가 카드 한 번에 workspace 전체를 깨운다.
    text: `${head.emoji} ${esc(identityLine(pr))} · ${esc(title)} — ${head.kind}`,
    // PR 링크는 모든 상태에서 존재한다. 카드의 유일한 링크이며 URL만 싣는다. 이 버튼은 링크를
    // 여는 것 외에 아무 일도 하지 않는다.
    actions: [{
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'pr_open',
          text: { type: 'plain_text', text: 'PR 보기' },
          url: pr.url,
        },
      ],
    }],
    fields,
    sections,
    dashboard,
    footer: { at: refreshedAt, verb: '갱신', basis: 'GitHub·Orca 기준' },
  });
}

/**
 * 렌더 지문.
 *
 * 카드가 실제로 표시하는 값에서만 계산한다. 관찰 시각처럼 관찰마다 움직이는 값을 넣으면 사실이
 * 바뀌지 않아도 매 실행이 `chat.update`를 만든다(`store/schema.ts`). 살아 있는 카드의 "갱신"
 * 시각은 호출자가 그 시각을 비운 렌더를 넘겨 뺀다.
 *
 * 렌더 결과 자체를 해싱한다. 필드를 손으로 나열하면 카드에 새 사실을 추가할 때 지문에 넣는
 * 것을 빠뜨려도 컴파일이 막지 못한다. 결과를 해싱하면 "지문이 같다"와 "게시할 내용이 같다"가
 * 같은 말이 된다. renderer가 blocks를 고정된 순서로 만들므로 `JSON.stringify`의 키 순서도
 * 고정된다. attachments가 없는 카드의 지문은 attachments를 도입하기 전과 같다.
 */
export function renderFingerprint(card: RenderedCard): string {
  const canonical = JSON.stringify(
    card.attachments === undefined
      ? { text: card.text, blocks: card.blocks }
      : { text: card.text, blocks: card.blocks, attachments: card.attachments },
  );
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/**
 * thread 전이 한 장의 머리와 판정 칸.
 *
 * `docs/ux/slack-surfaces.md` §5가 정한 thread event 최소 필드는 transition type, occurred/observed
 * time, 짧은 설명 셋이다. type은 머리가, 설명은 판정 칸이, 시각은 footer가 낸다.
 *
 * 카드와 같은 규율이다. emoji만으로 상태를 구분하지 않고(UX §1), 관찰된 사실을 넘는 문구를
 * 쓰지 않는다. `checks_passing`이 카드의 `병합 준비`와 같은 범위 단서를 다는 이유도 같다 —
 * required check 축은 merge 가능 여부의 최종 답이 아니다(OD-032).
 */
type TransitionHead = {
  readonly tone: CardTone;
  readonly emoji: string;
  readonly kind: string;
  readonly field: CardField;
};

/**
 * 채널에도 함께 띄울 전이(Slack `reply_broadcast`).
 *
 * thread reply는 그 thread를 따르지 않는 사람에게 알림을 보내지 않고 채널에도 나타나지 않는다.
 * 자리에 없는 owner에게는 사실상 보이지 않는다는 뜻이다.
 *
 * OD-072를 좁게 읽으면 owner 개입이 필수인 사실만 알려야 하고 PR 전이는 전부 coordinator가
 * 처리하므로 하나도 해당되지 않는다. 그러나 owner가 "리뷰 요청·CI 실패·merge 준비는 알림으로
 * 받고 싶다"고 명시적으로 요구했다. 그래서 그 셋만 켠다.
 *
 * `review_approved`와 `merged`는 끈다. 앞의 셋과 함께 켜면 PR 하나가 채널 알림 다섯 개가 되고,
 * 그러면 정작 결정이 필요한 Gate가 그 안에 묻힌다.
 */
export const BROADCAST_TRANSITIONS: ReadonlySet<PrTransitionKind> = new Set([
  'review_changes_requested',
  'checks_failing',
  'checks_passing',
]);

const TRANSITION_HEAD: Readonly<Record<PrTransitionKind, TransitionHead>> = {
  review_changes_requested: {
    tone: 'attention',
    emoji: '⚠️',
    kind: '수정 요청',
    field: ['리뷰', 'reviewer 판정 수정 요청'],
  },
  review_approved: {
    tone: 'success',
    emoji: '🟢',
    kind: '리뷰 통과',
    field: ['리뷰', 'reviewer 판정 통과 · 병합 준비 판정 아님'],
  },
  checks_failing: {
    tone: 'error',
    emoji: '❌',
    kind: 'required check 실패',
    field: ['CI', 'required check 중 실패 있음'],
  },
  checks_passing: {
    tone: 'success',
    emoji: '🟢',
    kind: 'required check 통과',
    field: ['CI', `required check 전부 충족 · ${UNJUDGED_CONDITIONS}`],
  },
  merged: { tone: 'change', emoji: '✅', kind: '병합 완료', field: ['상태', '병합 완료'] },
};

/** `renderThreadEvent` 입력. 카드와 같은 규율로 여기 없는 값은 thread에 나타나지 않는다. */
export type ThreadEventInput = {
  readonly pr: ProjectedPr;
  readonly transition: PrTransition;
  /** 이 전이를 관측한 시각. ISO8601이다. */
  readonly observedAt: string;
};

/**
 * thread reply 하나를 그린다.
 *
 * 카드 renderer와 같은 파일에 둔다. 둘 다 LLM을 부르지 않고 입력에서 결정적으로 나오는
 * Slack 렌더링이며, 상태 문구를 나눠 두면 한쪽만 고쳐진다.
 *
 * **발생 시각과 관측 시각을 구분한다.** footer는 발생 시각이 있으면 `발생`으로, 없으면 관측
 * 시각을 `관측`으로 적는다. 발생 시각이 null이면 그 사실이 시각을 싣고 있지 않다는 뜻이고, 그때
 * 관측 시각을 발생 시각인 척하지 않는다(UX §5). 둘 다 있으면 관측 시각은 칸으로 남는다.
 */
export function renderThreadEvent(input: ThreadEventInput): RenderedCard {
  const { pr, transition, observedAt } = input;
  const head = TRANSITION_HEAD[transition.kind];
  const identity = identityLine(pr);

  const fields: CardField[] = [head.field];
  if (transition.kind === 'review_changes_requested' && pr.review !== null) {
    fields.push(['finding', pr.review.findingsTotal === 0 ? '없음' : `${pr.review.findingsTotal}건`]);
  }
  if (transition.occurredAt !== null) fields.push(['관측', kst(observedAt)]);

  return renderCardShell({
    tone: head.tone,
    emoji: head.emoji,
    kind: head.kind,
    // thread reply는 루트 아래에 붙지만 broadcast 사본과 알림 자리에는 그 맥락이 없다.
    head: identity,
    text: `${head.emoji} ${esc(identity)} · ${head.kind} — ${kst(observedAt)}`,
    fields,
    footer: transition.occurredAt === null
      ? { at: observedAt, verb: '관측', basis: 'GitHub·Orca 기준' }
      : { at: transition.occurredAt, verb: '발생', basis: 'GitHub·Orca 기준' },
  });
}
