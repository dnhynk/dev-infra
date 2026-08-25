# D2-D — Gate 직접 입력 modal + fake 최종 수용 evidence

기준일은 2026-08-25다. 이 변경은 `origin/main`의 merge commit
`b6708ae50275c975b09ffc07abf136c79cc1c896`에서 시작한 독립 branch
`dnhynk/d2-direct-input-modal`에만 있다. 실제 Slack workspace나 실제 Orca Gate에는 쓰지
않았고, SQLite temp 파일·in-memory fake·localhost WebSocket·주입한 `fetch`만 사용했다.

## 범위와 결론

D2-C의 fixed-option `gate_resolution` winner, ACK fence, lease, Orca
pre-read/resolve/post-read, durable outbox, card projection을 그대로 재사용한다. 새 ingress는 Gate
카드의 `직접 입력` button과 그 button이 연 modal의 `view_submission`뿐이다. 일반 Slack message,
channel/thread text, coordinator prompt를 수집하거나 전달하는 경로는 만들지 않았다.

- pending + matched + message-correlated Gate만 fixed buttons와 분리된 direct actions block을
  가진다. direct block/action/value/callback/input ID prefix는 fixed-option prefix와 다르고 모든
  값은 Gate key에서 결정적으로 파생된다. fixed option ID의 허용 문법은
  `[A-Za-z0-9_-]+`이고 direct winner sentinel은 `orca:direct-input:v1`이라 충돌할 수 없다.
- button envelope는 Socket Mode `interactive` + `block_actions`, team, exact user, app ID(설정돼
  있으면 설정값과 대조하고 없으면 인증된 payload 값을 session에 고정), Agent Runs channel,
  message/container/thread, direct ID 전체를 검사한다. SQLite가 message → Gate metadata → current
  local observation을 다시 대조한다.
- valid button은 server-owned UUID session을 `prepared`로 먼저 저장하고 ACK한 뒤, current
  sidecar를 `BEGIN IMMEDIATE`에서 다시 확인하며 `opening` CAS를 얻은 한 호출자만
  `views.open`을 한 번 호출한다. trigger ID는 opener 호출 인수로만 지나가며 저장하지 않는다.
- modal callback/input IDs와 opaque private metadata는 Gate/session에 연결된다. submission은
  team/user/app/view/callback/private metadata/current Agent Runs channel과 server sidecar를 exact
  대조한다. 클라이언트 metadata만으로 Gate를 선택하지 않는다.
- required/value/format 오류는 server session의 정확한 `input_block_id`에
  `response_action: errors`를 ACK한다. 유효 text는 앞뒤 공백과 newline을 보존하되 empty,
  whitespace-only, UTF-16 length 3000 초과, 허용하지 않은 C0/DEL control 문자를 거부한다.
- 유효 submission은 shared `gate_resolution(gate_key PRIMARY KEY)`에 direct sentinel과 원문을
  쓰고 modal `accepted`, outbox, claimed audit을 같은 `BEGIN IMMEDIATE` transaction에 기록한다.
  ACK 성공이 durable `ack_state=acked`로 승격된 뒤에만 기존 engine을 비동기로 시작한다.
- 결과 카드는 `직접 입력`, Orca resolution lifecycle, durable delivery 상태와
  `Coordinator 통지 대기`를 표시한다. D3 task resume나 coordinator 적용 완료를 주장하지 않는다.

## 저장 계약

Schema v10은 additive `gate_direct_modal` table과 Gate/state index만 더한다. v9 행을 추측해
backfill하지 않는다. raw trigger, Socket token, unaccepted input은 컬럼에 없다.

| state | revision | durable evidence | submission 권한 |
|---|---:|---|---|
| `prepared` | 0 | exact button event hash + Gate/Slack/server IDs | 없음 |
| `opening` | 1 | non-replayable open edge를 한 caller가 소유 | 없음 |
| `opened` | 2 | exact Slack view/team/app/callback/private-metadata response 확인 | 있음 |
| `failed` | 2 | 고정된 redacted failure code | 없음 |
| `accepted` | 3 | exact view + accepted resolution + same-Gate direct intent | exact duplicate 비교만 허용 |

Startup은 table/index DDL과 컬럼 순서뿐 아니라 모든 modal state/revision/evidence, Gate
metadata/message/observation correlation, accepted modal ↔ direct intent 1:1, direct/fixed source,
orphan outbox를 한 SQLite read snapshot에서 검사한다. 알려지지 않은 code-owned table/index/trigger와
일관되게 변조한 whitespace/control resolution도 fail closed한다.

Button redelivery의 `action_ts`와 exact identities를 SHA-256한 값은 한 Slack delivery의 best-effort
dedupe key다. Slack이 그것을 영구 event ID라고 보장한다고 주장하지 않는다. Gate별 winner의
권위는 이 hash가 아니라 shared `gate_resolution` primary key다.

## 3초 경계와 production SDK seam

한 handler-wide 최대 3000 ms monotonic budget을 ACK와 `views.open`이 공유한다. local SQLite
headroom은 1750 ms이고 `SQLITE_BUSY`만 budget 안에서 짧게 재시도한다. invalid event도 ACK
callback을 논리적으로/물리적으로 한 번만 호출하고, valid button은 ACK 성공 뒤 남은 시간만
opener에 넘긴다. 이 fast path에서 Orca read/resolve는 호출하지 않는다.

설치된 `@slack/socket-mode` 3.0.0을 localhost WebSocket에 실제로 연결해 daemon router가 받은
interactive envelope, empty button ACK, handler가 만든 block-specific errors ACK의 exact frame을
확인했다. 설치된 `@slack/web-api` 8.0.0의 `WebClient.views.open`도 실제로 실행하되 `fetch`만
local fake로 주입해 `POST https://slack.com/api/views.open`, Bearer header, form key
`trigger_id` + JSON `view`를 확인했다. 같은 composition test가 실제 Socket SDK →
`runDaemonCommand` → direct handler → 실제 WebClient 경계를 한 번에 통과한다.

Production opener는 call마다 fresh WebClient, zero retry, immediate 429 rejection, remaining-budget
timeout, single concurrency, silent logger를 사용한다. SDK/platform/HTTP/transport 오류는 cause,
response data, token, trigger, modal diagnostics를 복사하지 않는 고정 code/error로 바꾼다. Orca
`gate-resolve` runner rejection, non-JSON output, error envelope도 free-form resolution이 error
message/stack/cause/data로 나오지 않게 고정 오류로 바꾼다.

## Fault / restart matrix

| 경계 | crash 직전 durable 상태 | restart/redelivery 동작 | 사실인 보장과 남는 창 |
|---|---|---|---|
| modal prepare 전 | session 없음 | invalid/store failure ACK 1회, remote 0회 | resolution mutation 없음 |
| `prepared` 후 button ACK 전 | `prepared` | ACK되지 않은 exact redelivery가 current sidecar를 다시 확인하고 open 가능 | process crash 자체는 ACK하지 않음 |
| physical button ACK 후 open edge 전 | `prepared` | exact redelivery가 있을 때만 revalidate + one open | Slack이 accepted ACK를 redeliver하지 않으면 modal이 유실될 수 있음 |
| `opening` CAS 후 API 전 | `opening` | trigger를 재생하지 않고 duplicate 처리 | modal 없음, session은 fail-closed `opening`에 남을 수 있음 |
| `views.open` 적용/응답 유실 또는 응답 후 persist 전 | `opening` | trigger 재시도 없음; submission 거부 | Slack에 modal이 보일 수 있지만 local `opened` 증거가 없어 Orca 0회 |
| open response identity mismatch/timeout | `failed` 또는 store 실패 시 `opening` | submission 거부 | late remote application을 취소했다고 주장하지 않음 |
| exact `opened` persist 후 | `opened` | restart 뒤 exact submission 가능 | client metadata만 신뢰하지 않고 current sidecar 재검증 |
| direct winner claim 후 submission ACK 전 | modal `accepted` + intent `pending` + outbox | ACK되지 않은 exact redelivery가 original request UUID를 보존해 승격 가능 | startup engine은 `pending`을 실행하지 않음 |
| physical submission ACK 후 local ACK 승격 전 | intent `pending` | exact redelivery가 있으면 복구; 없으면 quarantine | Slack ACK와 SQLite bit 사이 distributed transaction이 없어 제거 불가 |
| ACK 실패 | intent `failed`(또는 ACK-state write 자체 실패 시 `pending`) | ordinary startup reconcile 대상 아님 | remote Orca 0회; D2-C fail-closed 정책과 같음 |
| durable `acked` 후 async schedule 전 | intent `acked` + outbox | startup `reconcile()`가 이어서 처리 | ACK-confirmed restart recovery 보장 |
| Orca mutation response loss | `resolving`, ownership unknown | exact post-read; 같은 text여도 structured response 없으면 `degraded/ownership ambiguous` | blind resolve retry나 exactly-once remote application을 주장하지 않음 |
| resolve result/post-read 전후 | D2-C lifecycle + renewable lease | lease/revision fence로 stale worker 차단, startup 이어받기 | Orca에는 Gate CAS가 없어 외부 resolver TOCTOU는 남음 |
| card projection 전/응답 유실/commit 후 | durable outbox pending/owner/revision | idempotent same-message update를 replay하고 stale completion을 거부 | Slack remote update와 local commit은 원자적이지 않음 |
| D2 card delivery 완료 | card outbox settled, notification pending | D2 reconcile은 카드만 유지 | D3 coordinator notification/task resume는 범위 밖 |

서로 다른 direct modal 둘, direct-vs-fixed, independent SQLite connection 둘의 경쟁은
`BEGIN IMMEDIATE`와 한 Gate PK로 winner 하나만 만든다. exact accepted redelivery만 duplicate이고
다른 text/session/user/team/app은 lost/rejected다. 여러 distinct button click이 modal 여러 개를
열 수는 있다. 또한 `views.open` edge 직후 fixed option이 먼저 winner를 claim하면 이미 열린
modal은 남을 수 있지만 그 submission은 lost되고 두 번째 Orca mutation을 만들지 않는다.

## 검증 결과

모든 명령은 repository root에서 실행했다. test가 만든 temp SQLite 파일은 test 종료 때 지웠고,
Socket/Web API 검증은 localhost/fake transport만 썼다.

| 명령 | 결과 |
|---|---|
| focused D2-D/D2-C/socket/daemon suite | pass — 13 files, 250 tests; direct handler/store/privacy, SDK/Web API, daemon, fixed resolver/store/engine/project/publish 포함 |
| `pnpm test` | pass — 43 files, 1015 tests |
| `pnpm typecheck` | pass |
| `pnpm --filter @dev-infra/orca-slack-bridge typecheck` | pass |
| `pnpm --filter @dev-infra/orca-slack-bridge build` | pass |
| `pnpm audit --audit-level high` | pass — high 이상 취약점 없음 |
| `git diff --check` | pass |

Focused coverage에는 다음이 포함된다.

- direct button → actual ACK → actual `views.open` request → invalid submission actual errors ACK →
  valid submission ACK → async fake Orca resolve → durable outbox/card projection 전체 관통
- non-owner/team/app/channel, malformed action/container/trigger/view/state, unknown/missing/mismatched
  sidecar, stale observation, fixed winner 뒤 prepared redelivery: ACK 1, modal/Orca 0
- empty/whitespace, 3000/3001, C0/DEL, block/action mismatch, exact whitespace/newline preservation
- duplicate/concurrent button open count 1, distinct direct sessions, direct-vs-fixed winner 1,
  independent SQLite connections, restart pending/failed/acked states
- modal prepare/ACK/open/API/persist와 submission claim/physical ACK/durable ACK/schedule crash points,
  Orca response-loss/lease/projection fault suite
- v9→v10 migration, exact DDL, extra trigger/index, impossible revision/state, malformed accepted text,
  orphan/cross-table startup corruption
- error/DB/audit에 token, trigger, unaccepted input, secret-bearing SDK/Orca diagnostics가 복사되지 않음

최종 두 독립 read-only audit와 exact-head GitHub CI는 문서 확정 뒤의 tree/commit을 대상으로 하므로
그 결과는 PR 본문과 worker completion에 기록한다. 결과를 이 파일에 사후 추가해 감사받은 tree를
바꾸는 순환은 만들지 않는다.

## 보장하지 않는 것 / live 미실행

- Slack ACK, `views.open`, SQLite, Orca, Slack card update 사이의 distributed atomicity는 없다.
  특히 accepted ACK 뒤 local promotion 전 crash는 Slack redelivery 없이는 자동 복구할 수 없다.
- `opening`에서 process가 죽었거나 open response가 유실되면 trigger를 재생하지 않는다. modal이
  실제 열렸는지 Slack readback으로 추측하지 않고 submission을 fail closed한다.
- synchronous SQLite/OS call 자체가 process를 멈추는 상황을 JS timer가 선점한다고 주장하지
  않는다. 정상 production seam과 injected async transports의 3초 budget만 검증했다.
- D2-C가 이미 문서화한 Orca non-CAS 외부 resolver race와 Slack update delivery-unknown ordering은
  그대로다. direct input이 그것을 exactly once로 바꾸지 않는다.
- modal session retention/GC와 사람이 여러 modal 중 무엇을 닫을지는 이번 범위가 아니다.
- 실제 Slack app/workspace에서 button을 누르거나 modal을 열지 않았다. 실제 Orca
  `gate-resolve`, task/dispatch 변화, coordinator resume도 실행하지 않았다. 따라서 D3 효과나 실제
  task resume를 수용했다고 주장하지 않는다.
