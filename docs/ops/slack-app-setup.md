# Slack App 준비 절차

Bridge가 붙을 Slack App을 만드는 외부 작업이다. Bridge 코드가 아니라 사람이 하는 준비 절차이므로 [호스트 전제조건](../platform-capabilities.md#6-호스트-전제조건)과 같은 성격으로 다룬다.

**토큰과 ID는 이 저장소에 커밋하지 않는다.** 저장소가 public이다(DL-015). 값은 저장소 밖 설정 파일이나 환경변수로만 주입한다.

## 0. 준비 전에 정할 것

| 항목 | 값 | 비고 |
|---|---|---|
| Workspace | | 개인 workspace 하나를 쓴다 |
| App 이름 | `Orca Bridge` | 표시 이름. 나중에 바꿔도 된다 |
| 채널 | `#pr-digest`, `#agent-runs` | 먼저 만들어 둔다. `#github`은 GitHub 공식 앱용이라 별개다 |

채널은 private으로 만들어도 되지만, private이면 봇을 **반드시 초대**해야 하고 `chat:write.public`으로 우회할 수 없다.

## 1. App 생성 — manifest로 한 번에

<https://api.slack.com/apps> → **Create New App** → **From an app manifest** → workspace 선택 → 아래를 붙여넣는다.

```yaml
_metadata:
  major_version: 2
  minor_version: 1

display_information:
  name: Orca Bridge
  description: Orca orchestration 상태를 Slack에 투영하고 Gate 결정을 받는다

features:
  bot_user:
    display_name: orca-bridge
    always_online: false

oauth_config:
  scopes:
    bot:
      - chat:write

settings:
  socket_mode_enabled: true
  interactivity:
    is_enabled: true
```

manifest 필드 제한: `name` 35자, `description` 140자, `bot_user.display_name` 80자이고 `a-z 0-9 - _ .`만 쓸 수 있다.

### scope를 왜 이것만 두는가

- `chat:write` 하나로 메시지 생성과 `chat.update` 갱신이 모두 된다. `chat.update`는 **그 봇이 직접 작성한 non-ephemeral 메시지만** 갱신할 수 있으므로 다른 앱의 메시지를 건드릴 걱정이 없다.
- 버튼과 modal은 `settings.interactivity.is_enabled`로 켜진다. `views.open`에 별도 scope가 필요하지 않다.
- `chat:write.public`은 **넣지 않는다.** 봇이 참여하지 않은 public 채널에 글을 쓰게 하는 scope인데, 대상 채널을 명시적으로 초대하는 편이 표면이 좁다.
- `commands`(슬래시 명령), 채널 읽기, 사용자 목록 조회는 현재 범위에 필요 없다. 필요해지면 그때 추가한다.

Socket Mode를 쓰므로 **Event Subscriptions와 Request URL은 설정하지 않는다.** 공개 endpoint를 운영하지 않는 것이 목표다.

## 2. 토큰 두 개 발급

Bridge는 성격이 다른 토큰 두 개를 쓴다.

### 2-1. App-level token (`xapp-`)

**Basic Information** → **App-Level Tokens** → **Generate Token and Scopes**

- 이름: `socket-mode`
- scope: **`connections:write`** — 이 scope가 `apps.connections.open`을 호출해 WebSocket을 여는 권한이다. app-level token 전용 scope다.

생성 직후 한 번만 보이므로 바로 저장한다.

### 2-2. Bot token (`xoxb-`)

**OAuth & Permissions** → **Install to Workspace** → 승인

설치 후 같은 화면의 **Bot User OAuth Token**이 `xoxb-`로 시작하는 값이다.

## 3. 채널에 봇 초대

각 대상 채널에서 실행한다.

```text
/invite @orca-bridge
```

초대하지 않으면 메시지 게시가 실패한다. private 채널은 특히 그렇다.

## 4. 필요한 ID 수집

Bridge 설정과 owner allowlist에 들어갈 값이다.

| 값 | 형태 | 얻는 법 |
|---|---|---|
| Workspace(team) ID | `T…` | Slack 웹에서 workspace를 열면 URL에 나온다. 또는 **About this workspace** |
| 채널 ID | `C…` | 채널 이름 클릭 → 하단의 Channel ID. 또는 채널 링크 복사 시 URL 끝부분 |
| owner user ID | `U…` | 자기 프로필 → 더보기(⋯) → **Copy member ID** |

**채널 이름이 아니라 ID를 쓴다.** 이름은 바뀌지만 ID는 유지된다. repository canonical key에 숫자 id를 쓰는 것과 같은 이유다(OD-026).

owner user ID는 Gate 결정 권한의 근거다. Bridge는 room이나 channel 소속이 아니라 **payload의 실제 `user.id`**를 이 값과 대조한다.

## 5. Bridge에 주입

**토큰은 환경변수, 식별자는 설정 파일**로 나눈다. 둘 다 저장소 밖이다.

### 5-1. 토큰 — Windows 사용자 환경변수

PowerShell에서 한 번 실행한다. `setx`는 레지스트리에 영구 기록한다.

```powershell
setx SLACK_BOT_TOKEN "xoxb-여기에-붙여넣기"
setx SLACK_APP_TOKEN "xapp-여기에-붙여넣기"
```

**이미 떠 있는 프로세스에는 반영되지 않는다.** Orca 앱과 터미널을 재시작해야 새 프로세스가 값을 본다. `NVM_HOME` 때와 같은 성질이다([호스트 전제조건](../platform-capabilities.md#6-호스트-전제조건)).

현재 세션에서 바로 쓰려면 그 세션에만 추가로 설정한다.

```powershell
$env:SLACK_BOT_TOKEN = "xoxb-..."
$env:SLACK_APP_TOKEN = "xapp-..."
```

> **범위에 대한 정직한 설명**: 사용자 환경변수는 같은 사용자로 실행되는 모든 프로세스가 읽는다. Orca가 띄우는 worker agent도 포함된다. 단일 사용자 머신에서 파일과 환경변수 사이에 실질적인 격리 차이는 없다. 의미 있는 경계는 **저장소에 넣지 않는다**, **로그에 남기지 않는다**, **Slack 메시지에 싣지 않는다** 세 가지다. Bridge는 토큰을 출력할 때 항상 마스킹한다.

### 5-2. 식별자 — 저장소 밖 설정 파일

기본 경로는 `%APPDATA%\orca-slack-bridge\config.json`이다. `--config` 또는 `ORCA_SLACK_BRIDGE_CONFIG`로 바꿀 수 있다.

```powershell
New-Item -ItemType Directory -Force "$env:APPDATA\orca-slack-bridge" | Out-Null
notepad "$env:APPDATA\orca-slack-bridge\config.json"
```

```json
{
  "slack": {
    "teamId": "T01234567",
    "ownerUserIds": ["U01234567"],
    "channels": {
      "prDigest": "C01234567",
      "agentRuns": "C89ABCDEF"
    }
  },
  "projects": [
    { "name": "dev-infra", "repositories": ["dnhynk/dev-infra"] }
  ]
}
```

스키마 규칙:

- `teamId`는 `T`, `ownerUserIds`는 `U`, 채널은 `C` 또는 `G`로 시작해야 한다. **채널 이름(`#pr-digest`)을 넣으면 거부한다.**
- `ownerUserIds`는 비울 수 없다. Gate 결정 권한의 유일한 근거이기 때문이다.
- **설정 어디에도 토큰을 넣으면 파싱이 거부한다.** `xoxb-`/`xapp-`로 시작하는 문자열이 발견되면 오류다. 잘못된 위치에 붙여넣는 사고를 막는 장치다.
- `slack` 절은 선택이다. S0의 `snapshot`은 Slack을 쓰지 않으므로 없어도 동작한다.

전체 스키마 예시는 [`config.example.json`](../../apps/orca-slack-bridge/config.example.json)에 있다.

## 6. 검증

설정과 토큰이 실제로 유효한지 확인한다. **메시지를 게시하지 않는다.**

```powershell
cd D:\dev-infra\apps\orca-slack-bridge
pnpm build
node dist/cli.js verify-slack
```

기대 출력:

```text
  OK   config.slack       team=T01234567 owners=1 channels=2
  OK   SLACK_BOT_TOKEN    xoxb-1234…abcd (56자)
  OK   auth.test          team=T01234567 bot_user=U0BOTID
  OK   team 일치          설정과 같다
  OK   SLACK_APP_TOKEN    xapp-1234…wxyz (60자)
  OK   connections:write  WebSocket URL 발급 성공 (연결하지 않음)

모든 확인 통과
```

무엇을 확인하는가:

| 확인 | 방법 | 잡아내는 문제 |
|---|---|---|
| bot token 유효성 | `auth.test` | 만료·오타·잘못된 앱의 토큰 |
| team 일치 | `auth.test`의 `team_id`와 설정 대조 | 다른 workspace의 토큰을 넣음 |
| app token 유효성과 scope | `apps.connections.open` | `connections:write` 누락, bot token을 app token 자리에 넣음 |
| 토큰 자리 바뀜 | 접두 검사 | `xoxb`/`xapp`를 서로 반대로 주입 |

`apps.connections.open`은 만료되는 WebSocket URL을 발급받을 뿐 연결하지 않으며, URL은 출력하지 않는다.

채널 ID 자체의 유효성은 확인하지 않는다. `conversations.info`가 `channels:read` scope를 요구하는데 그 scope를 부여하지 않았기 때문이다. 채널 ID가 틀리면 D2에서 첫 게시 시 드러난다.

실패 시 진단:

| 출력 | 원인 |
|---|---|
| `SLACK_BOT_TOKEN 환경변수가 비어 있다` | `setx` 후 터미널을 재시작하지 않았다 |
| `xoxb-로 시작하지 않는다` | 두 토큰을 반대로 넣었다 |
| `auth.test 실패: invalid_auth` | 토큰이 만료됐거나 앱을 재설치했다 |
| `connections:write scope가 없다` | app-level token 생성 시 scope를 빠뜨렸다. 새로 발급해야 한다 |
| `team 불일치` | 다른 workspace의 앱 토큰이다 |

## 알려진 제약

- Socket Mode 앱은 public Slack Marketplace 배포에 제약이 있다. 개인 내부 앱 목표와는 충돌하지 않는다.
- Bridge는 outbound 인터넷 연결과 reconnect 처리가 필요하다. 공인 IP·도메인·포트포워딩은 필요 없다.
- interactive handler는 **3초 안에** `ack()`해야 한다. 직접 입력 버튼은 ACK와 `views.open`을 같은 3초 창 안에 끝내야 한다.

자세한 플랫폼 사실은 [플랫폼 역량과 제약 §4](../platform-capabilities.md#4-slack)에 있다.
