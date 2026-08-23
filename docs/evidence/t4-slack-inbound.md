# T4 · Slack Socket Mode와 interaction payload 조사

- [관측] 조사일은 2026-08-23이고, 대상은 OD-041·OD-042·OD-046·OD-071 및 D2가 받을 `block_actions`이다.
- [관측] 이 Task에서는 Slack workspace write, Slack App 설정 변경, 실제 Socket Mode 연결, 버튼 클릭, modal 제출을 실행하지 않았다.
- [관측] 의존성을 설치하지 않았고 테스트·빌드도 실행하지 않았다.
- [문서] 기존 `docs/ops/slack-app-setup.md`에는 2026-08-22 `auth.test`와 `apps.connections.open` 성공, 실제 WebSocket 연결은 미실행이라고 기록돼 있다.
- [관측] 아래의 Slack 동작은 공식 Slack 문서와 Slack이 배포한 패키지 메타데이터로 확인했고, 저장소 구현 대조는 파일 읽기로만 수행했다.
- [추론] 문서가 수명·재전송·중복 제거를 보장하지 않는 곳에는 안전한 쪽의 구현 전제를 적었지만, 열린 OD의 선택을 확정하지 않았다.

## (a) OD-041 · Socket Mode

### [근거: 문서 URL 또는 실행 명령]

- [문서] Socket Mode 프로토콜: <https://docs.slack.dev/apis/events-api/using-socket-mode/>
- [문서] HTTP와 Socket Mode 비교: <https://docs.slack.dev/apis/events-api/comparing-http-socket-mode/>
- [문서] HTTP Request URL: <https://docs.slack.dev/apis/events-api/using-http-request-urls/>
- [문서] `apps.connections.open`: <https://docs.slack.dev/reference/methods/apps.connections.open/>
- [문서] `connections:write`: <https://docs.slack.dev/reference/scopes/connections.write/>
- [문서] 토큰 유형: <https://docs.slack.dev/authentication/tokens/>
- [문서] Bolt의 acknowledgement: <https://docs.slack.dev/tools/bolt-js/concepts/acknowledge/>
- [문서] Node Socket Mode 클라이언트: <https://docs.slack.dev/tools/node-slack-sdk/reference/socket-mode/>
- [문서] `SocketModeOptions`: <https://docs.slack.dev/tools/node-slack-sdk/reference/socket-mode/interfaces/SocketModeOptions/>
- [문서] 2026-07 Node Slack SDK release: <https://docs.slack.dev/changelog/2026/07/14/node-slack-sdk-release/>
- [문서] Socket Mode v3 migration: <https://docs.slack.dev/tools/node-slack-sdk/migration/socket-mode/migrating-socket-mode-package-to-v3/>
- [문서] 2026-07 Bolt for JS v5 release: <https://docs.slack.dev/changelog/2026/07/15/bolt-js-release/>
- [문서] Bolt v5 migration: <https://docs.slack.dev/tools/bolt-js/migration/migration-v5/>
- [관측] `npm view @slack/socket-mode version time.modified repository.url engines --json`은 `3.0.0`, `2026-07-14T17:56:43.723Z`, Slack의 `node-slack-sdk`, Node `>=20`을 반환했다.
- [관측] `npm view @slack/bolt version time.modified repository.url engines --json`은 `5.0.0`, `2026-07-15T18:48:23.485Z`, Slack의 `bolt-js`, Node `>=20`을 반환했다.
- [관측] `Get-Content package.json`은 이 저장소의 Node engine을 `>=26`으로 표시했다.
- [관측] `Get-Content apps/orca-slack-bridge/src/slack/verify.ts`와 `Get-Content docs/ops/slack-app-setup.md`로 기존 검증 범위를 대조했다.

### [확인된 사실]

#### 연결 권한과 수명

- [문서] Socket Mode 연결에는 `xapp-` app-level token과 app-level scope `connections:write`가 필요하고, 그 토큰으로 `apps.connections.open`을 호출한다.
- [문서] `apps.connections.open`의 생성된 Facts 상자는 scope가 없다고 표시하지만, 전용 scope 문서와 Socket Mode 설정 문서는 `connections:write`를 명시한다.
- [추론] 위 문서 불일치에는 전용 scope 문서와 설정 절차를 적용해야 하며, bot/user OAuth scope가 별도로 필요 없다는 뜻으로 Facts 상자를 좁게 읽는 것이 안전하다.
- [문서] app-level token은 query나 form parameter가 아니라 `Authorization: Bearer ...` 헤더로 보내야 한다.
- [문서] 성공 응답은 `wss://...` 형식의 동적이고 임시적인 WebSocket URL을 준다.
- [문서] 현재 공식 문서는 그 URL이 연결 전에 정확히 몇 초 유효한지와 단일 사용인지 명시하지 않는다.
- [추론] 별도 RTM API의 30초 규칙을 Socket Mode URL에 가져오면 안 되며, URL은 연결 직전에 발급하고 실패 시 새 URL을 받는 편이 안전하다.
- [문서] 연결 후 첫 프레임은 `type: "hello"`이고, 예제에는 `connection_info.app_id`, `num_connections`, `debug_info.approximate_connection_time`이 있다.
- [문서] `approximate_connection_time`은 추정값이며, 예제의 `3600`초는 모든 연결의 고정 수명 계약이 아니다.
- [문서] Slack은 연결을 몇 시간마다 새로 고치며, 발급된 WebSocket URL에 `&debug_reconnects=true`를 붙여 연결하면 재연결 시험용 약 360초 연결을 받을 수 있다.
- [문서] `disconnect`의 문서화된 이유는 Socket Mode를 끈 `link_disabled`, 종료 전 경고인 `warning`, 정기 교체인 `refresh_requested`이다.
- [문서] `warning`은 종료 약 10초 전에 올 수 있지만 반드시 선행하지 않으며, Slack은 새 연결을 겹쳐 열어 교체하라고 안내한다.
- [문서] 앱 하나가 동시에 열 수 있는 Socket Mode 연결은 최대 10개이고, 여러 연결 중 어느 연결로 payload가 갈지는 보장되지 않는다.
- [문서] 공식 Node Socket Mode 클라이언트는 연결 장애 뒤 자동 reconnect가 기본값이다.

#### envelope, ACK, retry

- [문서] Socket Mode가 전달하는 event/interaction envelope는 `envelope_id`, `type`, `payload`, `accepts_response_payload`를 포함하며, lifecycle frame인 `hello`와 `disconnect`에는 이 envelope shape를 적용하지 않는다.
- [문서] ACK는 같은 WebSocket에 최소 `{"envelope_id":"..."}`를 보내며, 필요하면 같은 객체의 `payload`에 상호작용 응답을 넣는다.
- [문서] Slack은 상호작용 payload를 3초 안에 ACK하라고 요구하고, 넘기면 사용자에게 timeout/error를 표시한다.
- [문서] Events API envelope ACK는 Slack이 수신 여부와 재시도 필요를 판단하게 하지만, 공식 Socket Mode 문서는 미ACK interaction의 재시도 횟수·간격·보존 시간과 전체 재연결 후 replay를 약속하지 않는다.
- [문서] HTTP Events API에는 별도의 최대 3회 재시도 일정과 retry header가 문서화돼 있지만, 그 일정을 Socket Mode interaction에 적용한다는 공식 근거는 없다: <https://docs.slack.dev/apis/events-api/>
- [문서] Slack은 Socket Mode 전환 시 첫 연결이 열리기 전 event가 유실될 수 있다고 경고하고, 연결 교체 때 overlap을 권한다.
- [문서] 현재 공식 문서에는 모든 Socket 연결이 끊긴 동안 생긴 event를 reconnect 후 backlog로 재생한다는 보장이 없다.
- [추론] Socket Mode를 durable event log로 보지 말고, 수신된 envelope의 중복에는 멱등성을 갖추되 단절 구간의 완전한 replay는 기대하지 않아야 한다.

#### HTTP Request URL 비교와 이 프로젝트

- [문서] HTTP 방식은 Slack이 접근할 수 있는 Request URL이 필요하고, distributed app의 interaction URL에는 HTTPS가 필수이며 단일-workspace app에도 HTTPS가 강하게 권장된다: <https://docs.slack.dev/interactivity/handling-user-interaction/>
- [문서] HTTP request authenticity의 기본 방식은 raw body와 signing secret의 HMAC 검증이며, Slack은 client certificate를 검증하는 mutual TLS도 대안으로 문서화한다.
- [문서] Socket Mode는 앱이 Slack 쪽으로 outbound WebSocket을 열므로 inbound 공인 IP·도메인·포트포워딩이 필요 없다.
- [문서] Slack은 일반적인 production reliability에는 HTTP를 선호한다고 설명하고, Marketplace 공개 배포에는 Socket Mode를 허용하지 않는다.
- [추론] 현재 topology인 로컬 Windows daemon·공인 IP 없음·내부 앱에서는 추가 인프라 없이 성립하는 inbound 방식은 Socket Mode이다.
- [추론] HTTP는 공개 relay, tunnel 또는 별도 공개 host와 그 운영 경계를 추가할 때만 성립한다.

#### 공식 Node 수단과 유지 상태

- [관측] 2026-08-23 package registry 기준 `@slack/socket-mode` 최신은 3.0.0이고 `@slack/bolt` 최신은 5.0.0이다.
- [관측] 둘 다 이 저장소의 Node `>=26` 전제와 package engine 관점에서 양립한다.
- [문서] `@slack/socket-mode`는 envelope와 ACK를 직접 다루는 공식 Node SDK이고, Bolt는 listener·middleware·`ack()` 추상화를 포함하는 공식 framework이다.
- [추론] 2026-07 official major release와 migration 문서가 있어 두 패키지는 현재 유지 중이라고 볼 근거가 강하지만, 별도의 지원 기간이나 SLA는 확인되지 않았다.

### [배제되는 선택지]

- [추론] app-level token 없이 bot token만으로 Socket Mode를 여는 선택은 배제된다.
- [추론] `connections:write` 없는 app-level token으로 `apps.connections.open`을 호출하는 선택은 배제된다.
- [추론] URL을 장기 보관해 재사용하거나 한 연결이 영구히 유지된다고 가정하는 설계는 배제된다.
- [추론] reconnect가 끊긴 동안의 모든 interaction을 자동 replay한다고 가정하는 설계는 배제된다.
- [추론] 현재 topology를 유지하면서 daemon 자체를 HTTP Request URL로 직접 노출하는 선택은 배제된다.
- [추론] 이미 EOL인 `@slack/events-api`와 `@slack/interactive-messages`를 새 inbound 구현의 기반으로 쓰는 선택은 배제된다: <https://docs.slack.dev/tools/node-slack-sdk/legacy/>

### [남는 선택지]

- [추론] OD-041은 OPEN으로 남으며, 공식 `@slack/socket-mode@3.0.0`로 얇은 listener를 만들지 `@slack/bolt@5.0.0`으로 handler framework를 도입할지 사용자가 결정해야 한다.
- [추론] **권장(미확정):** 현재 작은 bridge에는 `@slack/socket-mode`가 기존 fetch 기반 경계와 의존성 표면을 덜 바꾸지만, 향후 Slack command·event listener가 늘면 Bolt의 middleware 구조가 유리할 수 있다.
- [추론] **권장(미확정):** daemon은 연결 직전 URL 발급, `hello.connection_info.app_id` 확인, `warning`/`refresh_requested` 때 overlap, exponential backoff, ACK 처리와 업무 처리를 분리해야 한다.
- [추론] 연결 단절 중 Gate 결정 유실을 별도 상태 조회로 복구할지, Slack을 단지 command transport로 보고 사용자가 재입력하게 할지는 D2 reliability 정책으로 남는다.

## (b) OD-042 · owner/workspace allowlist와 신뢰 경계

### [근거: 문서 URL 또는 실행 명령]

- [문서] `block_actions` payload: <https://docs.slack.dev/reference/interaction-payloads/block_actions-payload/>
- [문서] view interaction payload: <https://docs.slack.dev/reference/interaction-payloads/view-interactions-payload/>
- [문서] shortcut payload: <https://docs.slack.dev/reference/interaction-payloads/shortcuts-interaction-payload/>
- [문서] HTTP request signing: <https://docs.slack.dev/authentication/verifying-requests-from-slack/>
- [문서] Socket Mode의 사전 인증 연결: <https://docs.slack.dev/apis/events-api/using-socket-mode/>
- [문서] Bolt JS Socket Mode: <https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/>
- [문서] app-level token의 범위: <https://docs.slack.dev/authentication/tokens/>
- [문서] Slack Connect와 사용자·채널 ID 주의: <https://docs.slack.dev/apis/slack-connect/>
- [문서] username 폐기 공지: <https://docs.slack.dev/changelog/2017-09-the-one-about-usernames/>
- [문서] Enterprise org 앱 동작: <https://docs.slack.dev/enterprise/developing-for-enterprise-orgs/>
- [문서] `auth.test`: <https://docs.slack.dev/reference/methods/auth.test/>
- [관측] `Get-Content apps/orca-slack-bridge/src/slack/verify.ts`로 기존 사전 검증을 확인했다.

### [확인된 사실]

#### interaction의 신원·문맥 필드

- [문서] `team.id`는 앱이 설치된 workspace 문맥이고, org-wide install에서는 `team`이 `null`일 수 있다.
- [문서] Slack Connect에서 설치 workspace와 interaction 사용자의 home workspace가 다를 수 있으므로 `team.id`만으로 사용자 소속까지 증명하지는 않는다.
- [문서] `enterprise`는 Enterprise Grid 문맥이 있을 때의 조직 정보이며, 일반 workspace 또는 payload 형태에 따라 없거나 `null`일 수 있다.
- [문서] `user.id`는 interaction을 일으킨 Slack 사용자 ID이다.
- [문서] `user.username` 또는 유사한 이름 필드는 변경 가능하고 unique identity로 신뢰할 수 없으며, Slack은 ID 사용을 요구한다.
- [문서] 일부 `block_actions` 예제의 `user.team_id`는 사용자의 workspace 문맥을 추가로 제공하지만 모든 payload 표에서 보장된 필드는 아니다.
- [문서] `channel.id`는 message action의 대화 문맥이고 payload 유형에 따라 선택적이며, global shortcut·modal submission에는 없을 수 있다.
- [문서] Slack Connect에서 channel ID가 변할 수 있으므로 `channel.id`는 owner 신원 근거가 아니고 routing·resource 문맥이다.
- [문서] `api_app_id`는 payload를 받은 Slack App의 ID이며, 현재 `block_actions`와 view interaction 표에 포함된다.
- [문서] 일반 `block_actions`의 `token`은 폐기된 verification token이고 OAuth token이나 호출자 신원이 아니다.
- [문서] 현재 view submission 표에는 legacy `token`이 보장되지 않는다.
- [문서] `bot_access_token`은 Slack Functions의 just-in-time credential에만 해당하며, 이 non-Functions 앱의 interaction identity가 아니다.
- [문서] non-Functions interaction schema에는 로컬 app-level `xapp-` token이나 설치 bot OAuth `xoxb-` token을 전달하는 필드가 없다.
- [문서] `response_url`은 response message를 보낼 수 있는 capability URL이지 사용자 신원 필드가 아니다.
- [추론] 이 URL을 가진 주체가 response를 보낼 수 있으므로 payload 원문과 함께 로그에 남기지 않는 편이 안전하다.

#### 어떤 값이 신뢰 근거인가

- [추론] payload JSON의 어느 단일 필드도 transport 인증 없이 그 자체로 위조 불가능한 신뢰 근거가 아니다.
- [문서] app-level token은 앱 자체에 속하고 여러 설치에 걸친 연결을 열 수 있으므로 특정 workspace 설치를 나타내는 bot token과 성격이 다르다.
- [문서] HTTP의 signing-secret 경로에서는 raw body, `X-Slack-Request-Timestamp`, `X-Slack-Signature`, 앱 signing secret로 HMAC-SHA256을 검증하고 5분보다 오래된 timestamp를 거부한다.
- [문서] HTTP의 다른 공식 경로는 mutual TLS로 Slack client certificate를 검증하는 방식이다.
- [문서] Socket Mode에서는 `xapp` credential로 `apps.connections.open`을 호출해 얻은 TLS WebSocket 자체가 사전 인증되므로 envelope마다 signing secret 검증이 필요하지 않다.
- [문서] 공식 Bolt Socket Mode 초기화 예제도 `appToken`과 `socketMode: true`를 사용하고 signing secret을 요구하지 않는다.
- [추론] Socket Mode의 신뢰 사슬은 로컬 `xapp` secret → 인증된 `apps.connections.open` → 그 응답의 TLS WebSocket → `hello`와 envelope이며, payload의 deprecated `token` 비교가 아니다.
- [추론] 그 transport에서 받은 뒤 `team.id`와 `user.id`는 Slack이 인증해 전달한 assertion이지만, Gate 권한은 별도 allowlist로 판정해야 한다.
- [추론] 현재 단일-workspace 정책의 최소 authorization 조건은 인증된 Socket 연결, `team.id === config.slack.teamId`, `user.id ∈ config.slack.ownerUserIds`의 교집합이다.
- [추론] `api_app_id`와 `hello.connection_info.app_id`를 예상 App ID에 대조하면 routing 오류를 조기에 차단하는 defense-in-depth가 되지만, 이것만으로 transport authenticity를 대체하지 못한다.
- [추론] Slack Connect 외부 사용자를 별도로 막아야 한다면 문서상 존재할 때 `user.team_id`도 정책 조건으로 삼을 수 있지만, 필드 부재 정책을 먼저 결정해야 한다.

#### 현재 `verify.ts`와의 차이

- [관측] `verify.ts`는 bot token 접두와 `auth.test`, 그 응답의 `team_id`와 설정값 일치, app token 접두와 `apps.connections.open` 성공을 확인한다.
- [관측] `verify.ts`는 발급된 WebSocket URL을 출력하지 않고 실제 Socket에 연결하지 않는다.
- [관측] `verify.ts`에는 signing secret이 없고, Socket Mode만을 택한 현재 설정에는 이것이 누락이 아니다.
- [관측] `verify.ts`는 inbound envelope를 받지 않으므로 `hello.connection_info.app_id`, payload `api_app_id`, `team.id`, `user.id`, `channel.id`, action structure 또는 중복을 검증하지 않는다.
- [추론] 따라서 `verify.ts`는 credential/setup 사전 점검으로는 맞지만 D2 runtime authorization을 대신하지 않는다.

### [배제되는 선택지]

- [추론] `user.username`, display name, channel name으로 owner 권한을 판정하는 선택은 배제된다.
- [추론] deprecated payload `token`을 Socket Mode 또는 HTTP request의 인증 근거로 쓰는 선택은 배제된다.
- [추론] HTTP Request URL을 쓰면서 signing-secret HMAC과 mutual TLS 중 어느 Slack 인증 방식도 적용하지 않는 선택은 배제된다.
- [추론] Socket Mode envelope에 HTTP용 signing secret/HMAC 필드가 있을 것이라고 가정하는 선택은 배제된다.
- [추론] `team.id` 또는 `api_app_id` 하나만 일치하면 Gate 권한을 주는 선택은 배제된다.
- [추론] channel allowlist만으로 owner authorization을 대신하는 선택은 배제된다.

### [남는 선택지]

- [추론] OD-042는 OPEN으로 남으며, `api_app_id`를 설정에 고정할지와 Slack Connect의 `user.team_id` 불일치를 거부할지 사용자가 결정해야 한다.
- [추론] **권장(미확정):** D2는 `team.id`와 exact `user.id`를 모두 검사하고 실패 이유를 token·payload 원문 없이 남기며, `api_app_id`도 설정 가능한 추가 고정값으로 검사하는 편이 좋다.
- [추론] org-wide install을 지원할 계획이 생기면 `team === null`과 `enterprise.id`를 다루는 별도 policy가 필요하며, 현재 단일-workspace allowlist에 조용히 허용하면 안 된다.

## (c) OD-071 · modal validation error UX

### [근거: 문서 URL 또는 실행 명령]

- [문서] modal submission 응답과 validation: <https://docs.slack.dev/surfaces/modals/>
- [문서] interaction 처리와 trigger 오류: <https://docs.slack.dev/interactivity/handling-user-interaction/>
- [문서] input block: <https://docs.slack.dev/reference/block-kit/blocks/input-block/>
- [문서] Socket Mode ACK response payload 예제: <https://docs.slack.dev/apis/events-api/using-socket-mode/>
- [문서] Bolt acknowledgement: <https://docs.slack.dev/tools/bolt-js/concepts/acknowledge/>
- [문서] `views.update`: <https://docs.slack.dev/reference/methods/views.update/>
- [문서] `views.push`: <https://docs.slack.dev/reference/methods/views.push/>
- [문서] `views.open`: <https://docs.slack.dev/reference/methods/views.open/>

### [확인된 사실]

#### `response_action=errors`

- [문서] `view_submission` ACK에 다음 형태를 넣을 수 있다.

```json
{
  "response_action": "errors",
  "errors": {
    "input-block-id": "Plain text error message"
  }
}
```

- [문서] `errors`의 key는 오류를 붙일 `input` block의 `block_id`이고, 그 input element의 `action_id`가 아니다.
- [문서] 공식 문서는 오류를 `input` block에 표시한다고 규정하며 `section` 또는 `actions` block에 붙이는 것을 허용한다고 하지 않는다.
- [문서] `errors`의 value는 사용자에게 보이는 plain-text 메시지이다.
- [문서] 이 응답을 받으면 Slack은 오류 block을 강조하고 메시지를 표시하며, 사용자가 값을 수정해 다시 제출할 수 있도록 modal을 열린 상태로 유지한다.
- [문서] 현재 공식 문서에는 개별 validation error 메시지의 최대 글자 수, 오류 개수, newline/formatted-text 허용 범위가 명시돼 있지 않다.
- [추론] input block의 label·hint에 문서화된 2,000자 제한을 error value에 그대로 적용할 근거는 없으며, 짧은 plain text로 제한하는 것은 앱 자체 UX 정책이어야 한다.

#### 다른 response action과 3초 창

- [문서] 빈 ACK는 현재 제출 view를 닫고 stack의 다음 view를 보이거나 modal 전체를 닫는다.
- [문서] `response_action: "update"`는 제출된 현재 view를 새 view payload로 교체해 modal을 유지한다.
- [문서] `response_action: "push"`는 새 view를 stack 위에 추가하며 modal stack은 최대 3개 view이다.
- [문서] `response_action: "clear"`는 modal stack 전체를 비우고 닫는다.
- [문서] Socket Mode에서 위 동기 응답은 별도 Web API가 아니라 ACK frame의 `payload`에 싣는다.

```json
{
  "envelope_id": "outer-envelope-id",
  "payload": {
    "response_action": "errors",
    "errors": {
      "gate-input": "값을 확인해 주세요."
    }
  }
}
```

- [문서] Bolt의 `ack({...})`는 같은 protocol response를 추상화한다.
- [문서] `errors`, `update`, `push`, `clear` 응답도 `view_submission`을 받은 뒤 3초 ACK 창 안에 보내야 한다.
- [문서] 별도 `views.update` Web API 호출은 ACK의 `response_action: "update"`와 다른 비동기 경로이다.
- [문서] 별도 `views.push` Web API도 ACK의 `response_action: "push"`와 다른 경로이지만, 이미 열린 modal의 interaction에서 받은 fresh `trigger_id`가 필요하므로 제출 뒤 임의 시점의 일반 비동기 대안은 아니다.
- [문서] `trigger_id`는 받은 뒤 3초 안에 한 번만 교환할 수 있다.
- [문서] 오류 이름은 공식 문서끼리 다르며 `views.open` 표는 `exchanged_trigger_id`·`expired_trigger_id`, 일반 interaction 가이드는 `trigger_exchanged`·`trigger_expired`를 적는다.
- [추론] D2가 `views.open`을 호출할 때는 method-specific error table의 `exchanged_trigger_id`·`expired_trigger_id`를 우선 처리하되, SDK가 노출하는 실제 `data.error`를 보존해야 한다.
- [문서] 현재 공식 문서는 3초를 넘긴 ACK 뒤 modal의 최종 상태를 보장하지 않고 사용자에게 timeout/error가 난다고만 한다.

### [배제되는 선택지]

- [추론] error map의 key로 `action_id`를 쓰는 선택은 배제된다.
- [추론] validation error를 message `section` 또는 `actions` block에 부착할 수 있다고 가정하는 선택은 배제된다.
- [추론] error response를 ACK와 무관한 별도 Slack API로 보내는 선택은 배제된다.
- [추론] 느린 Orca resolve가 끝날 때까지 3초를 넘겨 ACK를 미루는 선택은 배제된다.
- [추론] modal을 유지해야 할 validation 실패에 빈 ACK를 쓰는 선택은 배제된다.
- [추론] 문서화되지 않은 error 글자 수를 Slack 계약처럼 하드코딩하는 선택은 배제된다.

### [남는 선택지]

- [추론] OD-071은 OPEN으로 남으며, 유효한 제출 뒤 modal을 즉시 닫고 비동기 resolve할지, `update`로 처리 중 view를 유지한 뒤 `views.update`로 결과를 보여줄지 사용자가 결정해야 한다.
- [추론] **권장(미확정):** 로컬 형식·필수값 검증은 3초 안에 `errors`로 돌려 modal을 유지하고, 원격 Orca 작업은 ACK 전에 기다리지 않는다.
- [추론] 즉시 닫기 흐름을 택하면 post-ACK resolve 실패를 Slack message 갱신 또는 재시도 가능한 별도 UX로 보여줘야 한다.
- [추론] 처리 중 view 흐름을 택하면 view `id`·`hash`를 보관하고 `views.update` 충돌과 daemon 재시작을 다루는 상태가 추가로 필요하다.

## (d) OD-046 · Slack message 유실 복구

### [근거: 문서 URL 또는 실행 명령]

- [문서] `chat.update`와 오류: <https://docs.slack.dev/reference/methods/chat.update/>
- [문서] `message_deleted` event: <https://docs.slack.dev/reference/events/message/message_deleted/>
- [문서] `bot_message` subtype: <https://docs.slack.dev/reference/events/message/bot_message/>
- [문서] `conversations.info`: <https://docs.slack.dev/reference/methods/conversations.info/>
- [문서] `channel_id_changed` event: <https://docs.slack.dev/reference/events/channel_id_changed/>
- [문서] Slack Connect frozen/disconnected channel: <https://docs.slack.dev/apis/slack-connect/#beware-of-frozen-and-disconnected-channels>
- [문서] `conversations.history`: <https://docs.slack.dev/reference/methods/conversations.history/>
- [문서] `conversations.replies`: <https://docs.slack.dev/reference/methods/conversations.replies/>
- [문서] `conversations.list`: <https://docs.slack.dev/reference/methods/conversations.list/>
- [문서] `search.messages`: <https://docs.slack.dev/reference/methods/search.messages/>
- [문서] `chat.postMessage`: <https://docs.slack.dev/reference/methods/chat.postMessage/>
- [문서] message metadata: <https://docs.slack.dev/messaging/message-metadata/>
- [문서] Bolt v5/Web API v8 error shape: <https://docs.slack.dev/tools/bolt-js/migration/migration-v5/#weve-improved-error-handling-throughout>
- [관측] `Get-Content apps/orca-slack-bridge/src/slack/post.ts`로 현재 저장·오류 전달 계약을 확인했다.

### [확인된 사실]

#### `chat.update`의 분류 가능한 오류

- [문서] `message_not_found`는 요청한 timestamp에 해당하는 message를 찾지 못했다는 코드이다.
- [추론] 저장된 message가 삭제됐다면 `message_not_found`가 예상되지만, 현재 공식 오류 표는 삭제가 반드시 이 코드로 매핑된다고 별도 보장하지 않는다.
- [추론] `message_not_found`는 삭제뿐 아니라 stale/wrong `ts` 또는 잘못된 channel과 timestamp 조합에도 날 수 있어 삭제의 증명은 아니다.
- [문서] `is_inactive`는 channel이 frozen, archived 또는 deleted 상태라는 코드이다.
- [추론] `is_inactive` 하나만으로 archive·delete·Slack Connect freeze 중 어느 상태인지 구분할 수 없다.
- [문서] channel ID가 아직 조회된다면 `conversations.info`는 `is_archived`와 `is_frozen`을 반환할 수 있고, conversation 종류에 맞는 `channels:read`·`groups:read`·`im:read`·`mpim:read`가 필요하다.
- [추론] 따라서 `is_inactive` 뒤 `conversations.info`가 성공하면 archive/freeze를 보조 판별할 수 있지만, 조회 자체가 실패하면 삭제 여부를 확정할 수 없다.
- [문서] `channel_not_found`는 channel 값이 유효하지 않다는 코드이다.
- [문서] Slack Connect share가 끊기며 channel ID가 바뀐 경우 옛 ID를 사용하면 `channel_not_found`가 날 수 있다.
- [추론] `channel_not_found`도 typo, 더는 볼 수 없는 channel 등 다른 원인이 있어 channel ID 변경을 단독 증명하지 못한다.
- [문서] `cant_update_message`는 현재 인증 identity가 그 message를 수정할 수 없음을 뜻한다.
- [문서] `no_permission`은 필요한 권한 또는 접근이 없음을 뜻한다.
- [문서] Slack은 `chat.update` 오류 목록이 exhaustive하지 않다고 명시한다.
- [추론] 따라서 오류만으로는 대략 `coordinate 없음`, `channel inactive`, `channel invalid/불가시`, `작성자/권한 불일치`를 구분할 수 있을 뿐, “기존 message가 삭제돼 영구 유실됨”을 확정할 수 없다.
- [문서] `message_deleted`는 `message` event subtype으로 `channel`과 `deleted_ts`를 제공하고, 삭제된 원문 message는 더는 history에 나타나지 않는다.
- [문서] 이를 받으려면 conversation 종류에 맞는 `message.channels`·`message.groups`·`message.im`·`message.mpim` event subscription과 대응하는 `*:history` scope가 필요하다.
- [추론] 사전에 이 event를 실제로 받아 저장된 coordinate와 맞췄다면 삭제를 직접 확인할 수 있지만 원문을 복구하지는 못하며, event 수신이나 사전 로컬 상태가 없으면 삭제 원인의 사후 복구는 보장되지 않는다.

#### 다시 찾는 조회 수단과 scope

- [관측] 현재 `post.ts`는 `chat.postMessage` 성공 응답의 `channel`과 `ts`를 함께 반환하고 `chat.update`도 그 pair를 사용하며, Slack error code를 `SlackApiError.code`로 보존한다.
- [문서] Bolt 5가 의존하는 Web API 8에서 Slack method 실패는 `WebAPIPlatformError`이고, `error.code`는 SDK category이며 `message_not_found` 같은 method code는 `error.data.error`에 있다.
- [추론] 현재 custom `post.ts` wrapper를 유지하면 기존 `SlackApiError.code` 분기가 그대로 성립하지만, Bolt/WebClient로 호출 경계를 바꾸면 반드시 `data.error`를 보존해야 한다.
- [문서] known `channel`+`ts`의 존재 확인은 `conversations.history`에 `oldest=ts`, `inclusive=true`, `limit=1`을 주고 반환된 `message.ts`가 정확히 같은지 검사하는 공식 single-message recipe를 쓸 수 있다.
- [문서] public channel history에는 `channels:history`, private channel에는 `groups:history`, DM에는 `im:history`, MPIM에는 `mpim:history` scope가 필요하다.
- [문서] bot token은 bot이 member인 대화의 history를 읽을 수 있다.
- [문서] thread reply를 찾는다면 `conversations.replies`와 대화 종류에 맞는 history scope가 필요하다.
- [문서] channel을 다시 열거하려면 `conversations.list`와 대화 종류에 맞는 `channels:read`, `groups:read`, `im:read`, `mpim:read`가 필요하다.
- [추론] channel name으로 새 ID를 추측하는 것은 rename·중복·Slack Connect 문맥 때문에 heuristic이며, 확정 복구 키가 아니다.
- [문서] `search.messages`는 legacy method이고 user token과 `search:read`가 필요하며 bot token으로 쓸 수 없다.
- [추론] 따라서 현재 bot-only bridge가 `search.messages`로 자기 message를 복구하는 선택은 성립하지 않는다.
- [문서] `channel_id_changed`는 앱이 접근 가능한 private channel이 Slack Connect로 외부 공유될 때 `old_channel_id`와 `new_channel_id`를 주며, event 자체에는 추가 scope가 필요 없다.
- [추론] 이 event를 실제로 받았다면 저장된 channel ID를 새 ID로 바꿀 수 있지만, 모든 channel 변경을 포괄하는 일반 복구 계약은 아니다.
- [문서] Slack Connect 연결 해제 뒤 초대받았던 조직에는 새 ID의 복사 channel이 생기고 옛 ID 요청은 `channel_not_found`가 될 수 있지만, 공식 문서는 모든 경우에 쓸 수 있는 old-to-new mapping API를 제공하지 않는다.
- [추론] 이런 연결 해제 뒤 `conversations.list`와 이름으로 후보를 찾는 방식은 heuristic이며 확정 복구가 아니다.
- [문서] `auth.test`는 app/bot identity의 `bot_id`와 `user_id`를 반환할 수 있고, bot message에는 `bot_id`·`bot_profile`이 실린다.
- [추론] `conversations.history`에는 작성자 filter 인자가 없으므로 pagination한 결과를 `bot_id` 또는 bot user ID로 client-side filter하는 것은 조합한 복구 전략이지 Slack이 보장한 “내 message 찾기” API가 아니다.
- [문서] 2025-05-29 이후 만든 commercially distributed non-Marketplace app에는 `conversations.history`가 분당 1회·최대 15개라는 별도 제한이 적용되며, 내부 app의 일반 tier와는 조건이 다르다.
- [추론] 해당 배포 조건에 들어가면 전체 history scan은 특히 비현실적이다.
- [추론] timestamp를 잃은 상태에서 작성자와 text만으로 찾으면 동일 내용의 여러 message를 구분할 수 없어 완전한 복구가 아니다.
- [문서] app은 message에 등록된 metadata schema의 stable field를 넣고 `conversations.history?include_all_metadata=true`로 metadata를 받을 수 있다.
- [추론] 이 metadata는 candidate correlation을 강화하지만, App manifest schema 등록과 Slack의 현재 metadata 계약을 추가하고 기존 message에는 소급되지 않는다.
- [관측] 현재 App 설정은 bot scope `chat:write`만 가지며 channel history/read scope와 관련 event subscription은 없다.

### [배제되는 선택지]

- [추론] `message_not_found` 하나를 “사용자가 삭제함”으로 확정하는 선택은 배제된다.
- [추론] `is_inactive`로 archive·delete·freeze를 세분하는 선택은 배제된다.
- [추론] `channel_not_found`만으로 channel ID 변경을 확정하는 선택은 배제된다.
- [추론] 현재 `chat:write`만으로 channel history를 조회하거나 bot token으로 `search.messages`를 쓰는 선택은 배제된다.
- [추론] text·bot identity만으로 여러 후보 중 원래 message를 항상 복구할 수 있다는 선택은 배제된다.

### [남는 선택지]

- [추론] OD-046은 OPEN으로 남으며, terminal error 뒤 새 root message를 만들어 store를 다시 연결할지, 읽기 scope와 조회 복구를 추가할지 사용자가 결정해야 한다.
- [추론] **권장(미확정):** 최소 경로는 `message_not_found`, `is_inactive`, `channel_not_found`를 서로 다른 operator-visible 상태로 보존하고 자동 재게시 전에 channel 유효성과 정책을 확인하는 것이다.
- [추론] **권장(미확정):** history 기반 복구가 필요하다고 결정할 때만 필요한 최소 conversation 유형의 `*:history`/`*:read` scope와 event subscription을 추가하고 App을 재설치한다.
- [추론] 향후 메시지에 app-generated stable correlation metadata를 싣는 방식과 자체 store의 `channel`+`ts`를 canonical로 유지하는 방식은 병행할 수 있다.

## (e) `block_actions` payload와 중복

### [근거: 문서 URL 또는 실행 명령]

- [문서] `block_actions` payload: <https://docs.slack.dev/reference/interaction-payloads/block_actions-payload/>
- [문서] button element: <https://docs.slack.dev/reference/block-kit/block-elements/button-element/>
- [문서] actions block: <https://docs.slack.dev/reference/block-kit/blocks/actions-block/>
- [문서] `views.open`과 trigger ID: <https://docs.slack.dev/reference/methods/views.open/>
- [문서] Socket Mode envelope: <https://docs.slack.dev/apis/events-api/using-socket-mode/>

### [확인된 사실]

- [문서] `actions`는 interaction을 일으킨 element의 배열이고, button entry에는 Slack이 돌려주는 `action_id`, `block_id`와 element에 설정됐다면 `value`가 실린다.
- [문서] button을 작성할 때 `action_id`는 optional이고 생략하면 Slack이 생성하며, 앱이 정한다면 한 block 안에서 고유하도록 해야 하고 최대 255자이다.
- [문서] actions block을 작성할 때 `block_id`도 optional이고 생략하면 Slack이 생성하며, 최대 255자이고 message와 그 message의 각 update iteration마다 새롭게 고유하게 만들도록 안내된다.
- [추론] 이 규칙은 어느 message revision에서 클릭했는지를 구분하는 데 도움이 되지만 같은 revision의 두 클릭을 구분하는 interaction ID는 아니다.
- [문서] button `value`는 최대 2,000자이고 사용자가 button을 누를 때 payload로 돌아온다.
- [문서] `block_actions` 표는 `value`를 required처럼 표시하지만 button element 문서는 이를 optional로 정의하고 Home tab 예제는 생략한다.
- [추론] parser는 element 종류와 문서 불일치를 고려해 `value` 부재를 처리하되, Gate button renderer는 명시적으로 stable value를 넣는 것이 안전하다.
- [문서] `container`는 interaction surface 문맥이고 공식 message button 예제에는 `type: "message_attachment"`, `message_ts`, `channel_id`가 있다.
- [문서] Slack은 source에 따라 `block_actions` property가 달라질 수 있다고 명시하므로 예제의 `container.type`을 모든 message interaction의 고정값으로 일반화할 수 없다.
- [문서] message surface에서는 최상위 `message`가 선택적으로 있고 그 객체의 `ts`로 원문 message를 찾을 수 있다.
- [추론] message button routing에는 먼저 지원하는 `container.type`을 분기하고 `container.message_ts`와 `container.channel_id`를 명시적으로 검증하며, `message.ts` 예제와 우연히 같다는 사실만 계약으로 삼지 않는 편이 안전하다.
- [문서] view/Home surface의 container에는 view ID 등 다른 식별자가 오며 항상 message가 있는 것은 아니다.
- [문서] `trigger_id`는 modal을 여는 단기 capability이고 3초 안에 한 번만 사용해야 한다.
- [문서] payload 예제에는 `action_ts`가 있지만 현재 property table은 이를 durable unique ID로 정의하지 않는다.
- [문서] 이 조사 대상인 일반 Gate button은 클릭될 때 `block_actions` payload를 발생시킨다.
- [문서] button element의 특수 `agent_prompt` 동작은 Slackbot AI가 활성화된 사용자에게 interaction payload를 보내지 않을 수 있으므로 일반 Gate button 계약에 포함하지 않는다.
- [문서] 현재 공식 문서는 빠른 double-click을 debounce하거나 하나만 전송한다는 보장, exactly-once delivery, payload 내부의 보편적 interaction ID를 제공하지 않는다.
- [추론] 그러므로 같은 button을 빠르게 두 번 누르면 두 logical payload가 올 수 있다고 가정해야 한다.
- [문서] Socket Mode 바깥 envelope의 `envelope_id`는 unique string이지만, retry 때 동일하게 유지되는지와 durable idempotency key인지 공식 문서는 보장하지 않는다.
- [추론] `trigger_id`, `action_ts`, `message.ts + block_id + action_id`, envelope ID 중 어느 것도 Gate 결정을 위한 영구 중복 제거 키로 문서화돼 있지 않다.
- [추론] 앱이 `value`에 서명 또는 검증 가능한 Gate operation ID와 version/nonce를 넣고, Orca의 canonical Gate state에 대해 compare-and-resolve 또는 durable idempotency를 적용해야 두 클릭과 재전송을 안전하게 합칠 수 있다.
- [추론] 첫 클릭 뒤 message에서 button을 제거·비활성 상태로 갱신하면 반복 클릭 UX는 줄지만, 경합 중 이미 전송된 두 payload를 막는 correctness 경계는 아니다.

### [배제되는 선택지]

- [추론] `trigger_id`를 장기 저장하거나 여러 API 호출에 재사용하는 선택은 배제된다.
- [추론] Slack UI가 double-click을 반드시 하나로 합친다고 전제하는 선택은 배제된다.
- [추론] `action_ts` 또는 `message.ts + action_id`만을 보편적 unique interaction key로 보는 선택은 배제된다.
- [추론] button을 시각적으로 제거하는 것만으로 resolve의 exactly-once를 보장하는 선택은 배제된다.

### [남는 선택지]

- [추론] operation ID와 version을 button `value`에 넣는 encoding, 그 값에 MAC을 붙일지 여부, 이미 resolved된 Gate의 재클릭 응답 UX는 D2 설계로 남는다.
- [추론] **권장(미확정):** transport envelope ID는 짧은 시간의 duplicate telemetry/보조 cache에만 쓰고, 최종 중복 제거는 Orca Gate ID·expected version·canonical state transition으로 수행한다.
- [추론] **권장(미확정):** handler는 `action_id`, `block_id`, `value`, `team.id`, `user.id`, `container.channel_id`, `container.message_ts`를 type-check한 뒤 3초 ACK와 resolve 업무를 분리한다.

## D2 구현 전에 필요한 사용자 작업

### 현재 설정으로 바로 가능한 범위

- [문서] `docs/ops/slack-app-setup.md`의 manifest에는 이미 `socket_mode_enabled: true`, `interactivity.is_enabled: true`, bot scope `chat:write`가 있다.
- [문서] 같은 문서에는 `connections:write` app-level token, workspace/team ID, owner user ID, 대상 channel ID 준비 절차가 있다.
- [문서] 2026-08-22 기록에는 `auth.test`, team 일치, `apps.connections.open` URL 발급, 실제 `#pr-digest` 게시가 확인됐고 실제 Socket 연결만 남았다고 적혀 있다.
- [추론] OD-041에서 Socket Mode를 유지한다면 D2의 button/modal 수신 자체를 위해 추가 Slack App 설정 변경은 현재 문서상 없다.
- [추론] Socket Mode 전용 구현에는 signing secret 추가가 필요하지 않다.

### 사용자의 결정 또는 승인이 필요한 항목

1. [추론] 사용자는 OD-041의 공식 Node 수단으로 `@slack/socket-mode`와 `@slack/bolt` 중 하나를 결정해야 한다.
2. [추론] D2를 “실제로 동작함”으로 판정하기 전, 사용자는 실제 workspace에서 throwaway message/button과 modal을 사용한 read/write smoke test를 명시적으로 승인해야 한다.
3. [추론] 그 smoke test는 WebSocket 연결과 `hello`, button payload와 3초 ACK, modal open/submission/error, forced reconnect를 실제로 관측해야 하며 이번 Task에서는 실행하지 않았다.
4. [추론] HTTP 방식을 택하려면 사용자는 Slack이 접근할 endpoint/relay와 HTTPS 운영을 마련하고, Socket Mode 대신 Request URL 및 signing-secret HMAC 또는 mutual TLS 운영을 승인해야 한다.
5. [추론] OD-046에서 history/event 기반 복구를 택할 때만 사용자는 필요한 conversation 종류의 `channels:history`·`groups:history`·`im:history`·`mpim:history` 및 `*:read` 중 최소 집합, 해당 `message.channels`·`message.groups`·`message.im`·`message.mpim` event와 필요하면 `channel_id_changed` subscription을 App manifest에 추가하고 workspace에 재설치해야 한다.
6. [추론] `api_app_id` 고정을 택하면 사용자는 실제 App ID를 저장소 밖 설정에 제공해야 하지만 Slack App 설정 변경은 필요 없다.

## 관측하지 못한 것과 확신도

- [관측] 실제 WebSocket `hello`/`disconnect`, ACK 지연·미ACK 재전송, reconnect 단절 중 event, double-click payload를 관측하지 않았다.
- [관측] 실제 삭제된 message, archived channel, Slack Connect channel ID 변경을 만들어 `chat.update` 오류를 재현하지 않았다.
- [관측] 실제 modal error의 최대 허용 길이를 경계값으로 시험하지 않았다.
- [추론] 위 실험은 실제 Slack connection, interaction, message/channel 변경 또는 App 설정 변경을 요구하므로 read-only 문서 조사인 이번 Task의 외부 write 경계를 넘는다.
- [문서] URL의 exact pre-connect lifetime/단일 사용 여부, reconnect 뒤 backlog replay, Socket interaction retry schedule, modal error 길이, double-click suppression·durable dedup key는 현재 공식 문서에 명시되지 않았다.
- [추론] 이 다섯 항목의 숫자·보장에 대한 확신은 낮으며, 산출물은 값을 추측하지 않고 구현이 의존해서는 안 되는 unknown으로 남긴다.
- [추론] transport 인증, identity 필드 의미, 3초 ACK, modal response action 형식, `chat.update`의 문서화된 오류 코드에 대한 확신은 높다.

## 열린 결정 상태

- [관측] 이 조사로 `docs/open-decisions.md`의 OD-041·OD-042·OD-046·OD-071을 수정하거나 닫지 않았다.
- [추론] 각 절의 선택지는 사용자 결정 전까지 OPEN이며, “권장(미확정)” 표시는 구현 편의가 아니라 공식 문서상 제약과 현재 topology에서 도출한 후보일 뿐이다.
