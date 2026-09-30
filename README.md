# dev-infra

Personal infrastructure that boots and hands off Orca coordinator sessions, and mirrors their PRs, Runs, and decision Gates into Slack.

`dev-infra`는 Orca IDE에서 여러 AI Agent(Claude Code, Codex)를 병렬로 돌리는 1인 개발자를 위한 개인 운영 계층이다. 두 부분으로 이뤄진다.

- **`/init-orchestrate` + rollover-monitor**: coordinator 세션을 한 줄 명령으로 부팅하고, 컨텍스트가 바닥나면 handoff를 남겨 후속 세션에 넘긴다.
- **`orca-slack-bridge`**: Orca와 GitHub 상태를 읽어 Slack에 PR·Run 카드를 유지하고, 사람이 결정해야 하는 Gate를 Slack 버튼·입력창으로 받아 Orca에 기록한 뒤 기존 coordinator 세션을 깨우는 로컬 daemon.

이 레포는 특정 개인의 개발 환경(Windows, Orca, 개인 Slack workspace)에 맞춰 만든 것이다. 범용 제품이나 배포 패키지가 아니다.

## 왜 만들었나

coordinator Agent가 Task를 쪼개 worker에 맡기고, reviewer 판정을 확인해 merge까지 이어가는 흐름 자체는 Orca가 제공한다. 그래도 사람 손이 가는 일이 네 가지 남는다.

| 수작업 | 이 레포의 대응 |
|---|---|
| Run마다 같은 장문의 orchestration 부팅 프롬프트를 복사·붙여넣기 | `/init-orchestrate` skill 하나로 부팅 |
| coordinator 컨텍스트가 열화되면 직접 알아채고, handoff를 쓰고, 새 세션을 열어 다시 부팅 | Stop hook(`rollover-monitor`)이 남은 컨텍스트를 감지해 handoff와 successor 인수 절차를 지시 |
| 모바일에서 GitHub 알림만으로 여러 PR의 의미와 위험을 파악하기 어려움 | `#pr-digest`에 PR당 카드 하나를 두고 상태가 바뀔 때 같은 카드를 갱신 |
| 자리를 비운 사이 사람 결정이 필요한 Gate가 열리면 작업이 멈춤 | `#agent-runs`에서 버튼이나 직접 입력으로 결정 → Orca Gate에 먼저 기록 → 열린 coordinator 세션에 알림 |

Bridge는 Agent가 아니라 관찰자다. worker↔coordinator 대화를 수집·요약하지 않고 의미 있는 상태 변화만 다룬다. Slack에서 받는 입력은 Bridge가 만든 Gate 버튼과 그 Gate에 연결된 입력창뿐이며, allowlist에 등록된 Slack user ID만 조작할 수 있다. Slack thread의 일반 메시지는 coordinator에 전달하지 않는다.

## 구성

```text
┌──────────────────┐        ┌──────────────────┐
│ Orca             │        │ GitHub           │
│ Run/Task/Worker  │        │ PR/Review/Checks │
│ Gate             │        │ Merge            │
└────────┬─────────┘        └────────┬─────────┘
         │ read, gate-resolve        │ read (gh)
         └─────────────┬─────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│ orca-slack-bridge daemon                            │
│ discovery → collectors → correlation → projector    │
│   ├ summarizer (OpenAI → validated structured data) │
│   ├ deterministic Slack renderer                    │
│   └ durable store (node:sqlite)                     │
└───────┬───────────────────────────────┬─────────────┘
        │ Socket Mode                   │ named pipe
        ▼                               ▼
  Slack #pr-digest                Channel Adapter (MCP server)
        #agent-runs               → 열린 coordinator 세션에 알림
```

| 경로 | 역할 |
|---|---|
| [`skills/init-orchestrate/`](skills/init-orchestrate/SKILL.md) | coordinator 부팅 skill. 대상 레포의 권위 문서를 찾아 읽고, 신규 Run은 방향을 합의하고 기존 Run은 live 상태와 맞춘 뒤 무인 orchestration을 시작한다. `~/.claude/skills/`에 설치해 쓴다 |
| [`tools/rollover-monitor/`](tools/rollover-monitor/rollover-monitor.mjs) | Claude Code Stop hook. 활성 coordinator Run 마커가 있는 세션에서만 transcript의 token usage를 읽고, 임계값 아래면 사전 승인된 롤오버 절차를 지시한다 |
| [`apps/orca-slack-bridge/`](apps/orca-slack-bridge/) | Bridge CLI와 daemon. `digest`, `runs`, `daemon`, `channel-adapter`, `status`, `logs`, `install`/`uninstall`/`run-now` 등의 명령을 제공한다 |
| [`tools/`](tools/) | D3·O1 수용 테스트 하니스 |

설계 원칙 몇 가지:

- LLM은 PR 상태의 의미 요약만 만든다. Slack 레이아웃·버튼·링크는 deterministic renderer가 만든다.
- Slack 결정은 Orca Gate에 먼저 기록한다. coordinator를 깨우는 Channel 알림은 source of truth가 아니다.
- Slack 연결은 Socket Mode(WebSocket)다. 공개 inbound HTTP endpoint를 두지 않는다.
- 토큰은 환경변수로만 받는다. 설정 파일·명령행·로그에 쓰지 않는다.

## 기술 스택

- TypeScript, Node.js 26.x, pnpm workspaces (별도 monorepo 빌드 도구 없음)
- `node:sqlite` (durable store)
- `@slack/socket-mode`, `@slack/web-api`
- `@modelcontextprotocol/sdk` (Claude Code Channel Adapter)
- OpenAI API (PR 요약, 기본 모델은 설정으로 교체 가능)
- GitHub CLI `gh`, Orca CLI `orca`
- Windows Task Scheduler (current-user 자동 시작)
- Vitest, GitHub Actions (hermetic 수용 테스트 + typecheck)

## 현재 상태

| 기능 | 상태 |
|---|---|
| `/init-orchestrate` 부팅과 컨텍스트 롤오버 | 구현됨. 일회용 Run에서 열화 감지 → handoff → successor 생성 → 인수까지 한 번 완주했다 |
| `#pr-digest` PR 카드 | 구현됨. 실제 Slack 채널에 카드를 게시했고, 재관찰 시 새 메시지 없이 같은 카드를 갱신하는 것을 확인했다 |
| review·CI·merge 추적, `#agent-runs` Run 카드, Gate 버튼·직접 입력 | 구현됨. 자동화 테스트로 검증했다. 실제 Slack에서 버튼으로 Gate 하나가 정확히 해결되는 것도 관찰했다 |
| Slack 결정 후 열린 coordinator 세션 깨우기 (Channel Adapter) | **미검증.** 자동화 테스트는 통과했고 실제 세션에서도 동작을 관찰했지만, 그 관찰은 Adapter와 daemon이 서로 다른 빌드인 상태에서 이뤄졌다. 단일 빌드로 다시 확인하기 전까지 `LIVE_CHANNEL_UNVERIFIED`로 둔다 |
| Windows 로그인 시 자동 시작과 크래시 복구 | 구현됨. 실제 운영 설치에서 수용 테스트를 통과했다 |

Channel Adapter는 Claude Code의 research preview 기능인 development channel(`--dangerously-load-development-channels`)에 의존한다. Claude Code 버전에 따라 동작이 바뀔 수 있다.

아직 없는 것: `#deploys`·`#prod-alerts`, 고위험 action 이중 확인, Claude Code permission relay, 다중 owner. 상시 운영 경로는 Windows만 문서화돼 있다.

## 실행 방법

전제: Windows, Node.js 26.x, pnpm 11.22.0, Orca, `gh`, Slack App 하나(Socket Mode).

```powershell
pnpm install --frozen-lockfile
pnpm test            # 전체 Vitest
pnpm typecheck
pnpm acceptance:o1-7 # CI와 같은 hermetic 운영 수용 테스트 (외부 서비스 접근 없음)
```

실제로 운영하려면 다음 문서를 순서대로 따른다.

1. [Slack App 준비](docs/ops/slack-app-setup.md): manifest로 App을 만들고 `#pr-digest`, `#agent-runs` 채널을 준비한다.
2. 설정 파일: [`config.example.json`](apps/orca-slack-bridge/config.example.json)을 레포 밖에 복사해 workspace·채널·owner ID와 프로젝트↔Orca repository 매핑을 채운다. 토큰은 `ORCA_SLACK_BRIDGE_BOT_TOKEN`, `ORCA_SLACK_BRIDGE_APP_TOKEN`, `ORCA_SLACK_BRIDGE_OPENAI_KEY` 환경변수로 준다.
3. [Windows 자동 시작](docs/ops/windows-startup.md): 불변 release를 stage하고 `install`로 current-user Scheduled Task를 등록한다.
4. [Channel Adapter](docs/ops/channel-adapter-acceptance.md): coordinator를 돌릴 프로젝트의 `.mcp.json`에 [`mcp.example.json`](apps/orca-slack-bridge/mcp.example.json)의 항목을 수동으로 병합한다.

`/init-orchestrate`는 `skills/init-orchestrate/`를 `~/.claude/skills/`에 설치해 쓰고, rollover-monitor는 `~/.claude/settings.json`의 Stop hook에 추가 항목으로 등록한다.

## 문서

- [문서 인덱스](docs/README.md): 읽기 순서, 문서 간 권위 순서, 상태 표기 규칙
- [제품 비전](docs/product-vision.md)
- [Bridge 시스템 구조](docs/architecture/orca-slack-bridge.md)
- [구현 로드맵](docs/roadmap.md)
- [검증된 플랫폼 역량과 제약](docs/platform-capabilities.md)
- [실측 증거](docs/evidence/)
