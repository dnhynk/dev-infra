# T5 · Claude Code Channel Adapter 재검증과 D3 계약 근거

관측일: **2026-08-23** · 대상 OD: OD-052~059, OD-066

이 문서는 관측 기록이다. 열린 결정을 닫지 않는다. 각 절은 [가설/질문] → [근거] → [확인된 사실] → [배제되는 선택지] → [남는 선택지] 순이다.
문장 앞의 `[관측]`은 이 환경에서 실행해 확인한 것, `[문서]`는 공식 문서로만 확인한 것, `[추론]`은 둘로부터의 판단이다.

## 0. 관측 환경과 하니스

| 항목 | 값 |
|---|---|
| Claude Code | `2.1.241` (2026-08-22 실측 시점은 `2.1.238`) |
| 계정 | 개인 Max, 배너 표기 `donghyun9282@gmail.com's Organization` |
| OS / Node | Windows 11 26200 / `v26.7.0` |
| MCP SDK | `@modelcontextprotocol/sdk`, `LATEST_PROTOCOL_VERSION = 2025-11-25` |
| 하니스 위치 | `C:\Users\dongh\AppData\Local\Temp\orca-THROWAWAY-t5-channel` (레포 밖) |

하니스는 두 프로세스다. `daemon.mjs`는 별도로 실행되는 Bridge daemon 역할로 named pipe·TCP loopback·HTTP control plane을 연다. `adapter.mjs`는 `.mcp.json`에 등록돼 Claude Code가 stdio로 spawn하는 Channel Adapter 후보이며, `capabilities.experimental["claude/channel"]`과 reply tool 3종(`orca_report_receipt`, `orca_list_pending`, `orca_whoami`)을 선언한다.

daemon이 기록하는 상태는 architecture 문서 §5의 개념 상태에 대응한다.

```text
NOTIFICATION_PENDING            daemon 큐에 적재
TRANSPORT_WRITE_REQUESTED       daemon → Adapter IPC 전달
TRANSPORT_WRITE_ATTEMPTED       Adapter가 mcp.notification() 을 오류 없이 완료
APPLICATION_RECEIPT_RECEIVED    세션이 reply tool 을 호출
```

관측은 두 라운드다. **round 1**은 2026-08-23 04:29~04:56Z, `.mcp.json`이 `adapter.mjs`를 가리키던 구성. **round 3**은 05:36~06:05Z, §(d)의 dead window를 동일 payload로 재측정하려고 `adapter3.mjs`/`daemon3.mjs`로 계측을 바꾼 구성이다. 아래 발췌에는 어느 라운드·어느 run·adapter 시작 기준 몇 ms인지를 함께 적는다. 원시 로그 전문은 싣지 않는다(레포 밖, 커밋하지 않음: `daemon-round1.log`, `adapter.log`, `state-round1.json`, `daemon3-run<N>.log`, `adapter3-run<N>.log`, `state-round3-run<N>.json`, `adapter3-boot-<tag>-<pid>.json`).

### 재현 절차

빈 상태에서 아래를 그대로 하면 §(a)·§(c)·§(d)·§(e)의 관측이 재현된다. secret은 필요 없다.

**1. 하니스 디렉터리** — 레포 밖(시스템 temp)에 만든다. `npm init -y && npm i @modelcontextprotocol/sdk`.

**2. Adapter** (`adapter.mjs`). 채널로 인정받는 조건은 `capabilities.experimental['claude/channel']` 하나다. 나머지는 표준 MCP다.

```js
const T0 = Date.now();
const mcp = new Server({ name: 'orca-t5', version: '0.0.1' }, {
  capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
  instructions:
    'Events arrive as <channel source="orca-t5" event_id="..." seq="..."> from the THROWAWAY Orca bridge harness. ' +
    'For EVERY such event you MUST immediately call the orca_report_receipt tool with the event_id from the tag ' +
    'and status "processed", before doing anything else. Do not ask the user for confirmation. ' +
    'In the note field, say whether you had already seen that event_id earlier in this session. ' +
    'The orca_list_pending tool re-queries the daemon for events that have no receipt yet.',
});
// reply tool 3종: orca_report_receipt(event_id,status,note) / orca_list_pending() / orca_whoami()
await mcp.connect(new StdioServerTransport());          // 여기서 resolve돼도 세션은 아직 준비 전이다 (§(d))
// daemon이 push를 보내면:
await mcp.notification({
  method: 'notifications/claude/channel',
  params: { content: ev.content, meta: { ...ev.meta, event_id: ev.id } },
});
log('notification_written', { id: ev.id, offset_ms: Date.now() - T0 });   // 시점 판정의 기준선
```

**3. daemon** (`daemon.mjs`) — 별도 프로세스. named pipe `\\.\pipe\orca-t5-throwaway`와 TCP `127.0.0.1:8792`를 listen하고, 운영자용 HTTP control plane을 `127.0.0.1:8791`에 연다. Adapter는 재시도 client로 붙고 연결되면 `{"type":"hello","identity":{...}}`를 보낸다. daemon은 hello를 받으면 **application receipt가 없는 event를 전부 재전송**하고, `{"type":"receipt",...}`를 받으면 그 event를 재전송 대상에서 뺀다. event별로 `NOTIFICATION_PENDING → TRANSPORT_WRITE_REQUESTED → TRANSPORT_WRITE_ATTEMPTED → APPLICATION_RECEIPT_RECEIVED` 이력을 남긴다.

**4. `.mcp.json`** — 하니스 디렉터리에 둔다.

```json
{ "mcpServers": { "orca-t5": {
    "command": "node",
    "args": ["<하니스경로>\\adapter.mjs"],
    "env": { "T5_IPC": "tcp" } } } }
```

**5. 세션 기동** — daemon을 먼저 띄운 뒤 하니스 디렉터리에서:

```text
claude --dangerously-load-development-channels server:orca-t5
```

첫 기동에는 folder trust와 `New MCP server found in this project: orca-t5` 대화상자가 붙고, development-channels 경고 대화상자는 **매 기동** 뜬다. 경고는 `1. I am using this for local development`(Enter)로 통과시킨다. 무인 기동은 이 키 입력을 자동화해야 한다.

**6. push** — HTTP control plane에 POST. round 1의 실제 payload 형태:

```text
POST http://127.0.0.1:8791/push
{"id":"ev_001","content":"Gate gate_84 was resolved by the owner. Re-read it from Orca.",
 "meta":{"seq":"1","gate_id":"gate_84","kind":"gate_resolved"}}
```

이 payload가 세션에 도달하면 tag는 `<channel source="orca-t5" seq="1" gate_id="gate_84" kind="gate_resolved" event_id="ev_001">`가 된다. 속성 순서는 `meta` 객체의 삽입 순서이고 `event_id`는 Adapter가 마지막에 넣는다.

**7. session prompt** — round 3은 사용자 턴을 **전혀 주지 않았다.** MCP `instructions` 문자열만으로 세션이 매 event에 `orca_report_receipt`를 부른다. round 1은 여기에 더해 첫 event 뒤에 아래 사용자 턴을 줬다. 이 지시는 §(e)의 판정에 교란으로 작용하므로 재현 시 **넣지 않는 쪽이 기본**이다.

```text
RULES for this session: you are a passive test harness. For every <channel> event, do exactly one thing:
call orca_report_receipt with the event_id and status, and in note say whether you had already seen that
event_id earlier in this session. Then stop and say nothing else. Never run any orca command, never read
or write files, never run bash. Confirm you understand.
```

**8. §(d) 재측정을 재현하려면** — daemon이 hello를 받은 시점을 기준으로 정확한 offset에 쓰도록 daemon 쪽에서 타이머를 걸어야 한다. 폴러로 로그를 감시해 push하면 수백 ms 단위 offset을 맞출 수 없다. round 3의 daemon은 hello 처리에서 (1) 미receipt event를 즉시 재전송하고(= adapter 시작 +15~20ms의 **early write**), (2) 150·400·1000·2500ms에 내용·`meta`가 완전히 같고 id만 다른 사다리 event를 쏘고, (3) 25000ms에 (1)과 **동일한 id·content·meta**를 다시 쓴다(= **late write**). 또 hello의 `adapter_start_iso`가 10초보다 오래된 연결(= 이미 살아 있던 세션의 재접속)은 건너뛴다. 그렇지 않으면 사다리가 아무 기준도 없는 시점을 재게 된다.

---

## (a) 재검증 — 2.1.241에서 end-to-end 전달이 성립하는가

### 가설

2026-08-22 실측(2.1.238)의 결론 — custom channel end-to-end 전달 성립, 유실 0·중복 0, `-p` 미도달 — 이 버전이 오른 2.1.241에서도 유지된다.

### 근거

버전 확인:

```text
$ claude --version
2.1.241 (Claude Code)
```

세션 기동. `.mcp.json`에 `orca-t5`를 등록하고 대화형 세션을 띄웠다.

```text
PS ...\orca-THROWAWAY-t5-channel> claude --dangerously-load-development-channels server:orca-t5
```

기동 배너:

```text
 ▎ Channels (experimental) messages from server:orca-t5 inject directly in this session · restart without
 ▎ --dangerously-load-development-channels to stop
```

5초 간격 12회 + 단발 1회, 총 13개 push. daemon 상태 덤프(발췌):

```text
seq=  1 ev_001 APPLICATION_RECEIPT_RECEIVED write=04:30:59.127Z receipt=04:31:08.994Z writes=1
seq=  2 ev_002 APPLICATION_RECEIPT_RECEIVED write=04:32:19.688Z receipt=04:32:25.228Z writes=1
...
seq= 13 ev_013 APPLICATION_RECEIPT_RECEIVED write=04:33:15.562Z receipt=04:33:24.351Z writes=1
total: 13 receipted: 13
```

세션이 실제로 본 tag(세션에 직접 물어 verbatim 인용받음):

```text
<channel source="orca-t5" gate_id="under_score_ok" UPPER="upper_ok" n1="digit_ok" _lead="underscore_lead" event_id="ev_meta">
```

`-p` 비대화형 재검증. `claude -p "..." --dangerously-load-development-channels server:orca-t5`를 띄우고 adapter 프로세스 시작 시각 기준 +5·+12·+22·+35초에 push했다. 네 건 모두 transport write는 성공했고 receipt는 0건, 해당 adapter pid의 `tool_call` 로그도 0건이었다.

```text
seq=  5 q_probe_5  TRANSPORT_WRITE_ATTEMPTED  write=04:53:34.323Z receipt=-
seq= 12 q_probe_12 TRANSPORT_WRITE_ATTEMPTED  write=04:53:41.347Z receipt=-
seq= 22 q_probe_22 TRANSPORT_WRITE_ATTEMPTED  write=04:53:51.377Z receipt=-
seq= 35 q_probe_35 TRANSPORT_WRITE_ATTEMPTED  write=04:54:04.319Z receipt=-
$ grep -c '"pid":32096.*tool_call' adapter.log
0
```

### 확인된 사실

- [관측] **재검증 통과.** 2.1.241에서 custom channel end-to-end 전달이 성립한다. 13/13 도달, 유실 0, 중복 0, 순서 보존(receipt 시각이 seq 순으로 단조 증가).
- [관측] push→receipt 지연은 5.5~9.9초. 2026-08-22 기록의 7~10초와 같은 범위다.
- [관측] `-p` 비대화형 미도달이 재현됐다. 이번에는 세션이 살아 있는 동안 창 안쪽 4개 지점에서 push해 "세션이 이미 끝나서 못 받았다"를 배제했다.
- [관측] `meta` 키 규칙 재확인: `gate-id`(하이픈)는 조용히 사라지고 `gate_id`·`UPPER`·`n1`·`_lead`는 보존된다. 대문자와 선행 밑줄도 허용된다.
- [관측] `source` 속성값은 `orca-t5` — `server:` 접두 없이 `.mcp.json`의 서버 키 그대로다.
- [관측] Adapter가 넣은 `event_id`가 tag 속성으로 그대로 도달한다. 속성 순서는 `meta` 객체의 삽입 순서다.

### 이전 실측과 달라진 점

- [관측] `CLAUDE_PID`가 Adapter 환경에 **아예 없다**(`null`). 2026-08-22 기록은 "조상 값이 상속되므로 사용 금지"였는데, 2.1.241에서는 변수 자체가 없다. 어느 쪽이든 사용 금지 결론은 같지만 근거가 바뀌었다.
- [관측] `ORCA_WORKSPACE_ID`도 Adapter 환경에 없다(`null`). `ORCA_TERMINAL_HANDLE`·`ORCA_PANE_KEY`·`ORCA_WORKTREE_ID`·`ORCA_AGENT_HOOK_PORT`는 있다.
- [관측] 이전 기록에 없던 변수 두 개가 Adapter에 상속된다: `CLAUDE_CODE_MESSAGING_SOCKET`(`\\.\pipe\LOCAL\cc-msg-` + 32 hex), `CLAUDE_CODE_MESSAGING_TOKEN`(32 hex). 둘 다 세션마다 값이 다르다(§(c) 근거 4-1). 프로토콜은 조사하지 않았고 공식 문서에도 없다. **의존하지 않는다.**
- [관측] **새로 발견된 실패 모드가 있다. §(d)의 startup dead window 참조.** 이전 실측은 이 구간을 건드리지 않아 드러나지 않았다.

### 배제되는 선택지

- daemon이 `-p`로 coordinator를 대신 띄우는 설계. [관측] 2.1.238에 이어 2.1.241에서도 미도달. 2개 버전, 8개 데이터 포인트에서 반복 실패.
- Adapter가 `CLAUDE_PID`로 세션을 식별하는 설계. [관측] 변수가 존재하지 않는다.

### 남는 선택지

- coordinator 세션을 대화형으로 유지하는 설계만 남는다. 세션을 살려 두는 수단(Orca terminal, 상시 콘솔)은 별개 문제이며 이 Task에서 관측하지 않았다.

---

## (b) OD-052 — daemon ↔ Adapter localhost IPC

### 질문

Claude Code가 stdio로 spawn한 MCP 서브프로세스가, 별도로 실행 중인 daemon과 통신할 localhost 수단은 무엇이고 각각이 Windows에서 성립하는가. 조건 두 가지: (1) Adapter 수명이 세션에 묶인다. (2) daemon이 Adapter보다 먼저 뜰 수도, 나중에 뜰 수도 있다.

### 근거

**Named pipe (Adapter가 client).** daemon이 `\\.\pipe\orca-t5-throwaway`를 listen하고 Adapter가 2초 간격으로 재시도 연결한다.

```text
daemon: {"kind":"listening_pipe","pipe":"\\\\.\\pipe\\orca-t5-throwaway"}
daemon: {"kind":"adapter_connected","connId":"pipe#1","transport":"pipe"}
```

**TCP loopback (Adapter가 client).** `.mcp.json`의 `env`로 `T5_IPC=tcp`를 주고 127.0.0.1:8792로 전환했다.

```text
daemon: {"kind":"listening_tcp","port":8792}
daemon: {"kind":"adapter_connected","connId":"tcp#2","transport":"tcp"}
```

**daemon이 나중에 뜨는 경우.** 세션을 먼저 띄우고 daemon을 나중에 시작했다. Adapter는 `ENOENT`로 18회 실패한 뒤 연결됐다.

```text
adapter: {"t":"04:29:56.697Z","kind":"daemon_connect_error","attempt":1,"err":"Error: connect ENOENT \\\\.\\pipe\\orca-t5-throwaway"}
adapter: {"t":"04:30:10.756Z","kind":"daemon_connect_error","attempt":8,...}
adapter: {"t":"04:30:30.826Z","kind":"daemon_connected","attempt":18,"IPC_MODE":"pipe"}
```

**Adapter 수명.** 세션이 종료될 때마다 daemon에 `adapter_disconnected`가 찍히고, 세션을 다시 띄우면 새 pid로 새 연결이 생긴다. 관측된 연결은 `pipe#1`~`pipe#3`, `tcp#2`~`tcp#5`로 세션 기동마다 1:1 대응했다.

**`.mcp.json`의 `env` 블록이 Adapter에 전달된다.** [관측] `T5_IPC`, `T5_GATE`, `T5_GATE_DELAY_MS`를 이 경로로 주입해 동작을 바꿨다. Adapter 설정을 세션 밖에서 고정하는 수단이 있다는 뜻이다.

### 확인된 사실

- [관측] Windows 11에서 named pipe와 TCP loopback 둘 다 성립한다. 같은 Adapter 코드에서 환경변수 하나로 전환됐다.
- [관측] daemon-먼저·daemon-나중 양쪽 다 성립한다. Adapter가 재시도 client가 되면 daemon 기동 순서에 의존하지 않는다.
- [관측] Adapter 프로세스는 세션마다 새로 뜨고 세션 종료와 함께 죽는다. 따라서 IPC 연결은 세션 단위 수명이며, daemon 쪽이 연결을 세션 identity로 색인해야 한다(§(c)).
- [문서] 공식 예제는 반대 방향도 제시한다. webhook receiver 예제에서 MCP server가 `127.0.0.1:8788`을 직접 listen하고 외부가 POST한다. ([Channels reference — Example](https://code.claude.com/docs/en/channels-reference#example-build-a-webhook-receiver))

### 배제되는 선택지

- daemon 기동 순서를 전제하는 설계. [관측] 불필요하다. 재시도 client 한 줄로 해결된다.
- 고정 포트에 Adapter가 listen하고 daemon이 접속하는 방식. [추론] 배제되지는 않지만, coordinator 세션이 여러 개면 Adapter마다 포트가 달라져 daemon이 포트를 발견할 경로가 따로 필요하다. Adapter→daemon 방향은 daemon 주소가 하나뿐이라 이 문제가 없다. 이 Task에서 Adapter-listen 방향은 **실행하지 않았다.**

### 남는 선택지

1. **named pipe, Adapter가 client** — 권장(미확정). [관측] Windows 네이티브이고 포트 충돌·포트 파일이 없다. 이름 하나가 고정 주소가 된다.
2. **TCP loopback, Adapter가 client** — [관측] 동작한다. 포트 선점 위험과 포트 파일 관리가 붙는다.
3. **HTTP loopback, Adapter가 server** — [문서] 공식 예제 형태. [관측 안 함] 다중 세션에서의 포트 발견 문제가 미해결.
4. **파일 기반 큐/디렉터리 감시** — [관측 안 함] 나열만 한다.

권장 근거는 Windows 네이티브 + 주소 고정이지 성능이 아니다. 성능은 측정하지 않았다.

---

## (c) OD-053/058 — routing과 binding, 그리고 세션 opt-in 자기 인지

### 질문 셋

1. MCP 서브프로세스가 `CLAUDE_CODE_SESSION_ID`를 자기 세션 값으로 상속하는가.
2. Adapter가 자기 session id와 worktree를 daemon에 보고해 per-session routing이 성립하는가.
3. Fresh/Resume에서 binding이 어떻게 갱신되는가.
4. **Adapter나 세션이 "이 세션이 channel opt-in 상태인가"를 스스로 알 수 있는가.**

### 근거 1·2 — 상속과 routing

Adapter가 부팅 시 덤프한 identity(발췌):

```json
{
  "pid": 28468, "ppid": 29888,
  "cwd": "C:\\Users\\dongh\\AppData\\Local\\Temp\\orca-THROWAWAY-t5-channel",
  "argv": ["C:\\nvm4w\\nodejs\\node.exe", "...\\adapter.mjs"],
  "CLAUDE_CODE_SESSION_ID": "6601fead-619d-4ff6-95ca-46e1eaa7b51b",
  "CLAUDE_PID": null,
  "CLAUDE_PROJECT_DIR": "C:\\Users\\dongh\\AppData\\Local\\Temp\\orca-THROWAWAY-t5-channel",
  "ORCA_TERMINAL_HANDLE": "term_df8bf929-6fba-4932-ba25-ae43d41cd2c3",
  "ORCA_PANE_KEY": "28767aff-...:889461c0-...",
  "ORCA_WORKTREE_ID": "ccb3c8ee-...::C:/Users/dongh/orca/workspaces/dev-infra/phase0-t5-channel",
  "ORCA_WORKSPACE_ID": null,
  "ORCA_AGENT_HOOK_PORT": "52428"
}
```

세션 종료 시 Claude Code가 출력한 재개 명령이 같은 값을 가리킨다.

```text
Resume this session with:
claude --resume 6601fead-619d-4ff6-95ca-46e1eaa7b51b
```

대화형 세션 2개를 동시에 띄우고 daemon이 본 연결:

```text
tcp#2 tcp 88510fdb-c527-4ec1-9d64-ed26953ccb5d term_df8bf929-... pane 28767aff-...:889461c0-...
tcp#3 tcp c4d18686-2f88-4eca-8512-2fee50e528af term_07ecc0b1-... pane 8e3b6677-...:442d21bd-...
```

`target_session`으로 지목해 push:

```text
fanout target= 88510fdb-...  delivered_to= 1  connected= 2
fanout target= c4d18686-...  delivered_to= 1  connected= 2
receipt from tcp#2 ev_routeA processed
receipt from tcp#3 ev_routeB processed
```

### 근거 3 — Fresh/Resume

```text
claude                                        → CLAUDE_CODE_SESSION_ID = 7de6d430-e6bc-4b84-bf19-ddc4ebfae22d  (fresh)
claude --dangerously-load-...                 → CLAUDE_CODE_SESSION_ID = 828805fb-b7e5-408a-afc0-71bb2b024389  (fresh)
claude --resume 6601fead-619d-4ff6-95ca-46e1eaa7b51b --dangerously-load-...
                                              → CLAUDE_CODE_SESSION_ID = 6601fead-619d-4ff6-95ca-46e1eaa7b51b  (동일)
```

### 근거 4 — opt-in 자기 인지 (핵심)

네 가지 관측을 겹쳐서 확인했다.

**(4-1) argv가 같고, env는 값까지 비교했다.** round 1은 키 이름만 저장해 "동일하다"고 적었는데 그것으로는 음성 증거가 되지 않는다. round 3에서 `CLAUDE|MCP|CHANNEL|ANTHROPIC|ORCA`에 걸리는 모든 변수의 **값**을 flag 세션 2개와 no-flag 세션 1개에서 덤프해 대조했다.

전체 env 키 집합, `argv`, `execArgv`는 세 세션이 완전히 같다. 값이 다른 변수는 셋뿐이다.

| 변수 | flag 세션 A | flag 세션 B | no-flag 세션 |
|---|---|---|---|
| `CLAUDE_CODE_SESSION_ID` | `72caa451-…` | `07252c90-…` | `f2c55ac7-…` |
| `CLAUDE_CODE_MESSAGING_SOCKET` | `\\.\pipe\LOCAL\cc-msg-eafb2bf7…` | `\\.\pipe\LOCAL\cc-msg-e63efad1…` | `\\.\pipe\LOCAL\cc-msg-4c1582ce…` |
| `CLAUDE_CODE_MESSAGING_TOKEN` | 32자 hex | 32자 hex | 32자 hex |

핵심은 **flag 세션 두 개끼리도 이 셋이 서로 다르다**는 것이다. 형식은 셋 다 같다 — session id는 UUID, socket은 `\\.\pipe\LOCAL\cc-msg-` + 32 hex, token은 32 hex. 즉 이 셋은 세션마다 새로 생기는 식별자이지 flag의 표지가 아니다. 값·형식·유무 어느 축으로도 flag 세션과 no-flag 세션을 가를 수 없다.

나머지는 전부 값까지 동일했다: `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_PROJECT_DIR`, `ORCA_TERMINAL_HANDLE`, `ORCA_PANE_KEY`, `ORCA_WORKTREE_ID`, `ORCA_TAB_ID`, `ORCA_AGENT_HOOK_*`, `ORCA_APP_VERSION` 등. `ORCA_*`가 같은 것은 세 세션을 **같은 Orca terminal에서 차례로 띄웠기 때문**이다. 다른 terminal이면 `ORCA_TERMINAL_HANDLE`·`ORCA_PANE_KEY`·`ORCA_TAB_ID`가 달라진다(round 1의 2세션 동시 관측). flag와는 무관하다.

[관측 안 함] `CLAUDE_CODE_MESSAGING_SOCKET`에 접속해 무엇이 오가는지는 조사하지 않았다. 그 소켓이 세션 상태(opt-in 포함)를 노출하는지는 열려 있다. 다만 문서화되지 않은 내부 IPC이고 버전 계약이 없다.

**(4-2) MCP `initialize` payload도 동일하다.** flag 세션(pid 33884)과 no-flag 세션(pid 35700)에서 client가 보낸 값을 그대로 찍었다.

```text
pid 33884  {"name":"claude-code","title":"Claude Code","version":"2.1.241",...}  {"elicitation":{"form":{}},"roots":{"listChanged":true}}
pid 35700  {"name":"claude-code","title":"Claude Code","version":"2.1.241",...}  {"elicitation":{"form":{}},"roots":{"listChanged":true}}
```

**(4-3) 그럼에도 전달 결과는 갈린다.** 두 세션이 붙은 상태에서 broadcast 1건을 push하자 flag 세션만 receipt를 냈다.

```text
{"ok":true,"id":"ev_optin","adapters":2}
receipt from tcp#4 ev_optin processed        # tcp#4 = pid 33884 = flag 세션
# tcp#5 (pid 35700, no-flag) 로부터의 receipt 없음
```

**(4-4) 세션 자신도 모른다.** flag 없이 띄운 세션에 직접 물었다.

> "there is no text anywhere in my system prompt about a channel called 'orca-t5' as a channel... under '# MCP Server Instructions ## orca-t5' it says 'Events arrive as <channel source="orca-t5" ...>'... I have received no channel event in this session... As for whether the session was started with a channels flag: **I don't know, and I have no way to see the launch command line**; the only evidence I have is the presence of the orca-t5 MCP server and its tools, which indicates an MCP server connection, not a channels flag."

부수 관측: [관측] 서버의 `instructions` 문자열은 **flag 유무와 무관하게** 세션 system prompt의 `# MCP Server Instructions` 절에 들어간다. 따라서 "instructions가 보이니 channel이 켜졌다"는 판정은 틀린다.

### 확인된 사실

- [관측] `CLAUDE_CODE_SESSION_ID`는 Adapter 자기 세션 값이며, 이 값이 `claude --resume`의 인자와 동일하다. 세션을 **구분**하는 1차 키로 쓸 수 있다. 세션을 **인증**하지는 못한다(아래).
- [관측] `--resume <id>`는 session id를 **보존한다.** Resume은 새 id를 만들지 않는다.
- [관측] flag 없는 `claude` 재기동은 **매번 새 id**를 만든다.
- [관측] `ORCA_TERMINAL_HANDLE`·`ORCA_PANE_KEY`·`ORCA_WORKTREE_ID`가 Adapter에 그대로 상속된다. 동일 worktree의 두 세션은 `ORCA_WORKTREE_ID`가 같고 `ORCA_PANE_KEY`·`CLAUDE_CODE_SESSION_ID`가 다르다.
- [관측] daemon이 IPC 연결을 `CLAUDE_CODE_SESSION_ID`로 색인하면 per-session routing이 성립한다. 2세션 동시 접속에서 각각 1건씩만 도달했다.
- [관측] **Adapter가 볼 수 있는 곳에는 opt-in 신호가 없다.** argv·execArgv·env(값까지)·MCP `initialize` payload 어디에도 flag 세션과 no-flag 세션을 가르는 것이 없고, `mcp.notification()`은 opt-in 안 된 세션에서도 오류 없이 성공한다.
- [관측] **세션도 자기 opt-in 여부를 알 수 없다.** launch 명령줄에 접근할 수 없다.
- [관측] `initialize`에서 client version(`2.1.241`)은 얻을 수 있다. 버전 gating은 가능하다.
- [관측] **`CLAUDE_CODE_SESSION_ID`는 인증되지 않은 주장이며, 양쪽 방향 모두에서 위조된다.** 두 가지를 실제로 해 봤다.
  - `.mcp.json`의 `env` 블록에 `"CLAUDE_CODE_SESSION_ID": "00000000-dead-beef-0000-000000000000"`을 넣고 flag 세션을 띄웠다. Adapter가 읽은 값은 그 위조값이었다. 레포에 커밋된 설정 파일 하나가 binding 주장을 바꾼다.
  - Claude Code 세션에서 실행된 적 없는 평범한 소켓 클라이언트로 daemon에 접속해 살아 있는 다른 세션의 id를 담은 `hello`를 보냈다. daemon은 `hello_ack`을 돌려주고 **그 세션 앞으로 쌓여 있던 pending event를 즉시 그 클라이언트에게 전부 밀어 줬다.**
- [추론] 따라서 opt-in 검증은 **이 Task가 관측한 범위 안에서는** end-to-end probe로만 가능하다. daemon이 probe event를 보내고 receipt가 돌아오는지로 판정하는 것 외에 다른 수단을 찾지 못했다. **다만 조사하지 않은 경로가 남아 있으므로**(위 `CLAUDE_CODE_MESSAGING_SOCKET`) "end-to-end probe뿐"은 확정이 아니다. OD-058은 **미확정**으로 남는다.

### 배제되는 선택지

- Adapter가 자기 argv/env/initialize를 보고 opt-in을 판정하는 설계. [관측] 신호가 존재하지 않는다.
- `mcp.notification()`의 성공을 opt-in 증거로 삼는 설계. [관측] no-flag 세션에서도 `ok:true`가 나온다.
- coordinator에게 "너 channel 켜져 있니?"라고 물어 답을 신뢰하는 설계. [관측] 세션이 알 수 없다고 답한다. `instructions`가 보이는 것은 opt-in 증거가 아니다.
- `CLAUDE_PID`나 `ORCA_WORKSPACE_ID` 기반 binding. [관측] 2.1.241에서 둘 다 Adapter 환경에 없다.

### 남는 선택지

**binding 키.** 아래는 전부 **식별자 후보**이고, 그 자체로는 인증이 아니다. platform-capabilities §2.7의 경고가 관측으로 확인됐다 — **환경변수는 주장이지 증명이 아니다.** 위 (근거 4)에서 두 방향의 위조를 실제로 재현했으므로, 어느 키를 고르든 그 키만으로 Gate를 라우팅하면 stale하거나 위조된 Adapter에 Gate resolution이 갈 수 있다.

1. `CLAUDE_CODE_SESSION_ID` 단독 — [관측] 유일하게 세션을 구분하고 resume에서 보존된다. **인증이 없으므로 단독으로는 권장하지 않는다.** 쓰려면 아래 3~5 중 하나를 함께 세워야 한다.
2. `CLAUDE_CODE_SESSION_ID` + `ORCA_PANE_KEY` 복합 — [관측] 둘 다 사용 가능. Run row의 `coordinator_pane_key`와 직접 대조할 수 있다. 다만 두 값 모두 같은 방식으로 위조되므로 **위조 저항이 아니라 오배송 방지**에 해당한다.

**binding을 신뢰하려면 무엇이 더 필요한가 — 선택지(전부 미검증):**

3. **daemon이 발급한 비밀로 연결을 인증한다.** daemon이 세션 밖 경로(예: Orca가 세션을 띄울 때 주는 값)로 세션마다 다른 토큰을 심고, Adapter가 hello에 그 토큰을 실어야만 받아 준다. [추론] 위조 소켓 클라이언트를 막는다. 전제는 "Adapter만 읽고 다른 프로세스는 못 읽는 경로"가 있다는 것이며 이 Task는 그런 경로를 확인하지 않았다.
4. **Orca 쪽 사실과 대조한다.** Adapter가 보고한 `ORCA_PANE_KEY`를 Run row의 `coordinator_pane_key`와 맞춘다. [관측] 두 값 모두 실재하고 형식이 같다. [추론] Orca가 그 pane에 실제로 그 세션이 붙어 있음을 보증할 때만 의미가 있다.
5. **binding을 인증하지 않는 대신 payload를 무해하게 만든다.** channel에는 `gate_id`만 싣고 내용은 coordinator가 Orca에서 자기 권한으로 다시 읽는다. [추론] 잘못 라우팅돼도 새는 것이 id뿐이고, 위조된 Adapter는 Orca 권한이 없어 내용을 못 읽는다. **이 Task가 관측한 것 중 위조 위험을 실제로 줄이는 유일한 형태다.** 단 §(e)에서 보듯 이것은 보안 선택이지 플랫폼이 강제하는 제약이 아니다.
6. **binding을 신뢰하지 않고 매 전달을 probe로 확인한다.** OD-058의 (A)와 같은 메커니즘. [추론] 위조를 막지는 못하고 오배송을 늦게 알아차릴 뿐이다.

어느 것도 이 Task에서 구현·검증하지 않았다. **OD-053은 닫히지 않는다.**

**Fresh/Resume 시 binding 갱신:**
- (i) Adapter가 hello를 보낼 때 daemon이 해당 Run의 binding을 최신 연결로 덮어쓴다.
- (ii) daemon이 Orca Run row의 `coordinator_pane_key`와 Adapter가 보고한 `ORCA_PANE_KEY`를 대조해 승인한다.
- (iii) 위 둘 다에 opt-in probe를 붙여 "연결됨"과 "channel 살아 있음"을 분리한다.

이 Task는 어느 것도 구현·검증하지 않았다. 재료가 모두 존재함만 관측했다.

**opt-in 검증 책임(OD-058):**
- (A) daemon이 hello 직후 probe event를 보내고 N초 안에 receipt가 없으면 그 세션을 `channel_unverified`로 표시한다.
- (B) coordinator가 부팅 절차에서 스스로 probe를 요청하는 tool을 호출한다.
- (C) 둘 다.

(A)만이 세션 협조 없이 성립한다. [추론] (B)는 세션이 그 tool을 부른다는 보장이 없다. channel 본문으로 세션에 probe를 시키는 형태는 §(e)를 볼 것 — 본문 지시가 통하는지는 이 Task가 확정하지 못했다.

---

## (d) OD-054/055/059 — 전달 단계와 ACK

### 질문

보낸 쪽이 "전송됨"과 "세션이 실제로 처리함"을 구분할 수단이 있는가. `notifications/claude/channel`은 단방향인가. 세션이 결과를 daemon에 돌려주는 경로가 Adapter tool뿐인가.

### 근거

[문서] 공식 문서가 단방향임을 명시한다.

> "Claude Code doesn't acknowledge notifications. The `await` on `mcp.notification()` resolves when the message is written to the transport, not when Claude has processed it. If the session hasn't loaded your server as a channel, or the organization policy blocks it, Claude Code drops the events silently and returns no error to your server."
> — [Channels reference — Notification format](https://code.claude.com/docs/en/channels-reference#notification-format)

> "If you need delivery confirmation, track event state in your server and expose a reply tool that Claude can call to report status back."
> — 같은 절

[관측] 이 명세가 정확히 재현된다. 세 가지 조건에서 `mcp.notification()`이 모두 오류 없이 완료됐고 receipt만 갈렸다.

| 조건 | transport write | application receipt |
|---|---|---|
| flag 있는 대화형 세션 | 성공 | 도착 |
| flag 없는 세션 (`.mcp.json` 등록만) | 성공 | 없음 |
| `--channels server:orca-t5` (거부된 항목) | 성공 | 없음 |
| `-p` 비대화형 세션 | 성공 | 없음 |
| 세션 startup dead window | 성공 | 없음 |

reply tool 왕복이 실제 receipt 경로로 동작한다.

```text
adapter: {"kind":"tool_call","name":"orca_report_receipt","args":{"event_id":"ev_001","status":"processed","note":"..."}}
daemon:  {"kind":"event_state","id":"ev_001","state":"APPLICATION_RECEIPT_RECEIVED","status":"processed"}
```

**새 실패 모드 — startup dead window.**

가설: adapter 프로세스 시작 직후에 쓴 notification은 세션에 도달하지 않는다.
반증 관측: **완전히 동일한 payload**를 한 세션 안에서 두 시점(직후 / 수십 초 뒤)에 쓴다. 뒤엣것만 도달하면 payload가 아니라 시점이 변수다. 두 번 다 도달하거나 두 번 다 유실되면 가설은 틀렸다.

round 1은 이 대조를 하지 않았다. round 1이 남긴 것은 `ev_300`을 서로 다른 두 세션 기동 직후에 한 번씩 쓴 기록(adapter 시작 +29ms, +47ms)과, 그 뒤 세션이 `orca_list_pending`으로 회수해 `recovered_by_requery`로 receipt한 사실뿐이다. **`ev_300`의 성공적인 channel 재전송은 일어나지 않았다.** 같은 창에서 성공한 `probe_3`(+3.12s)는 id·content·`meta`가 모두 다른 별개 event이므로 시점 대조의 짝이 되지 못한다.

그래서 round 3에서 동일 payload로 다시 쟀다. 한 세션 안에서 event `dw_N`을 **같은 id·content·meta·연결로** early(hello 직후)와 late(+25초) 두 번 쓴다.

**표본: 세션 기동 4회(run 2~5), 각 회 1쌍.** 4쌍 모두 같은 방향으로 갈렸다.

| run | session id | early write | 도달 | late write (동일 payload) | 도달 |
|---|---|---|---|---|---|
| 2 | `80aa04d5-…` | +16ms | ✗ | +25028ms | ✓ |
| 3 | `1dd7c501-…` | +16ms | ✗ | +25022ms | ✓ |
| 4 | `07252c90-…` | +16ms | ✗ | +25025ms | ✓ |
| 5 | `72caa451-…` | +15ms | ✗ | +25016ms | ✓ |

`dw_N`의 receipt는 매번 late write 뒤에 한 번만 왔고 note가 "not seen earlier in this session"이었다. early write가 도달했다면 그 시점에 첫 receipt가 났어야 하고, late는 `duplicate_ignored`로 왔어야 한다. run 2 원시 기록:

```text
[round3 run2, adapter pid 기준 offset]
+1      adapter_start
+6      mcp_connected                       ← await mcp.connect() 반환
+16     notification_written dw_2           ← early, 유실
+177    mcp_initialized
+281    tools_list_requested
+25028  notification_written dw_2           ← late, 동일 id·content·meta
+35262  tool_call orca_report_receipt {"event_id":"dw_2","status":"processed",
        "note":"Not seen earlier in this session — new event_id, ..."}
```

**경계.** 같은 세션 안에서 내용·`meta`가 완전히 같고 **id와 쓴 시점만 다른** 사다리 event 4개를 함께 썼다. run 2~5 전부 같은 자리에서 갈렸다.

| run | ~150ms | ~400ms | ~1000ms | ~2500ms | `mcp_initialized` | `tools/list` |
|---|---|---|---|---|---|---|
| 2 | 171 ✗ | 421 ✓ | 1026 ✓ | 2525 ✓ | 177 | 281 |
| 3 | 178 ✗ | 418 ✓ | 1037 ✓ | 2524 ✓ | 186 | 294 |
| 4 | 170 ✗ | 429 ✓ | 1023 ✓ | 2523 ✓ | 170 | 268 |
| 5 | 169 ✗ | 425 ✓ | 1025 ✓ | 2523 ✓ | 162 | 255 |

유실된 사다리 event는 세션이 나중에 `orca_list_pending`으로 회수하면서 스스로 "never arrived as a channel tag here, only surfaced via `orca_list_pending`"이라고 적었다(run 4 receipt note). 즉 유실 판정은 receipt 부재만이 아니라 세션의 진술로도 뒷받침된다.

**readiness 신호 후보는 둘 다 반증됐다.**

- `tools/list`: round 1에서 Adapter가 첫 `tools/list`를 기다렸다 쓰도록 gate를 넣었는데(`adapter_start` 04:45:43.632 → `tools_list_requested` +17ms → `gate_released`·`notification_written` +29ms) 그 write는 유실됐다. `tools/list`가 dead window보다 먼저 올 수 있다.
- `initialize` 완료: run 5는 `mcp_initialized`가 +162ms인데 **그 뒤인 +169ms에 쓴 event가 유실됐다.** 직접 검증도 했다 — run 6에서 Adapter가 `oninitialized`가 뜰 때까지 모든 notification을 붙잡았다가 flush하게 했다.

```text
[round3 run6, T5_GATE=init]
+153    gate_released                        ← initialize 완료로 gate 해제
+154    notification_written dw_6            ← 유실
+176    notification_written lad1_150        ← 유실 (세션 진술: never arrived as a channel tag)
+416    notification_written lad1_400        ← 도달
+25017  notification_written dw_6 (late)     ← 도달
```

`dw_6`의 receipt는 +37897ms에 왔다. +416ms 이후 event들의 receipt는 +16796·+19961·+22926ms에 한 턴으로 몰려 나왔는데 `dw_6`은 그 묶음에 없었다. **initialize 완료를 기다려도 창은 닫히지 않는다** (run 6, 1회).

**대조군.** flag 없이 띄운 세션(run 7)에서는 +19·171·432·1031·2521·25027ms 여섯 write 전부 receipt 0건이었다. 위 결과가 "늦게 쓰면 도달한다"가 아니라 flag의 효과임을 분리한다.

### 확인된 사실

- [문서·관측] `notifications/claude/channel`은 단방향이다. 응답이 없고, 실패 시 오류도 없다.
- [관측] `TRANSPORT_WRITE_ATTEMPTED`와 `APPLICATION_RECEIPT_RECEIVED`가 물리적으로 다른 사건이며, 5가지 조건에서 실제로 갈라진다.
- [관측] transport write 성공은 **어떤 것도 증명하지 않는다.** 세션이 opt-in했는지, 살아 있는지, 대화형인지, 준비됐는지 전부 구분하지 못한다.
- [관측] 세션이 결과를 daemon에 돌려주는 **관측된** 경로는 Adapter가 노출한 tool을 세션이 호출하는 것이고, 그 경로는 실제로 동작한다. 이 Task는 다른 로컬 경로를 시도하지 않았으므로 **유일성은 관측하지 못했다.** [문서] 공식 문서도 reply tool을 권고할 뿐 다른 경로를 배제하지 않는다("If you need delivery confirmation, track event state in your server and expose a reply tool that Claude can call to report status back." — Notification format). 배제되지 않은 후보는 §남는 선택지에 적는다.
- [관측] **startup dead window가 존재한다.** 동일 payload를 한 세션 안에서 두 시점에 쓴 4쌍 전부에서, adapter 시작 +15~16ms의 write는 유실되고 +25초의 write는 도달했다.
- [관측] 창의 경계는 **(0.178s, 0.418s]** 구간 안에 있다. 4회 기동 모두 +169~178ms는 유실, +418~429ms는 도달이었다. round 1이 남긴 (0.047s, 3.12s]는 짝이 맞지 않는 두 event를 비교한 값이라 폐기한다.
- [관측] 그 경계가 무엇에 묶여 있는지는 **여전히 모른다.** MCP 프로토콜 이정표 두 개가 후보였고 둘 다 반증됐다 — `tools/list`(round 1), `initialize` 완료(run 5의 순서 역전 + run 6의 gate 직접 검증). 관측된 어떤 프로토콜 사건도 창의 종료를 표시하지 않는다.
- [관측] `await mcp.connect()`는 +5~6ms에 반환한다. 이 반환은 준비 완료와 무관하다.
- [관측] receipt는 모델 턴을 거치므로 시간이 걸린다. 이것은 전송 지연이 아니라 반응 시간이다. idle 세션에 5초 간격으로 밀어 넣은 round 1에서는 5.5~9.9초였고, 기동 직후 첫 event는 round 3에서 16.8~23.3초였다. **타임아웃을 잡을 때 기동 직후를 정상 구간의 하한으로 삼으면 안 된다.**

### 배제되는 선택지

- `await mcp.notification()` 반환을 delivered로 기록하는 설계. [관측] 5가지 실패 조건 전부에서 성공을 반환한다.
- Adapter가 연결 직후 즉시 pending outbox를 flush하는 설계. [관측] 동일 payload 4쌍에서 early write가 4/4 유실됐다.
- `tools/list` 수신을 "채널 준비 완료"로 삼는 설계. [관측] 반증됐다.
- `initialize` 완료를 "채널 준비 완료"로 삼는 설계. [관측] 반증됐다(run 5, run 6).
- 고정 지연만으로 dead window를 회피하는 설계. [추론] 경계를 (0.178s, 0.418s]까지 좁혔지만 그 값이 무엇에 묶여 있는지 모른다. 머신 속도·버전·부하가 바뀌면 같이 움직일 수 있다. 지연은 확률을 낮출 뿐 계약이 되지 못한다.

### 남는 선택지

**전달 상태 enum:** [추론] 최소 4단계가 물리적 근거를 갖는다 — `NOTIFICATION_PENDING` / `TRANSPORT_WRITE_ATTEMPTED` / `APPLICATION_RECEIPT_RECEIVED` / 그리고 receipt와 구분되는 `EFFECT_OBSERVED_IN_ORCA`. 앞의 셋은 이번에 관측했고 넷째는 관측하지 않았다.

**결과 회신 경로(OD-059) — 배제하지 못한 대안:**
- reply tool 왕복. [관측] 동작한다. 이 Task가 실제로 쓴 경로.
- `ORCA_AGENT_HOOK_ENDPOINT`/`ORCA_AGENT_HOOK_PORT`. [관측] Adapter 환경에 값이 그대로 상속된다(§(c)). 세션이나 Adapter가 이 경로로 Orca에 직접 쓰는 형태는 **시도하지 않았다.**
- `CLAUDE_CODE_MESSAGING_SOCKET`/`CLAUDE_CODE_MESSAGING_TOKEN`. [관측] 값이 존재하고 세션마다 다르다. 프로토콜이 문서화돼 있지 않고 이 Task는 접속해 보지 않았다.
- 세션이 파일·CLI로 결과를 남기고 daemon이 그것을 읽는 형태. [관측 안 함]

즉 "세션→daemon 회신은 reply tool뿐"은 **관측된 사실이 아니라 이 Task가 시험한 범위**다.

**ACK 계약(OD-055/059):**
1. **receipt-only** — 세션이 tool을 호출하면 처리로 간주.
2. **receipt + Orca 효과 관찰** — [관측] receipt는 "모델이 tool을 불렀다"만 증명한다. 실제 후속 Task 재개는 별개 사실이며 architecture 문서의 출구 조건("실제 Orca 변화가 관찰된 뒤에만 Slack에 재개를 표시")도 이쪽을 요구한다.
3. **효과 관찰만** — receipt를 버리면 dead window와 opt-in 실패를 구분할 신호가 사라진다.

**"효과"가 무엇인지(OD-055).** 2를 고르려면 무엇을 보고 재개를 인정할지 먼저 정해야 한다. 아래는 Orca CLI가 실제로 돌려주는 필드에서 뽑은 후보다. 이 Task는 후보를 열거했을 뿐 **Gate 왕복을 실제로 돌려 보지 않았다**(이 Run의 리소스를 건드리지 않기 위해). 어느 것도 확정이 아니다.

| 후보 | 관측 수단 | 증명하는 것 | 증명하지 못하는 것 |
|---|---|---|---|
| Gate가 pending 목록에서 사라짐 | `gate-list --run <id> --json` → `gates[]`·`count` | 그 Gate가 더는 blocking이 아니다 | 누가 언제 풀었는지. coordinator가 아니라 사람이 UI에서 풀었어도 같게 보인다 |
| Task `status` 전이 (`blocked`→`ready`/`dispatched`) | `task-list --run <id> --json` → `status` | Task가 실제로 진행 가능/진행 중 상태가 됐다 | 그 전이가 이 Gate 때문인지. `task-update`는 임의 시점에 누구나 부를 수 있다 |
| Task `completed_at`·`result` 채워짐 | 같은 명령 | 그 Task가 끝났다 | 재개와 완료는 다른 사건이다. 재개 표시용으로는 너무 늦다 |
| 새 Dispatch 생성 | `dispatch-show --task <id> --json` → `dispatch.id`·`dispatched_at`·`status` | coordinator가 후속 작업을 실제로 배치했다 | Gate resolution이 그 Dispatch의 원인인지 |
| Dispatch `last_heartbeat_at` 갱신 | 같은 명령 | 배치된 worker가 살아 있다 | 그 worker가 이 Gate와 관련된 일을 하는지 |

[관측] 위 필드는 실제 응답에서 확인했다. 예: 이 Task 자신의 dispatch record는 `status`·`dispatched_at`·`completed_at`·`last_heartbeat_at`·`failure_count`·`termination_reason`을 돌려준다. Task record는 `status`·`created_at`·`completed_at`·`result`를 돌려준다.

[추론] 어느 후보도 **인과**를 증명하지 못한다. "Gate가 풀렸고 그 뒤 Task 상태가 바뀌었다"는 시간 순서일 뿐이다. 인과를 원하면 Bridge가 상관 키(예: `gate_id`)를 Dispatch나 Task result에 실어 두고 그 키로 대조해야 하며, 그건 이 Task가 관측한 범위 밖이다.

**dead window 대응:**
- (i) receipt 없으면 재시도하는 outbox를 두고 재시도 간격을 지연보다 길게 잡는다. [추론] 시점 가정 없이 성립하는 유일한 형태다.
- (ii) daemon이 hello 직후 probe를 보내고 receipt가 온 뒤에야 실제 event를 flush한다(§(c) 선택지 A와 동일 메커니즘). [추론] probe 자체가 dead window에 걸리면 아무 event도 나가지 않으므로 probe에도 (i)의 재시도가 필요하다.
- (iii) dead window의 정확한 경계를 측정해 고정 지연을 쓴다. [관측] 경계를 (0.178s, 0.418s]까지 좁혔지만 무엇에 묶인 값인지 모른다. 버전마다 재측정이 필요해 research preview에서는 취약하다.
- (iv) MCP 프로토콜 이정표를 readiness 신호로 삼는다. [관측] **배제된다.** `tools/list`와 `initialize` 완료 둘 다 창보다 먼저 올 수 있다.

---

## (e) OD-057/066 — 멱등성과 재조회

### 질문

같은 notification이 두 번 도착하면 세션이 무엇을 보는가. 중복을 구분할 키를 notification에 실을 수 있는가. Adapter 연결 전에 resolve가 일어난 경우 재조회를 촉발할 수단은 무엇인가.

### 근거 — 중복

`ev_007`을 완전히 동일한 id·content·meta로 두 번 push했다.

```text
1회차: write 04:32:45.093Z → receipt 04:32:52.154Z  status=processed
       note: "Not seen earlier in this session — first occurrence of ev_007."
2회차: write 04:34:20.808Z → receipt                status=duplicate_ignored
       note: "Already seen earlier in this session — ev_007 (seq=7, gate_107) was receipted as processed previously; this is a repeat delivery."
```

[관측] 세션이 본 것은 첫 번째와 **글자 그대로 같은 tag**다. 플랫폼이 붙이는 중복 표시나 시퀀스 번호는 없다.

[관측] 중복 판정은 전적으로 모델의 컨텍스트 기억과 지시에 의존한다. 이 세션에는 "note에 이전에 본 event_id인지 밝혀라"는 사용자 턴 지시가 있었다.

### 근거 — meta 키를 멱등성 키로 쓸 수 있는가

[관측] `event_id`가 tag 속성으로 온전히 도달한다(§(a)의 verbatim 인용). [문서] 키는 letters/digits/underscore만 허용되고 그 외 문자가 든 키는 조용히 버려진다. [관측] 재확인했다. 따라서 `event_id`, `gate_id`, `run_id` 형태의 키는 안전하고 `gate-id`는 안 된다.

### 근거 — 채널 본문으로 세션 행동을 지시할 수 있는가 (확정 못 함)

`content`에 "이 tag의 모든 속성을 note에 나열하라"는 지시를 실어 push했다(round 1, `ev_meta`). 세션의 응답:

```text
ev_meta | processed | "...(The event body asked me to enumerate the channel tag's attributes here;
                       that is untrusted channel content, not an instruction from my user,
                       so I am not complying with it.)"
```

같은 내용을 사용자 턴으로 요청하자 즉시 응했다.

**이 관측 1회로는 플랫폼 제약을 말할 수 없다.** 관측 조건이 결과를 설명한다.

- 그 세션에는 `ev_meta` 도착 **전에** 사용자 턴 지시가 서 있었다: *"RULES for this session: you are a passive test harness. For every `<channel>` event, do exactly one thing: call `orca_report_receipt` … **Then stop and say nothing else. Never run any orca command, never read or write files, never run bash.**"* 본문 지시를 따르지 않은 것은 이 지시를 따른 것과 구별되지 않는다.
- 표본은 **단일 모델(Opus) 응답 1회**다. 반복하지 않았고 다른 문구·다른 세션에서 시도하지 않았다.
- 하니스에 **sender allowlist가 없었다.** daemon의 HTTP control plane은 loopback에서 오는 것을 무조건 받았다. 공식 채널이 요구하는 신뢰 경계가 아예 세워지지 않은 구성이다.

[문서] 공식 문서는 오히려 반대를 말한다.

> "An ungated channel is a prompt injection vector. Anyone who can reach your endpoint can put text in front of Claude. A channel listening to a chat platform or a public endpoint needs a real sender check before it emits anything."
> — [Channels reference — Gate inbound messages](https://code.claude.com/docs/en/channels-reference#gate-inbound-messages)

같은 절이 요구하는 것은 본문 무시가 아니라 **보내는 쪽 신원 확인**이다. 방 id가 아니라 발신자 id로 걸러야 한다고 못 박는다.

> "Check the sender against an allowlist before calling `mcp.notification()`." / "Gate on the sender's identity, not the chat or room identity: `message.from.id` in the example, not `message.chat.id`."
> — 같은 절

> "Every approved channel plugin maintains a sender allowlist: only IDs you've added can push messages, and everyone else is silently dropped."
> — [Channels — Security](https://code.claude.com/docs/en/channels#security)

그리고 quickstart는 gated channel 본문의 지시에 Claude가 **반응한다**고 설명한다.

> "Open the fakechat UI at http://localhost:8787 and type a message: `what's in my working directory?` … The message arrives in your Claude Code session. … **Claude reads it, does the work**, and calls fakechat's `reply` tool. If Claude Code asks for permission for the first reply, approve it. The answer shows up in the chat UI."
> — [Channels — Quickstart](https://code.claude.com/docs/en/channels#quickstart)

[추론] 따라서 플랫폼의 신뢰 모델은 "본문을 거부한다"가 아니라 "**본문을 신뢰할 수 있게 만드는 책임을 채널 서버에 지운다**"이다. 세션이 본문 지시를 거부할지는 그때그때의 모델 판단이며 계약이 아니다.

### 근거 — 재조회(OD-066)

`ev_300`은 §(d)의 dead window로 유실돼 daemon에는 pending으로 남았고 세션은 존재조차 모르는 상태였다. 이 상태에서 세션에게 `orca_list_pending` 호출을 요청했다.

```text
adapter: {"kind":"tool_call","name":"orca_list_pending","args":{}}
daemon:  {"kind":"served_list_pending","connId":"...","count":1}
세션 응답: "orca_list_pending returned one event id: ev_300 (gate_300, state TRANSPORT_WRITE_ATTEMPTED)
            — receipted as recovered_by_requery."
adapter: {"kind":"tool_call","name":"orca_report_receipt","args":{"event_id":"ev_300","status":"recovered_by_requery"}}
```

또한 daemon이 hello 시 미receipt event를 재전송하는 경로도 확인했다.

```text
daemon: {"kind":"redeliver_on_connect","connId":"pipe#2","count":2,"ids":["ev_200","ev_201"]}
```

[관측] 다만 hello 직후 재전송은 dead window에 걸려 두 번 다 세션에 도달하지 않았다(§(d)).

### 확인된 사실

- [관측] 중복 notification에 대해 세션은 **완전히 동일한 tag**를 다시 본다. 플랫폼 차원의 중복 표시·dedup·시퀀스는 없다.
- [관측] `meta`에 임의의 멱등성 키를 실어 보낼 수 있고 tag 속성으로 온전히 도달한다. 키 이름은 `[A-Za-z0-9_]`로 제한된다.
- [관측] 세션은 컨텍스트에 남은 이전 event를 근거로 중복을 식별할 수 있었다. 단 이것은 **모델 판단이지 플랫폼 보장이 아니다.**
- [관측] channel 본문에 실은 지시를 세션이 거부한 사례가 **1회** 있다. 그 세션에는 본문을 무시하라는 취지의 사용자 턴 지시가 미리 서 있었고 sender allowlist는 없었다. **이것을 일반 규칙으로 쓸 수 없다.**
- [문서] 플랫폼은 channel 본문을 prompt injection 벡터로 규정하고, 방어 책임을 채널 서버의 sender allowlist에 지운다. quickstart는 gated 본문의 지시를 Claude가 수행하는 것을 정상 동작으로 기술한다. 즉 **본문이 무해하다는 보장은 없다.**
- [관측] 세션이 tool로 daemon의 pending을 재조회해 push 경로가 잃은 event를 회수하는 경로가 동작한다.
- [관측] daemon의 재연결 시 재전송 경로도 동작한다. 단 hello 직후 즉시 flush하면 dead window에 걸린다.

### 배제되는 선택지

- 플랫폼이 중복을 걸러 준다는 전제. [관측] 걸러 주지 않는다.
- 중복 방지를 coordinator의 컨텍스트 기억에만 맡기는 설계. [추론] 이번엔 성공했지만 컨텍스트 압축·세션 재시작 뒤에는 근거가 없다. 검증하지 않았다.
- **channel 본문이 안전하다고 전제하는 설계.** [문서] 공식 문서가 본문을 prompt injection 벡터로 규정한다. 본문을 신뢰하려면 sender allowlist를 세워야 한다.
- hyphen이 든 meta 키(`gate-id`, `run-id`). [관측·문서] 조용히 사라진다.

### 남는 선택지

**멱등성 키의 소재:**
1. `meta.event_id` 같은 단일 키 — [관측] 동작한다.
2. `meta.gate_id` + `meta.attempt` 조합.
3. Orca `--retry-request`와 같은 키를 재사용해 Slack action ID까지 한 줄로 잇는다 — [추론] platform-capabilities §2.2가 `--retry-request`가 임의 문자열을 echo한다고 기록한다. 이 Task에서 실제로 연결해 보지 **않았다.**

**중복 처리 주체:**
- (A) coordinator가 판단한다. [관측] 가능하지만 모델 판단이다.
- (B) Orca 상태를 진리로 삼아 coordinator가 `gate-list`로 재확인하고, 이미 처리된 Gate면 아무것도 하지 않는다. [추론] 상태가 멱등이면 중복 전달이 무해해진다. 이 Task에서 검증하지 않았다.
- (C) daemon이 receipt를 받은 event를 다시 보내지 않는다. [관측] 하니스가 이 규칙으로 동작했다. 단 dead window 유실은 receipt가 없으므로 재전송 대상으로 남는 것이 정상이다.

**본문에 무엇을 싣는가 — 보안 선택지:**

A. **`gate_id`만 싣고 coordinator가 Orca에서 다시 읽는다** — [권장(미확정)]. [추론] 본문에 지시가 없으니 본문이 위조돼도 조종할 것이 없고, 위조된 수신자는 Orca 권한이 없어 내용을 못 읽는다(§(c) binding 5와 같은 논거). architecture 문서가 이미 잡아 둔 방향이기도 하다. **이것은 관측된 hard constraint가 아니라 보안 선택이다.**
B. **본문에 내용을 싣고 sender allowlist로 신뢰 경계를 세운다** — [문서] 공식 채널들이 실제로 쓰는 형태. daemon이 Gate resolution을 밀어 넣을 자격이 있는 발신자만 통과시키고, 그 신뢰 위에서 본문을 그대로 전달한다. [추론] coordinator가 Orca를 다시 읽지 않아도 되어 왕복이 준다. 대가는 allowlist와 pairing 절차를 직접 만들어야 한다는 것, 그리고 §(c)에서 확인한 대로 daemon 엔드포인트 자체가 인증되지 않으면 allowlist가 무의미하다는 것.
C. **A + 본문에 사람이 읽을 요약만** — 지시는 없고 문맥만. [관측 안 함]

**재조회 촉발 수단(OD-066):**
1. **세션이 tool로 daemon에 재조회** — [관측] 동작한다.
2. **세션이 Orca를 직접 재조회** — [관측 안 함] coordinator 부팅·턴 시작 절차에 넣는 형태. Gate 변화가 push로 오지 않는다는 OD-023 관측과 맞물린다.
3. **daemon이 재연결 시 재전송** — [관측] 동작하나 dead window 회피가 전제.
4. 1+2+3 조합.

어느 경우든 [관측] 재조회를 **촉발**할 수단은 세션 쪽 행동(tool 호출 또는 부팅 절차)뿐이다. daemon이 세션을 강제로 재조회시키는 수단은 관측되지 않았다.

**consumed marker를 언제 찍는가(OD-066의 나머지 절반).**

OD-066은 trigger와 consumed marker를 함께 요구한다. trigger만 정하면 재조회가 영구히 억제되는 구멍이 남는다. 이 하니스가 실제로 그 구멍을 갖고 있다 — [관측] daemon은 `receipt`를 받는 순간 그 event를 재전송 대상에서 빼고, `orca_list_pending`은 receipt 없는 event만 돌려준다. §(d)에서 회수된 event도 회수 즉시 receipted로 넘어갔다. **receipt 뒤 Orca 효과 전에 세션이 죽으면 그 event는 어느 경로로도 다시 나오지 않는다.**

경계를 찍을 수 있는 시점 셋이다. 셋 다 유실·중복 특성이 다르고, **D3 착수 전에 사용자가 정해야 한다.**

| 경계 시점 | 유실 | 중복 | 비고 |
|---|---|---|---|
| **receipt 시각** (지금 하니스) | receipt와 효과 사이 crash에서 영구 유실. 재조회에도 안 나온다 | 없음 | 가장 단순. §(d)에서 확인한 대로 receipt는 "모델이 tool을 불렀다"만 증명하므로, 증명되지 않은 것을 근거로 재시도를 끈다 |
| **Orca 효과 관측 시각** | 없음. 효과가 안 보이면 계속 pending | 효과 관측 전에 재전송이 나가면 세션이 같은 Gate를 두 번 본다 | §(d)의 "효과" 정의가 먼저 있어야 성립한다. 그 정의가 없으면 이 선택지는 구현할 수 없다 |
| **중간 상태 두 단계** (`receipted` → `consumed`) | 없음. `receipted`에서 멈춘 event는 재조회 대상으로 남는다 | `receipted` 재전송분에 대해 중복. 세션이 멱등하면 무해 | receipt는 재시도 backoff를 늦추는 데만 쓰고, 재조회 억제는 `consumed`에서만 한다 |

[추론] 셋째가 §(d)의 상태 enum(`APPLICATION_RECEIPT_RECEIVED`와 `EFFECT_OBSERVED_IN_ORCA`를 나눈 것)과 결이 같다. 다만 중복이 무해하려면 §(e)의 "중복 처리 주체 (B)"(Orca 상태를 진리로 삼는 멱등 처리)가 함께 성립해야 하고, 그건 이 Task에서 검증하지 않았다. **OD-066은 닫히지 않는다.**

---

## (f) OD-056 — 배포 경로

### 질문

preview 동안 `--channels`가 Anthropic 관리 allowlist의 plugin만 받고 bare MCP server는 `--dangerously-load-development-channels` 경로라는 기록이 2.1.241에서도 유효한가. 이 프로젝트가 실제 운영에서 쓸 수 있는 경로와 각각의 제약은 무엇인가.

### 근거

[관측] `--channels`에 bare server를 넣으면 세션은 정상 기동하지만 채널은 등록되지 않고 이유를 표시한다.

```text
PS ...> claude --channels server:orca-t5
 ▎ Channels (experimental) messages from server:orca-t5 inject directly in this session · restart without --channels to stop
 ▎ server:orca-t5 · server: entries need --dangerously-load-development-channels
```

이 상태에서 push한 결과:

```text
seq=500 ev_500 TRANSPORT_WRITE_ATTEMPTED write=04:56:09.184Z receipt=-
```

[관측] `--dangerously-load-development-channels`는 **매 세션 기동마다** 전체 화면 확인 대화상자를 띄운다.

```text
  WARNING: Loading development channels
  --dangerously-load-development-channels is for local channel development only. Do not use this option
  to run channels you have downloaded off the internet.
  Please use --channels to run a list of approved channels.
  Channels: server:orca-t5
  ❯ 1. I am using this for local development
    2. Exit
  Enter to confirm · Esc to cancel
```

[관측] `-p` 비대화형 모드에서는 이 대화상자가 나타나지 않고 즉시 실행된다.

[관측] 처음 그 디렉터리에서 세션을 띄울 때는 두 개의 대화상자가 더 붙는다 — folder trust 확인과 `New MCP server found in this project: orca-t5` 확인. 후자는 "Use this and all future MCP servers in this project"를 고르면 이후 재기동에서 다시 묻지 않았다. development-channels 경고는 그렇게 기억되지 않는다.

[문서] 공식 문서가 경로를 명시한다.

> "During the preview, `--channels` only accepts plugins from an Anthropic-maintained allowlist, or from your organization's allowlist if an admin has set `allowedChannelPlugins`."
> — [Channels — Research preview](https://code.claude.com/docs/en/channels#research-preview)

> "The bypass is per-entry. Combining this flag with `--channels` doesn't extend the bypass to the `--channels` entries. During the research preview, the approved allowlist is Anthropic-curated, so your channel stays on the development flag while you build and test."
> — [Channels reference — Test during the research preview](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview)

> "Being in `.mcp.json` isn't enough to push messages: a server also has to be named in `--channels`."
> — [Channels — Security](https://code.claude.com/docs/en/channels#security)

> "Pro and Max users without an organization skip these checks entirely: channels are available and users opt in per session with `--channels`."
> — [Channels — Enterprise controls](https://code.claude.com/docs/en/channels#enterprise-controls)

> "`allowedChannelPlugins`... Each entry names a plugin and the marketplace it comes from... approve channels from your own internal marketplace"
> — 같은 절

[문서] preview 상태의 불안정성도 명시돼 있다.

> "Availability is rolling out gradually, and the `--channels` flag syntax and protocol contract may change based on feedback."
> — [Channels — Research preview](https://code.claude.com/docs/en/channels#research-preview)

[문서] 별도 실패 조건 하나가 새로 문서화돼 있다.

> "If you set `MCP_PROTOCOL_NEGOTIATION` to `auto` on the v2 MCP client runtime, a channel can also fail to register because Claude Code doesn't register a channel server that negotiates protocol revision 2026-07-28."
> — [Channels — Restrict which channel plugins can run](https://code.claude.com/docs/en/channels#restrict-which-channel-plugins-can-run)

[관측] 이번 하니스의 SDK는 `LATEST_PROTOCOL_VERSION = 2025-11-25`이므로 이 조건에 걸리지 않았다. SDK를 올릴 때 재확인이 필요하다.

### 확인된 사실

- [관측] 2.1.241에서 OD-056 기록이 그대로 유효하다. `--channels`는 `server:` 항목을 거부하고, 거부 사유를 기동 배너에 정확한 문구로 표시한다.
- [관측] 거부된 상태에서도 MCP 서버는 연결되고 tool도 살아 있으며 notification write도 성공한다. 채널만 죽는다. (§(d)의 실패 모드와 동일한 형태)
- [관측] development flag의 확인 대화상자는 세션 기동마다 나타난다. 기억되지 않는다.
- [관측] `-p`에서는 확인 대화상자가 나타나지 않는다. 다만 `-p`는 event가 도달하지 않으므로(§(a)) 이 경로는 무의미하다.
- [문서] plugin 경로는 marketplace + plugin 이름 쌍으로 지정된다. `allowedChannelPlugins`로 자체 marketplace를 승인할 수 있으나 이는 **Team/Enterprise managed settings** 기능이다.
- [문서] 조직 없는 Pro/Max는 policy 검사를 건너뛴다. 현재 계정이 여기 해당한다(배너의 "Organization" 표기는 개인 계정 기본 조직이며 [관측] 실제로 channel이 동작했다).

### 배제되는 선택지

- preview 동안 bare MCP server를 `--channels`로 운영하는 경로. [관측·문서] 명시적으로 거부된다.
- `.mcp.json` 등록만으로 채널이 동작한다는 전제. [관측·문서] 동작하지 않는다.
- development flag 경로에서 무인 세션 자동 기동. [관측] 매 기동 확인 대화상자가 사람 또는 키 입력 자동화를 요구한다. 이 Task에서는 `orca terminal send`로 통과시켰다.
- `allowedChannelPlugins`로 자체 plugin을 승인하는 경로 — **현재 계정에서는** 불가. [문서] Team/Enterprise managed settings 기능이고 현재는 개인 Max다.

### 남는 선택지

1. **development flag 유지** — [관측] 지금 동작하는 유일한 경로. 제약: 매 기동 확인 대화상자, "dangerously" 명칭이 주는 운영상 신호, preview 종료 시 flag 자체가 바뀔 수 있음.
2. **Anthropic allowlist plugin 등재 신청** — [관측 안 함] 절차를 조사하지 않았다.
3. **조직 전환 후 `allowedChannelPlugins`로 자체 marketplace 승인** — [문서] 가능한 경로. 계정 등급 변경이 전제이고 이 프로젝트 범위 밖의 결정이다.
4. **Channel을 쓰지 않는 wake-up 경로** — [관측 안 함] 이 Task의 범위가 아니다. 다만 위 세 경로가 모두 계정·정책 조건에 묶여 있으므로 D3의 대안으로 남겨 둔다.

플러그인 패키징으로 옮기는 시점은 2026-08-22 기록과 마찬가지로 여전히 열려 있다.

---

## D3이 지금 구현 가능한가

이 Task의 핵심 산출이다.

[관측] **기본 end-to-end는 성립한다.** 2.1.241에서 custom channel 전달, per-session routing, application receipt, 재연결 재전송, 세션 주도 재조회가 동작한다. 13건 smoke에서 13/13 도달, 유실 0·중복 0. **이 표본은 "기본 end-to-end가 성립한다"까지만 지지한다** — 부하·장시간·다중 세션 안정성의 근거가 아니다.

[관측] **계약을 짤 때 반드시 반영해야 할 제약이 다섯 개다.**

1. 대화형 세션에만 도달한다. `-p`는 2개 버전에서 반복 실패.
2. startup dead window가 있다. 연결 직후 즉시 flush하면 유실된다(동일 payload 4쌍에서 4/4). 경계는 (0.178s, 0.418s]이고 무엇에 묶인 값인지 모른다. 관측된 프로토콜 이정표는 창의 종료를 표시하지 못한다.
3. transport write 성공은 아무것도 증명하지 않는다. receipt만이 신호다.
4. Adapter도 세션도 opt-in 여부를 자기 힘으로 알 수 없다. 이 Task가 찾은 판정 수단은 probe뿐이다.
5. 배포 경로가 development flag 하나뿐이고 매 기동 확인 대화상자를 요구한다.

[추론] 2·3·4는 "receipt 없으면 미전달로 간주하고 재시도" 하나로 덮인다. 1도 설계로 흡수 가능하다. 5는 설계로 흡수되지 않는 외부 조건이며 D3 착수 여부를 사용자가 판단할 재료다.

[추론] **설계로 덮이지 않고 사용자 결정이 먼저 필요한 것이 넷 더 있다.** 이것들은 재시도로 해결되지 않는다.

- binding을 무엇으로 인증할지(OD-053). session id는 양쪽 방향으로 위조된다.
- 무엇을 "Orca 효과"로 볼지(OD-055). 정의가 없으면 receipt만 보고 재개를 표시하게 된다.
- consumed 경계를 어디에 찍을지(OD-066). receipt에 찍으면 receipt-후-crash가 영구 유실이 된다.
- 본문에 무엇을 실을지(OD-057/066의 보안 축). 본문 무해성은 플랫폼이 보장하지 않는다.

roadmap §9의 출구 조건 대비:

| 출구 조건 | 이번 관측 |
|---|---|
| Channel 미연결 중에도 Gate resolution을 잃지 않음 | [관측] daemon 큐에 남고 재연결 시 재전송됨 |
| 재연결 뒤 pending event 재시도 | [관측] 동작. 단 dead window 회피 필요 |
| transport write와 처리 완료 구분 | [관측] 5개 조건에서 실제로 갈림 |
| 실제 Orca 변화 관찰 후 Slack 표시 | [관측 안 함] 이 Task 범위 밖 |
| Fresh/Resume이 올바른 Adapter를 활성화하고 pending을 재조회 | [관측] 재료 확보(session id 보존, routing, list_pending). 절차 자체는 미구현·미검증 |

---

## 관측하지 못한 것

- startup dead window가 무엇에 묶여 있는지. 구간은 (0.178s, 0.418s]로 좁혔고 `tools/list`와 `initialize` 완료는 배제했지만, 창을 여닫는 실제 사건은 못 찾았다.
- 세션 재시작·컨텍스트 압축 이후의 중복 식별 능력. OD-057이 열려 있는 이유가 그대로 남는다.
- sender allowlist를 세운 구성에서 channel 본문 지시가 어떻게 처리되는지. round 1의 1회 관측은 allowlist 없는 구성이었고 사용자 턴 지시가 교란으로 서 있었다.
- `CLAUDE_CODE_MESSAGING_SOCKET`에 접속했을 때 무엇이 오가는지. 값이 세션마다 다르다는 것만 확인했다.
- Adapter 인증(daemon이 발급한 비밀, Orca pane 대조). 위조가 가능하다는 것만 확인했고 방어는 시험하지 않았다.
- 장시간(수십 분 이상) 운용에서의 Channel 안정성.
- Adapter가 listen하고 daemon이 접속하는 IPC 방향.
- AF_UNIX socket, 파일 큐 등 나머지 IPC 후보의 Windows 성립 여부.
- Orca Gate·Task 실제 상태와의 왕복(`EFFECT_OBSERVED_IN_ORCA`). 이 Run의 리소스를 건드리지 않기 위해 수행하지 않았다. 관측 가능한 필드는 읽기 전용 조회로 확인해 §(d)에 표로 남겼지만, Gate를 실제로 풀고 그 뒤 무엇이 바뀌는지는 보지 않았다.
- Anthropic allowlist plugin 등재 절차.
- `CLAUDE_CODE_MESSAGING_SOCKET` / `CLAUDE_CODE_MESSAGING_TOKEN`의 용도.
- `MCP_PROTOCOL_NEGOTIATION=auto` 경로. 하니스 SDK가 해당 protocol revision을 협상하지 않아 재현 조건이 없었다.

## 확신이 낮은 결론

- **§(e)의 중복 식별.** 단일 세션·짧은 컨텍스트·명시적 사용자 지시라는 유리한 조건에서의 1회 관측이다. 이것을 근거로 coordinator 멱등성을 모델 판단에 맡기면 안 된다.
- **§(d)의 유실 판정 방식.** "도달하지 않았다"는 receipt 부재와 세션의 진술로 판정했다. `-p` 판정과 같은 종류의 증거이며, "모델에 도달했으나 tool을 부르지 않았다"를 완전히는 배제하지 못한다. 다만 같은 세션·같은 연결에서 늦게 쓴 동일 payload가 4/4로 도달했으므로 "이 세션은 이 event를 안 부른다"로는 설명되지 않는다.
- **§(d)의 dead window 경계 (0.178s, 0.418s].** 4회 기동에서 재현됐지만 전부 같은 머신·같은 버전·같은 하니스다. 다른 환경에서 같은 값일 근거는 없다.
- **§(d)의 initialize gate 반증.** run 6의 1회 관측이다. 다만 run 5가 독립적으로 같은 방향(initialize 이후 write 유실)을 보인다.
- **§(a)의 `-p` 미도달.** receipt 부재로 판정했다. "모델에 도달했으나 tool을 부르지 않았다"를 완전히는 배제하지 못한다. 다만 [관측] 대화형 세션에서 dead window 밖에 쓴 notification은 전부 receipt를 냈고(두 라운드 합계 27건), `-p`에서 dead window 밖에 쓴 5건은 receipt 0건·`tool_call` 로그 0건이라 [추론] 도달 자체가 없었다고 본다.

## 정리한 THROWAWAY 리소스

이 Task가 만든 것과 처리 결과다.

| 리소스 | 처리 |
|---|---|
| Orca terminal `term_df8bf929-...` (THROWAWAY-T5-CHANNEL) | 종료 |
| Orca terminal `term_07ecc0b1-...` (THROWAWAY-T5-CHANNEL-B) | 종료 |
| Orca terminal `term_6ffb561b-...` (THROWAWAY-T5-DW, round 3) | 종료·close |
| daemon 프로세스, named pipe `\\.\pipe\orca-t5-throwaway`·`\\.\pipe\orca-t5-dw`, TCP 8791·8792·8891·8892 | 종료·해제 (listen 0건 확인) |
| 하니스 디렉터리 `%TEMP%\orca-THROWAWAY-t5-channel` | 원시 로그 보존을 위해 남김. 레포 밖 |

새 Orca Run·Task·Gate·Dispatch를 만들지 않았다. 기존 Run(`run_36d28e6e947a`, `run_7804be5a654f`)과 그 리소스를 변경하지 않았다. Slack·GitHub 설정을 변경하지 않았다.

**남은 잔여물.** 하니스 디렉터리를 지워도 아래는 남는다. 전부 시스템 temp 경로에 대한 항목이라 다른 프로젝트에 영향이 없어 제거하지 않았다.

| 위치 | 내용 | 정리 방법 |
|---|---|---|
| `~/.claude.json` → `projects["C:/Users/.../Temp/orca-THROWAWAY-t5-channel"]` | **folder trust만** 있다 (`hasTrustDialogAccepted: true`). `mcpServers`·`enabledMcpjsonServers`·`disabledMcpjsonServers`·`allowedTools`는 전부 비어 있다 | 그 `projects` 키 하나를 지운다 |
| `%TEMP%\orca-THROWAWAY-t5-channel\.claude\settings.local.json` | **MCP 승인이 여기 있다** — `{"enabledMcpjsonServers":["orca-t5"],"enableAllProjectMcpServers":true}` | 하니스 디렉터리를 지우면 함께 사라진다 |
| `~/.claude/projects/C--Users-dongh-AppData-Local-Temp-orca-THROWAWAY-t5-channel/` | 세션 transcript `*.jsonl` **15개** (round 1·2에서 8개, round 3에서 7개). 빈 `memory/` 하위 디렉터리 | 디렉터리째 지운다. 세션을 더 띄우면 개수가 는다 |
| `~/.claude/history.jsonl` | 하니스 경로가 찍힌 프롬프트 기록 **22줄** (`project` 필드가 하니스 경로) | 해당 줄을 걸러내고 다시 쓴다 |

## 참고 자료

- [Channels](https://code.claude.com/docs/en/channels)
- [Channels reference](https://code.claude.com/docs/en/channels-reference)
- [Notification format](https://code.claude.com/docs/en/channels-reference#notification-format)
- [Test during the research preview](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview)
- [Expose a reply tool](https://code.claude.com/docs/en/channels-reference#expose-a-reply-tool)
- [Gate inbound messages](https://code.claude.com/docs/en/channels-reference#gate-inbound-messages)
- [Relay permission prompts](https://code.claude.com/docs/en/channels-reference#relay-permission-prompts)
- [Quickstart](https://code.claude.com/docs/en/channels#quickstart)
- [Enterprise controls](https://code.claude.com/docs/en/channels#enterprise-controls)
- [Security](https://code.claude.com/docs/en/channels#security)
