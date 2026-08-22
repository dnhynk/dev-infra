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

토큰은 환경변수, 나머지는 저장소 밖 설정 파일에 둔다.

```text
SLACK_APP_TOKEN=xapp-...     # Socket Mode 연결용
SLACK_BOT_TOKEN=xoxb-...     # 메시지 생성·갱신용
```

설정 파일 경로는 `ORCA_SLACK_BRIDGE_CONFIG` 또는 OS 기본 경로다. 현재 스키마는 [`config.example.json`](../../apps/orca-slack-bridge/config.example.json)에 있고, Slack 관련 키는 D2 구현 시점에 추가한다.

## 6. 확인

이 단계까지 끝나면 다음을 확인할 수 있어야 한다.

- App 설정 화면에서 Socket Mode가 켜져 있다.
- Interactivity가 켜져 있고 Request URL은 비어 있다.
- Bot token scope에 `chat:write`가 있다.
- App-level token scope에 `connections:write`가 있다.
- 대상 채널 멤버 목록에 봇이 있다.
- `T…` / `C…` / `U…` 값을 모두 확보했다.

Socket Mode 연결과 메시지 게시의 실제 동작 확인은 Bridge가 Slack adapter를 구현한 뒤에 한다. **연결해 보기 전에는 "동작한다"고 기록하지 않는다.**

## 알려진 제약

- Socket Mode 앱은 public Slack Marketplace 배포에 제약이 있다. 개인 내부 앱 목표와는 충돌하지 않는다.
- Bridge는 outbound 인터넷 연결과 reconnect 처리가 필요하다. 공인 IP·도메인·포트포워딩은 필요 없다.
- interactive handler는 **3초 안에** `ack()`해야 한다. 직접 입력 버튼은 ACK와 `views.open`을 같은 3초 창 안에 끝내야 한다.

자세한 플랫폼 사실은 [플랫폼 역량과 제약 §4](../platform-capabilities.md#4-slack)에 있다.
