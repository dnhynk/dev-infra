# Channel Adapter 운영·live acceptance 절차

상태: **offline acceptance 구현됨 · `LIVE_CHANNEL_UNVERIFIED`**

이 문서는 D3 daemon/Channel Adapter를 사람이 검토한 뒤 제한된 live smoke로 확인하는 절차다.
자동 하니스는 Claude Code를 실행하지 않고, 사용자 `.mcp.json`·Bridge 설정·persistent 환경변수를
만들거나 고치지 않으며, development-channel 경고를 대신 승인하지 않는다.

## 1. 자동으로 확인할 수 있는 범위

repository root에서 다음을 실행한다.

```powershell
pnpm acceptance:d3-4
```

이 명령은 fake Orca·Slack·Socket 경계, OS 임시 DB, 격리된 local pipe fixture만 사용한다. 고유 pipe
fixture 외에 production fixed-pipe ownership 자체를 확인하는 명시적 test도 있다. 실제
`runDaemonCommand`·기본 delivery/resume engine·pipe·Adapter를 함께 구동하는 stateful same-ts 체인
하나와, 더 넓은 crash/timeout/중복 matrix를 각 component fault seam에서 검증한다. 모든 crash row가
daemon composition을 반복한다는 뜻은 아니다.

실행 순서는 다음과 같다.

1. D3-4 focused failure matrix
2. root/app typecheck
3. Bridge build
4. full repository tests

하니스가 만드는 것은 build output과 OS 임시 fixture뿐이다. `%APPDATA%`, home directory, `.mcp.json`,
`.claude*`, 실제 Slack/Orca/Claude resource에는 쓰지 않는다. 성공하더라도 마지막 줄은
`LIVE_CHANNEL_UNVERIFIED`를 유지한다. simulation은 실제 Channel opt-in이나 Task resume 증거가 아니다.

## 2. secret-free MCP 예시

[mcp.example.json](../../apps/orca-slack-bridge/mcp.example.json)은 자동 설치 파일이 아니다. 검토한
operator가 필요한 project의 기존 `.mcp.json`에 `mcpServers.orca-slack` 항목만 **수동으로 병합**하고
`<ABSOLUTE_REPOSITORY_PATH>`를 이 checkout의 절대경로로 바꾼다.

```json
{
  "mcpServers": {
    "orca-slack": {
      "command": "node",
      "args": [
        "<ABSOLUTE_REPOSITORY_PATH>/apps/orca-slack-bridge/dist/cli.js",
        "channel-adapter"
      ]
    }
  }
}
```

Adapter entry에는 Slack token, Bridge `--config`/`--state`, Orca identity override를 넣지 않는다.
`channel-adapter`는 session subprocess가 상속한 `CLAUDE_CODE_SESSION_ID`, `ORCA_TERMINAL_HANDLE`,
`ORCA_PANE_KEY`만 routing claim으로 읽으며, claim 자체를 인증으로 취급하지 않는다.

새 파일로 덮어쓰지 말고 기존 MCP entry를 보존해 병합한다. folder trust와 새 MCP server 승인도
사람이 화면의 정확한 대상 경로·server 이름을 확인한 뒤 선택한다.

## 3. daemon 준비

1. `pnpm --filter @dev-infra/orca-slack-bridge build`가 통과한 reviewed commit을 사용한다.
2. Slack config/state 경로는 operator가 명시한다. 예시는 repository에 있는
   `config.example.json`을 별도 운영 경로로 복사해 실제 ID만 채운 파일이어야 한다.
3. bot/app token은 operator가 관리하는 secret store 또는 현재 process 환경으로만 주입한다.
   token 값을 명령 history, 문서, `.mcp.json`, git file에 쓰지 않는다.
4. 전용 terminal에서 다음 형태로 daemon을 실행한다.

```powershell
node apps/orca-slack-bridge/dist/cli.js daemon `
  --config <ABSOLUTE_OPERATOR_CONFIG_PATH> `
  --state <ABSOLUTE_OPERATOR_STATE_PATH>
```

고정 pipe owner를 이미 가진 daemon이 있으면 두 번째 daemon은 Slack Socket ingress 전에 exit 1로
실패해야 한다. 첫 daemon을 임의로 죽여 ownership을 빼앗지 말고 기존 owner를 확인한다.

## 4. interactive Claude Code 2.1.243 smoke

이 단계는 coordinator가 실제 live write 대상을 검토한 뒤 수동으로 수행한다. 자동 하니스나 Agent가
아래 명령을 대신 실행하거나 화면을 보고 Enter를 누르면 안 된다.

```text
claude --dangerously-load-development-channels server:orca-slack
```

- 정확히 Claude Code `2.1.243`과 interactive session을 사용한다. `-p` headless session은 acceptance
  대상이 아니다.
- 매 기동 표시되는 development-channel 경고의 server 이름과 위험 문구를 사람이 읽고 직접
  승인한다. 승인 여부를 기억시키거나 keypress/click으로 자동 통과시키지 않는다.
- flag가 없거나 조직 policy가 Channel을 막으면 MCP transport가 연결돼도 probe receipt가 오지 않을
  수 있다. 이때 route는 `unverified`로 남고 production Gate를 보내지 않는 것이 정상이다.
- `.mcp.json` 등록이나 MCP initialize만으로 opt-in을 주장하지 않는다. daemon의 exact-epoch probe에
  receipt tool이 돌아온 것만 transport opt-in 증거다.

## 5. 실제 수용 관찰

coordinator가 격리한 실제 Run/Gate/Slack 대상에서 다음을 모두 기록해야 한다.

1. pending Gate 하나를 Slack의 Bridge-owned action으로 resolve한다.
2. daemon의 durable row가 `pending → attempted → receipted → consumed` 순서를 지키는지 확인한다.
3. transport write나 receipt만으로 Slack에 `▶️ 작업 재개`가 표시되지 않는지 확인한다.
4. coordinator가 Gate를 read-only로 다시 읽고, **baseline 이후** 새 Dispatch 또는 허용된 동일 Dispatch
   상태 전이로 실제 후속 Task가 시작되는 것을 Orca에서 관찰한다.
5. 그 exact Task/Dispatch witness 뒤에만 기존 Gate card의 같은 channel/ts가 갱신되는지 확인한다.
6. duplicate/late receipt, Adapter 재연결, daemon restart 뒤에도 새 Slack root/reply나 중복 Task resume가
   생기지 않는지 확인한다.
7. coordinator takeover가 있으면 이전 generation/epoch가 ACK·durable effect를 만들지 않고 새 Adapter
   epoch가 다시 probe/receipt를 통과하는지 확인한다.

실제 Slack/Orca ID, token, raw payload는 evidence에 복사하지 않는다. 필요한 correlation은 redacted
shape와 commit SHA, 시각, pass/fail로 남긴다.

## 6. 상태 해제 조건과 cleanup

다음 두 조건이 같은 reviewed build에서 모두 성립하기 전에는
`LIVE_CHANNEL_UNVERIFIED`를 삭제하거나 완화하지 않는다.

- interactive Claude Code 2.1.243 development-channel smoke가 사람이 직접 경고를 승인한 세션에서 통과
- 그 세션의 receipt 뒤 실제 post-baseline Orca Task/Dispatch resume와 기존 Slack card 갱신이 관찰됨

종료할 때는 먼저 interactive Claude session을 정상 종료해 Adapter stdio를 닫고, daemon에
SIGINT/SIGTERM을 한 번 보내 bounded drain을 기다린다. 하니스나 operator 절차는 자신이 만들지 않은
process를 kill하지 않는다. 임시 MCP entry를 제거할 때도 기존 `.mcp.json`을 통째로 삭제하지 말고
수동으로 병합한 `orca-slack` 항목만 검토 후 되돌린다.
