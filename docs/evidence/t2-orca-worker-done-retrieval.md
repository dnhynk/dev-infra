# T2 — Orca `worker_done` durable 조회 계약 실측 (OD-075)

관측일: **2026-08-23**
환경: Orca `1.4.187` (`ORCA_APP_VERSION`), Node.js `v26.7.0`, Windows 11, PowerShell 7.6.5
대상 미결정: [OD-075](../open-decisions.md)

이 문서는 OD-075가 남긴 두 blind spot — (1) `task-update --result`의 `worker_report` 덮어쓰기,
(2) `inbox`의 조회 상한과 포화 감지 — 을 닫을 **관측 근거**만 담는다. OD-075를 닫지 않는다.
선택지는 열거하고 결정하지 않는다.

## 표기

문장마다 근거 종류를 앞에 붙인다.

- **[관측]** 이 문서에 적힌 명령을 실제로 실행하고 그 출력에서 직접 읽은 사실.
- **[소스]** Orca 앱 번들(`app.asar`)에서 추출한 실제 구현 코드. 실행 결과가 아니라 코드다.
- **[문서]** `orca agent-context --json` 또는 `orca skills get orchestration --full`이 반환한 계약 서술.
- **[추론]** 위 셋에서 끌어낸 판단. 관측이 아니다.

**[관측]** 아래 모든 실험은 새 Run `run_c940ec042fc1`과 `run_b82acb7fe8c2`(둘 다 objective에
`THROWAWAY` 포함)에서 수행했고, `run_36d28e6e947a`와 `run_7804be5a654f`에는 읽기 명령만 실행했다.
§5에 남은 리소스를 열거한다.

## 실험 하네스

**[관측]** `orca orchestration run-create --from <다른 handle>`은 거부된다. 터미널 identity가 attest되기 때문이다.

```text
$ orca orchestration run-create --objective "..." --from term_2bdfdfe6-... --json
{"ok":false,"error":{"code":"consumer_fenced",
 "message":"This terminal is attested as term_2d44c6e9-... and cannot act as term_2bdfdfe6-...."}}
```

**[관측]** 그래서 Run을 만드는 명령은 그 Run의 coordinator가 될 터미널 **안에서**, `worker_done`은
dispatch 대상 터미널 **안에서** 실행해야 한다. THROWAWAY 실험은 터미널 두 개를 새로 만들어 그 안에서
돌렸다. coordinator terminal이 Run을 소유하고 worker terminal이 `worker_done`을 보낸다.

```powershell
$ORCA = 'C:\Users\dongh\AppData\Local\Programs\orca\resources\bin\orca.exe'
$CO = (& $ORCA terminal create --title 'THROWAWAY-OD075-COORD'  --json | ConvertFrom-Json).result.terminal.handle
$WK = (& $ORCA terminal create --title 'THROWAWAY-OD075-WORKER' --json | ConvertFrom-Json).result.terminal.handle
```

**[관측]** 아래 절차에서 "`$CO` 안에서"는 `orca terminal send --terminal $CO --text '<명령>' --enter`로
그 터미널에 명령을 밀어 넣는다는 뜻이다. 출력은 그 터미널 스크롤백으로만 돌아오므로 `--json`을 파일로
리다이렉트해 받는다. **[추론]** 세 셸(하네스를 돌리는 셸, `$CO`, `$WK`)은 변수를 공유하지 않는다.
`$ORCA`와 위에서 캡처한 handle 값은 각 터미널 안에서 다시 대입해야 한다.
**[관측]** 터미널 안에서 자기 handle은 `$env:ORCA_TERMINAL_HANDLE`이고 생성 시 받은 handle과 같다.
**[관측]** 이 터미널들은 §5 기준으로 모두 닫았고, 실험을 돌린 worker 세션의 터미널은 실험 전후 모두
`run-current` → `{"run":null}`로 Run에 바인딩되지 않았다.

**[관측]** Windows에서 `orca.cmd`는 `orchestration send`와 `reply`를 거부하므로
(`orca.cmd cannot safely forward orchestration message bodies`) 실험은
`C:\Users\dongh\AppData\Local\Programs\orca\resources\bin\orca.exe`를 직접 호출했다.

---

## (a) `task-update --result`가 `worker_report`를 덮어쓰는가

### [가설]

`orca orchestration task-update --id <task> --status completed --result <json>`은 `tasks.result` 컬럼을
필드 병합 없이 **통째로 대체**한다. 그래서 `worker_done`이 자동으로 기록한 `worker_report`는 남지 않는다.

### [반증 관측]

`worker_done`을 기록한 Task에 `task-update --result <reviewer_result>`를 적용한 뒤 `task-list --json`의
`result`에 `worker_report` 필드(`provenance`, `messageId`, `body`, `filesModified` 등)가 **하나라도** 남아
있으면 가설은 반증된다.

### [실행 명령]

§실험 하네스가 `$CO`·`$WK` handle을 잡아 놓았다고 본다. Run·Task·Dispatch ID는 하드코딩하지 않고
그 자리에서 캡처한다.

```powershell
# 1. $CO 안에서. 먼저 $ORCA와 $WK를 이 터미널에 대입한 뒤,
#    아래 세 줄을 이 한 세션에서 이어 실행한다($RUN/$TASK가 유지돼야 한다).
$RUN  = (& $ORCA orchestration run-create --objective 'THROWAWAY OD-075 worker_done retrieval probe (dev-infra T2). Safe to delete.' --json | ConvertFrom-Json).result.run.id
$TASK = (& $ORCA orchestration task-create --spec 'THROWAWAY task for OD-075 probe. No real work.' --task-title 'THROWAWAY OD-075 probe' --run $RUN --json | ConvertFrom-Json).result.task.id
$CTX  = (& $ORCA orchestration dispatch --task $TASK --to $WK --run $RUN --return-preamble --json | ConvertFrom-Json).result.dispatch.id

# 2. $WK 안에서 worker_done. $ORCA와 1이 찍은 $TASK/$CTX를 이 터미널에 옮겨 적는다.
#    이 dispatch의 preamble에는 dcap 토큰이 없다. attest된 --from만으로 보낸다.
& $ORCA orchestration send --from $env:ORCA_TERMINAL_HANDLE `
  --type worker_done --subject 'THROWAWAY-WD-SUBJECT-MARKER' `
  --body 'THROWAWAY-WD-BODY-MARKER 첫째 문장. 둘째 문장. 셋째 문장.' `
  --task-id $TASK --dispatch-id $CTX --outcome succeeded `
  --files-modified 'docs/evidence/x.md,docs/evidence/y.md' `
  --report-path 'docs/evidence/throwaway.md' --json

# 3. 덮어쓰기 전 조회. 권한이 필요 없어 아무 터미널에서나 된다.
& $ORCA orchestration task-list --run $RUN --json

# 4. $CO 안에서 OD-073 절차대로 reviewer_result 기록
& $ORCA orchestration task-update --id $TASK --status completed `
  --result '{"kind":"reviewer_result","schemaVersion":1,"verdict":"approve","pr":{"repo":"THROWAWAY/none","number":1},"reviewedHeadSha":"deadbeef","findings":[],"gates":{"docs":"pass"}}' `
  --run $RUN --json

# 5. 덮어쓰기 후 조회
& $ORCA orchestration task-list --run $RUN --json
& $ORCA orchestration dispatch-show --task $TASK --json
```

### [출력 발췌]

**[관측]** 2단계 응답. `worker_done` 한 건이 Task와 Dispatch를 자동으로 completed로 만든다.

```json
{"message":{"id":"msg_a5080d33049b","run_id":"run_c940ec042fc1",
  "to_handle":"run:run_c940ec042fc1","type":"worker_done","sequence":122,
  "payload":"{\"taskId\":\"task_a027eb19b0e2\",\"dispatchId\":\"ctx_95ba7239bbaa\",\"outcome\":\"succeeded\",\"filesModified\":[\"docs/evidence/x.md\",\"docs/evidence/y.md\"],\"reportPath\":\"docs/evidence/throwaway.md\"}"},
 "lifecycle":{"action":"completed","taskId":"task_a027eb19b0e2","dispatchId":"ctx_95ba7239bbaa"}}
```

**[관측]** 3단계 — 덮어쓰기 **전** `task.result`:

```json
{"provenance":"worker_report","outcome":"succeeded","messageId":"msg_a5080d33049b",
 "reportedBy":"term_2058bfe6-3eb7-4713-a620-f171f64eee66",
 "subject":"THROWAWAY-WD-SUBJECT-MARKER",
 "body":"THROWAWAY-WD-BODY-MARKER 첫째 문장. 둘째 문장. 셋째 문장.",
 "completedBy":"term_2058bfe6-3eb7-4713-a620-f171f64eee66",
 "filesModified":["docs/evidence/x.md","docs/evidence/y.md"],
 "reportPath":"docs/evidence/throwaway.md",
 "completedAt":"2026-08-23T04:29:13.372Z"}
```

`completed_at` = `2026-08-23 04:29:13`.

**[관측]** 5단계 — 덮어쓰기 **후** `task.result`:

```json
{"kind":"reviewer_result","schemaVersion":1,"verdict":"approve",
 "pr":{"repo":"THROWAWAY/none","number":1},"reviewedHeadSha":"deadbeef",
 "findings":[],"gates":{"docs":"pass"}}
```

`completed_at` = `2026-08-23T04:30:54.858Z`, `status` = `completed`.

### [재현]

**[관측]** 위 절차를 새 THROWAWAY Run에서 처음부터 한 번 더 실행해 재현을 확인했다.
`run_b82acb7fe8c2` / `task_33a60121fe62` / `ctx_8b5bbcee31c7` / `msg_24e91fbd2df6`(sequence 273).
같은 Orca `1.4.187`.

```text
3단계 task.result  = worker_report 10개 필드 전부. completed_at = 2026-08-23 05:10:09
5단계 task.result  = {"kind":"reviewer_result",...} 한 개. worker_report 필드 0개
     completed_at = 2026-08-23T05:10:51.066Z
dispatch-show      = dispatch.completed_at 2026-08-23 05:10:09 (덮이지 않음)
```

### [결론]

**[관측]** 반증에 실패했다. 가설이 확인된다. `task.result`는 통째로 대체되며 `worker_report`의
**10개 필드 전부**가 소실된다.

| 소실 | 남음 |
|---|---|
| `provenance`, `outcome`, `messageId`, `reportedBy`, `subject`, `body`, `completedBy`, `filesModified`, `reportPath`, `completedAt` | `tasks` 행의 `id`, `run_id`, `task_title`, `display_name`, `spec`, `status`, `deps`, `created_at` |

**[관측]** OD-075가 적지 않은 추가 소실이 하나 있다. `tasks.completed_at`이 worker 완료 시각
(`04:29:13`)에서 `task-update` 실행 시각(`04:30:54.858Z`)으로 덮인다. 두 시각의 형식도 다르다
(`YYYY-MM-DD HH:MM:SS` → ISO8601 with ms). **[추론]** `task.result`만 복원해도 worker 완료 시각은
Task 행에서 돌아오지 않는다.

**[관측]** 이것은 이론적 위험이 아니라 이미 일어난 일이다. 실제 Run `run_7804be5a654f`의 Task 38건 중
**15건**의 `task.result`가 `kind: reviewer_result`이고 `worker_report` 형태는 23건만 남아 있다.

```bash
orca orchestration task-list --run run_7804be5a654f --json
# result shapes: {"worker_report":23,"reviewer_result":15}
```

**[관측]** 그 15건 전부(15/15)는 `worker_done` 원본 메시지가 Run mailbox에 아직 남아 있어 §(c)의
`inbox --terminal run:<id>`로 복원 가능하다. **[추론]** 즉 현재 시점에서 소실된 것은 `task.result`
경로뿐이고 사실 자체는 아직 어디에도 남아 있다.

### [남는 선택지]

1. **coordinator가 `reviewer_result`를 `worker_report`와 합쳐서 기록한다.** `task-update --result`에
   `{"provenance":"worker_report", ..., "reviewerResult":{...}}` 형태로 두 사실을 한 JSON에 넣는다.
   **[추론]** Orca 변경이 필요 없다. **[관측]** 단 `worker_report`를 만드는 주체는 Orca이고 coordinator는
   그것을 읽어 다시 써야 하므로, 읽기 시점과 쓰기 시점 사이의 read-modify-write 창이 생긴다.
2. **`reviewer_result`를 Task가 아닌 다른 곳에 기록한다.** 예를 들어 review Task를 별도 Task로 두고
   그 Task의 `worker_report`(reviewer 자신의 `worker_done` 본문)를 권위 있는 사본으로 쓴다.
   **[관측]** OD-073이 이미 reviewer가 자기 `worker_done` 본문에 `reviewer_result` JSON을 싣도록
   확정했으므로 그 사본은 이미 존재한다.
3. **Bridge가 `task.result`를 권위로 쓰지 않는다.** `worker_done`은 §(c)의 Run mailbox 조회에서,
   `reviewer_result`는 `task.result`에서 각각 읽는다.
4. **Bridge가 자기 durable store에 복사한다.** §(d).

**[관측]** 이 문서는 어느 선택지도 검증하지 않았다. 넷 다 실행하지 않음.

---

## (b) `inbox --limit`에 조용한 clamp가 있는가

### [가설]

Orca CLI가 `--limit`을 요청값보다 낮은 값으로 조용히 clamp한다. 그러면 C1의 포화 판정
(`반환 행 수 >= 요청 상한`, `orca/client.ts`)이 항상 거짓이 되어 잘린 목록을 "전부"로 오인한다.

### [반증 관측]

전체 행 수 `T`를 먼저 확정한 뒤, `L < T`인 여러 `L`에 대해 반환 행 수가 **정확히 `L`**이면 그 `L`까지는
clamp가 없다. 어떤 `L`에서 반환 행 수가 `L`보다 작아지고 그 값이 `T`보다도 작으면 그 값이 clamp다.
C1 실측은 `T = 55`인 상태에서 했으므로 50·100 이상의 clamp를 배제하지 못했다.

### [실행 명령]

```bash
# T 확정
orca orchestration inbox --limit 100000 --json     # 관측 시작 시 T = 114

# sweep
for L in 1 2 3 19 20 21 49 50 51 99 100 101 113 114 115 200 500 1000 5000 100000; do
  orca orchestration inbox --limit $L --json | jq '.result.messages | length'
done

# 경계값
orca orchestration inbox --json                    # --limit 생략
orca orchestration inbox --limit 9007199254740991 --json
for L in 0 -5 10.7 abc; do
  orca orchestration inbox --limit "$L" --json; echo "exit=$?"
done

# 대조군: 상한이 실제로 있는 명령
orca orchestration run-list --limit 100 --json
orca orchestration run-list --limit 101 --json
```

### [출력 발췌]

**[관측]** sweep 결과. 실행 중 다른 세션이 메시지를 보내 `T`가 114 → 118로 늘었다.

```text
--limit 1   -> 1      --limit 100 -> 100
--limit 2   -> 2      --limit 101 -> 101
--limit 3   -> 3      --limit 113 -> 113
--limit 19  -> 19     --limit 114 -> 114
--limit 20  -> 20     --limit 115 -> 115
--limit 21  -> 21     --limit 200 -> 118   ← T에 닿음
--limit 49  -> 49     --limit 500 -> 118
--limit 50  -> 50     --limit 1000 -> 118
--limit 51  -> 51     --limit 5000 -> 118
--limit 99  -> 99     --limit 100000 -> 118
```

**[관측]** 경계값.

```text
--limit 생략              -> 20 행
--limit 9007199254740991  -> 132 행 (그 시점 T 전부). 오류 없음
```

**[관측]** 양의 정수가 아닌 `--limit`은 **CLI가 거절한다.** 조회가 일어나지 않고 exit code는 1이다.

```text
$ orca orchestration inbox --limit 0 --json      # -5, 10.7도 같다
{"id":"local","ok":false,
 "error":{"code":"invalid_argument","message":"Invalid positive integer for --limit"}}
exit=1

$ orca orchestration inbox --limit abc --json
{"id":"local","ok":false,
 "error":{"code":"invalid_argument","message":"Invalid numeric value for --limit"}}
exit=1
```

**[소스]** CLI 인자 단계에서 걸린다. IPC까지 가지 않는다.

```js
// app.asar.unpacked/out/cli/handlers/orchestration.js:528
'orchestration inbox': async ({ flags, client, json }) => {
  const result = await client.call('orchestration.inbox', {
    limit: getOptionalPositiveIntegerFlag(flags, 'limit'), ...

// app.asar.unpacked/out/cli/flags.js:39-59
function getOptionalNumberFlag(flags, name) {
  const value = flags.get(name);
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new RuntimeClientError('invalid_argument', `Invalid numeric value for --${name}`);
  return parsed;
}
function getOptionalPositiveIntegerFlag(flags, name) {
  const value = getOptionalNumberFlag(flags, name);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) throw new RuntimeClientError('invalid_argument', `Invalid positive integer for --${name}`);
  return value;
}
```

**[관측]** 대조군. Orca에 상한이 **있는** 명령은 조용히 자르지 않고 거절한다.

```text
run-list --limit 100 -> runs=8
run-list --limit 101 -> {"ok":false,"error":{"code":"invalid_argument","message":"Invalid input"}}
```

**[소스]** 실제 구현. `app.asar`에서 추출했다.

```bash
cd "C:/Users/dongh/AppData/Local/Programs/orca/resources"
grep -a -o -b "function getInbox(" app.asar          # -> offset 4540949
dd if=app.asar bs=1 skip=4540700 count=1000 | tr -d '\0'
grep -a -o -b "InboxParams = " app.asar              # -> offset 4913850
```

```js
var InboxParams = require_schemas.object({
	limit: OptionalFiniteNumber,
	terminal: OptionalString
});

// orchestration.inbox handler
const messages = params.terminal
  ? db.getAllMessagesForHandle(params.terminal, params.limit)
  : db.getInbox(params.limit);

function getInbox(limit = 20) {
	return exposeMessageListTimestamps(
		this.db.prepare("SELECT * FROM messages ORDER BY sequence DESC LIMIT ?").all(limit));
}
function getAllMessagesForHandle(toHandle, limit = 100, types) { /* ... ORDER BY sequence DESC LIMIT ? */ }
```

**[소스]** 비교 대상. 같은 파일에서 상한이 있는 구현은 다음처럼 보인다.

```js
function listRuns(params = {}) {
	if (params.limit === void 0 && params.cursor === void 0) return { runs: <전부>, nextCursor: null };
	const limit = Math.min(Math.max(1, params.limit ?? 100), 100);
	// 그리고 params 스키마가 101 이상을 invalid_argument로 거절한다
}
function getLegacyMailHistory(params) {
	const limit = Math.min(Math.max(params.limit ?? 100, 1), 100);
}
```

### [결론]

**[관측]** 반증에 성공했다. 가설은 기각된다. `--limit L`은 `min(L, T)`행을 정확히 반환한다.
관측 범위(`L` = 1…9007199254740991, `T` = 114…132)에서 clamp는 없다.

**[소스]** `getInbox`는 `--limit` 값을 SQL `LIMIT ?`에 그대로 넘긴다. `Math.min`도 스키마 max도 없다.
**[추론]** 따라서 관측한 `T` 범위를 넘어서도 clamp는 없다. 이 추론의 근거는 실행이 아니라 코드다.
`T > 5000`인 상태는 만들지 않았다 — 전역 `inbox`에 5000행 이상을 쌓으면 되돌릴 수 없고 다른 Run의
운영 조회를 오염시키므로 하지 않았다.

**[관측]** 따라서 C1의 포화 판정 `rows.length >= limit`은 **양의 정수 `--limit`에 대해서는 건전하다.**
OD-075가 걱정한 clamp 경로로 포화를 놓치지는 않는다.

**[관측]** 다만 두 가지 사실이 새로 드러났고 C1 주석과 다르다.

1. `--limit`을 생략하면 **20행**이다. `--terminal`을 함께 주면 생략 시 100행이다(**[소스]**).
   `orca/client.ts`는 항상 `--limit`을 명시하므로 지금 영향은 없다.
2. `--limit`에 0·음수·소수·비숫자를 주면 CLI가 `invalid_argument`로 거절하고 exit 1로 끝난다.
   조회 결과가 아니라 실패다. **[추론]** `OrcaCli.run`은 `execFile`을 쓰므로 비영 exit code에서
   reject한다(`orca/client.ts:22`). 잘못 계산된 `--limit`은 포화식까지 가지 못하고 던져지며,
   "메시지 없음"으로 조용히 둔갑하지 않는다. 이 경로는 실행해 보지 않았다.

### [남는 선택지]

1. **상한만 올린다.** clamp가 없으므로 `INBOX_LIMIT`을 더 올리는 것은 유효하다. **[관측]** 다만
   전역 조회라는 성질과 pagination 부재는 그대로 남고, 행 수에 비례한 출력 비용이 든다
   (`orca/client.ts`가 기록한 C1 실측 행당 평균 1.8KB, 이번 관측에서는 114행 216,220바이트).
2. **Run 범위 조회로 바꾼다.** §(c)의 `inbox --terminal run:<run_id>`. **[관측]** 같은 unclamped
   `--limit`을 쓰면서 다른 Run의 메시지가 상한을 잡아먹지 않는다.
3. **포화식을 유지하되 `--limit` 입력을 Bridge에서도 검증한다.** **[관측]** CLI가 이미 양의 정수가
   아닌 값을 거절하므로 이 선택지는 안전성이 아니라 오류 메시지 위치의 문제다.

---

## (c) Run 범위에서 `worker_done`을 완전하게 조회할 다른 source가 있는가

### [가설]

`inbox` 외에 Run 범위로 원래 `worker_done` payload를 돌려주는 명령이 있다.

### [반증 관측]

후보 명령을 THROWAWAY Dispatch(`ctx_95ba7239bbaa`, `worker_done` = `msg_a5080d33049b`)와
실제 settled Dispatch에 각각 실행해 응답 JSON에 `subject`/`body`/`payload`가 있는지 본다.
없으면 그 명령은 source가 아니다.

### [실행 명령과 출력 발췌]

**[문서]** `orca agent-context --json`이 반환한 orchestration 명령 29개 중 조회 성격인 것 전부를 실행했다.

#### `task-list --run <run> --json`

**[관측]** `task.result`에 `worker_report`가 들어 있다. 단 (a)에서 확인한 대로 `task-update --result`가
지나가면 사라진다. **결론: 부분 source. 덮어쓰기에 취약하다.**

#### `dispatch-show --task <task> --json`

**[관측]** report 본문 없음. Dispatch 행만 온다.

```json
{"dispatch":{"id":"ctx_95ba7239bbaa","task_id":"task_a027eb19b0e2","status":"completed",
  "capability_revoked_at":"2026-08-23 04:29:13","completed_at":"2026-08-23 04:29:13"}}
```

**[관측]** 유용한 부산물이 하나 있다. `dispatch.completed_at` = `04:29:13`은 (a)의 `task-update`가
`tasks.completed_at`을 `04:30:54`로 덮은 **뒤에도 그대로였다**. **[추론]** worker 완료 시각은
Dispatch 행에서 복원할 수 있다. **결론: report source 아님. 완료 시각 source로는 유효.**

#### `worker-show --dispatch <ctx> --json`

**[관측]** report 본문 없음. `dispatch` + `worker`(`state`, `stage`, `agent_terminal_handle`) +
`terminal`(스크롤백 `preview` 몇 백 자) + `observation`만 온다. `preview`는 마지막 화면 조각이지
보고가 아니다. **결론: source 아님.**

#### `worker-read --dispatch <ctx> --json`

**[관측]** THROWAWAY Dispatch(터미널 살아 있음)에서는 `source: "terminal"`로 **터미널 원시
스크롤백**이 온다. 구조화된 `worker_done`이 아니라 셸에 친 명령줄 문자열이다.

**[관측]** 실제 settled Dispatch(`ctx_2c48da683b74`, 터미널 exited)에서는 아무것도 오지 않는다.

```json
{"dispatchId":"ctx_2c48da683b74","source":"terminal",
 "terminal":{"status":"exited","tail":[],"returnedLineCount":0},
 "status":{"worker":"succeeded","terminal":"exited","liveness":"exited"},
 "fallbackReason":"session_not_reported"}
```

```json
// --source transcript 강제
{"ok":false,"error":{"code":"transcript_required",
 "message":"Structured output is unavailable for Dispatch ctx_2c48da683b74: session_not_reported.",
 "data":{"reason":"session_not_reported"}}}
```

**[관측]** `--cursor` pagination은 있지만 반환하는 것이 원시 텍스트다. **결론: source 아님.
settled + exited Dispatch에서는 빈 결과다.**

#### `check --run <run> --peek --types worker_done --json`

**[관측]** THROWAWAY Run에서는 `msg_a5080d33049b` 전체(`body` + `payload`)가 온다.

**[소스]** 그러나 `--peek`은 `read = 0 AND delivery_contract = 'current_delivery'`만 본다
(`getUnreadRunMailbox`). **[관측]** 실제 Run `run_7804be5a654f`의 `worker_done` 38건 중 37건이
`read = 1`이다. **[추론]** coordinator가 Delivery를 ack한 뒤에는 `--peek`이 사실상 빈 결과다.
**결론: source 아님. 이미 처리된 보고는 보이지 않는다.**

#### `check --run <run> --all --types worker_done --json`

**[관측]** Run 범위 + type 필터 + 전체 `body`/`payload`가 온다. 소비하지 않는다
(`read: 0`, `delivered_at: null` 그대로).

```json
{"messages":[{"id":"msg_a5080d33049b","run_id":"run_c940ec042fc1",
  "to_handle":"run:run_c940ec042fc1","subject":"THROWAWAY-WD-SUBJECT-MARKER",
  "body":"THROWAWAY-WD-BODY-MARKER 첫째 문장. 둘째 문장. 셋째 문장.","type":"worker_done",
  "payload":"{\"taskId\":\"task_a027eb19b0e2\"}","read":0,"delivered_at":null,"sequence":122}],
 "count":1,"acknowledged":null,"runId":"run_c940ec042fc1"}
```

**[관측]** 그런데 Run의 **현재 consumer(coordinator)만** 쓸 수 있다. 다른 터미널에서 같은 명령을
같은 THROWAWAY Run에 실행하면 거부된다.

```json
{"ok":false,"error":{"code":"consumer_fenced",
 "message":"This coordinator terminal is no longer bound to Run run_c940ec042fc1."}}
```

**[관측]** 거부 후 `run-show`로 확인했을 때 `coordinator_handle`과 `consumer_generation: 1`은
바뀌지 않았다. **[추론]** 이 거부는 소유권을 빼앗지 않는다.

**[소스]** 반환 행 수는 **100으로 고정**이다. 호출자가 올릴 수 없고 cursor도 없다.

```js
if (params.all || params.unread === false && !params.peek) {
	const messages = db.getRunMailboxHistory(run.id, 100, typeFilter);   // 100이 하드코딩
}
function getRunMailboxHistory(runId, limit = 100, types) {
	const address = `run:${runId}`;
	const rowLimit = Math.max(1, Math.floor(limit));
	// SELECT * FROM messages WHERE run_id = ? AND to_handle = ? AND type IN (...) ORDER BY sequence DESC LIMIT ?
}
```

**결론: Run 범위 source이긴 하나 Bridge는 쓸 수 없다.** coordinator 권한이 필요하고 100행에서 잘리며
그 잘림을 감지할 수단이 없다.

#### `inbox --terminal "run:<run_id>" --limit <n> --json` ← **찾은 것**

**[관측]** Run mailbox를 그대로 돌려준다. 권한이 필요 없고(Run에 바인딩되지 않은 이 worker
터미널에서 성공), 소비하지 않는다. **[관측]** 아래 측정 범위(`L` = 3…5000, `T` = 97)에서 clamp는 없다.

```bash
orca orchestration inbox --terminal "run:run_7804be5a654f" --limit 5000 --json
# rows: 97, count: 97, byRun: {"run_7804be5a654f":97}
# byType: {"worker_done":38,"heartbeat":52,"question":7}
```

```text
--limit 생략 -> 97      --limit 96 -> 96
--limit 3   -> 3        --limit 97 -> 97
                        --limit 98 -> 97   ← T에 닿음
```

**[관측]** 두 번 연속 호출해 같은 행의 `read=0`, `delivered_at=null`, `sequence=122`가 바뀌지 않았다.

**[소스]** 구현은 `to_handle = ?` 정확 일치다. `run:<run_id>`는 Run마다 유일하므로 Run 필터와 같다.

**[관측]** 이 주소로 오는 것이 `worker_done` 전부인지 확인했다. 이 호스트 전역 `inbox` 118행 기준으로
`worker_done` 39건 **전부**의 `to_handle`이 `run:*`이다. `dispatch:<ctx>` 주소로 온 13건은 모두
`status`(coordinator → worker 지시)다.

**[소스]** 이것은 우연이 아니라 강제된다. `orchestration.send` 핸들러가 `worker_done`과 `heartbeat`의
수신자를 Run mailbox로 덮어쓴다.

```js
if (routing.run && (!to || (params.type === "worker_done" || params.type === "heartbeat") && routing.dispatchId))
	to = `run:${routing.run.id}`;
```

**결론: Run 범위에서 `worker_done`을 완전하게 조회하는 source다.**

#### `worker-list --run <run> --json`

**[관측]** report 본문은 없지만 Run 전체의 Dispatch↔Task↔결과 매핑이 온다. 권한이 필요 없다
(이 worker 터미널에서 `run_7804be5a654f`에 대해 40건 반환).

```json
{"dispatchId":"ctx_2c48da683b74","taskId":"task_56972eaff901","runId":"run_7804be5a654f",
 "workerState":"succeeded","dispatchStatus":"completed","terminalState":"retained"}
```

**[관측]** 40행이 반환됐고 상한을 특정할 만큼 행이 많지 않아 상한 유무는 **관측하지 못했다.**
**결론: outcome source. report 본문 source 아님.**

#### `run-show --id <run> --json`

**[관측]** Run 행 하나뿐이다(`id`, `objective`, `coordinator_handle`, `coordinator_pane_key`,
`consumer_generation`, `legacy`, 시각). Task도 message도 없다. **결론: source 아님.**

### [결론]

| 명령 | Run 범위 | 권한 필요 | 원래 `worker_done` payload | 상한 | 소비 |
|---|---|---|---|---|---|
| `task-list --run` | O | 없음 | `task.result`가 `worker_report`일 때만. `task-update`가 지우면 없음 | 관측 못 함 | 안 함 |
| `dispatch-show --task` | O | 없음 | 없음 (완료 시각만) | 1건 | 안 함 |
| `worker-show --dispatch` | O | 없음 | 없음 | 1건 | 안 함 |
| `worker-read --dispatch` | O | 없음 | 없음. 원시 텍스트. exited면 빈 결과 | cursor 있음 | 안 함 |
| `check --run --peek` | O | **coordinator** | unread만 (실제 Run에서 37/38이 read) | 100 고정 | 안 함 |
| `check --run --all` | O | **coordinator** | **있음** | **100 고정, cursor 없음** | 안 함 |
| `inbox --terminal run:<id>` | O | 없음 | **있음** | 측정 범위(L≤5000, T=97)에서 없음 | 안 함 |
| `inbox` (전역) | X | 없음 | 있음 | 측정 범위(T=114…132)에서 없음 | 안 함 |
| `worker-list --run` | O | 없음 | 없음 (`workerState`만) | 관측 못 함 | 안 함 |
| `run-show --id` | O | 없음 | 없음 | — | 안 함 |

**[관측]** 가설은 확인된다. `inbox --terminal "run:<run_id>"`가 Run 범위·무권한·비소비 조회다.
**[추론]** 상한은 **없다.** 근거는 실행이 아니라 코드다 — `getAllMessagesForHandle`이 `--limit`을
SQL `LIMIT ?`에 그대로 넘기고 `Math.min`도 스키마 max도 없다(**[소스]**). 실제로 측정한 범위는
`L` = 3…5000, `T` = 97뿐이며 `T > 5000`인 Run mailbox는 만들지 않았다. 저확신으로 둔다.
**[관측]** OD-075가 적은 "`inbox`에 `--run` 필터가 없다"는 서술은 `--run` 플래그에 대해서는
맞지만, `--terminal`에 Run mailbox 주소를 넣으면 같은 효과를 얻는다는 사실을 빠뜨리고 있다.

**[관측]** pagination은 어느 조회에도 없다. `inbox`에는 cursor 파라미터 자체가 없고
(**[문서]** `inbox [--limit <n>] [--terminal <handle>] [--full] [--json]`), `check --run --all`은 100행에서
고정된다. cursor가 있는 orchestration 조회는 `run-list --cursor`와 `worker-read --cursor` 둘뿐이며
둘 다 `worker_done` 본문을 돌려주지 않는다.

### [남는 선택지]

1. **`listWorkerDone`을 Run별 호출로 바꾼다.** **[관측]** Bridge는 이미 `run-list --json`(상한·cursor 없이
   전체 Run)과 `task-list --run <id>`를 Run마다 부르고 있으므로(`snapshot.ts`의 `collectRuns`),
   `inbox --terminal run:<id>`를 같은 루프에 넣으면 Run당 CLI 호출 1회가 는다. 이 호스트 실측으로
   Run은 8개다. **[관측]** 포화 판정은 그대로 `rows.length >= limit`이고 clamp가 없으므로 건전하다.
2. **전역 `inbox`를 유지하고 상한만 올린다.** **[관측]** clamp가 없으므로 유효하다. 다른 Run의
   메시지가 상한을 잡아먹는 성질은 남는다.
3. **`check --run --all`을 쓴다.** **[관측]** Bridge가 coordinator 터미널이 아니면 `consumer_fenced`다.
   coordinator 안에서 돌리면 100행 상한이 남고 잘림을 감지할 수단이 없다. **[추론]** 두 제약 모두
   Bridge 요구와 맞지 않는다.
4. **`worker-list --run`으로 outcome만 쓰고 본문은 포기한다.** **[관측]** 카드에 보고 본문을 넣는
   OD-070과 충돌한다.

---

## (d) Bridge durable store 복사 방식이 성립하는가

### [가설]

Orca가 충분한 조회를 제공하지 않으면, Bridge가 관측 시점에 `worker_done`을 자기 durable store에
복사해 두는 것으로 대체할 수 있다.

### [반증 관측]

복사 방식이 요구하는 polling 주기를 Bridge의 현재 실행 모델에서 만족할 수 있는지, 그리고 복사가
닫지 못하는 유실 창이 무엇인지를 코드에서 확인한다. 유실 창이 원래 문제(오래된 `worker_done`을
못 봄)와 같은 성질이면 복사는 문제를 옮길 뿐이다.

### [실행 명령]

```bash
sed -n '1,80p'    apps/orca-slack-bridge/src/store/schema.ts
sed -n '1,60p'    apps/orca-slack-bridge/src/orca/client.ts
sed -n '145,190p' apps/orca-slack-bridge/src/digest/digest.ts
sed -n '40,75p'   apps/orca-slack-bridge/src/snapshot/snapshot.ts
```

### [출력 발췌]

**[관측]** 관측은 1회성 실행이다. 상주 프로세스도 polling 루프도 없다.

```ts
// digest/digest.ts:155
// 관찰 1회에 inbox도 1회만 읽는다. 포화 판정은 `pickWorkerReport`가 한다.
const inbox = await listWorkerDone(orca);
```

**[관측]** store는 `node:sqlite`이고 테이블이 `schema_version`과 `pr_message` 둘뿐이다.
마이그레이션은 배열 하나이며 **덧붙이기만** 허용한다.

```ts
export const SCHEMA_VERSION = 2;
export const MIGRATIONS: readonly (readonly string[])[] = [
  ['ALTER TABLE pr_message ADD COLUMN facts_fingerprint TEXT',
   'ALTER TABLE pr_message ADD COLUMN summary_json TEXT'],
];
```

**[관측]** `schema.ts` 머리말이 담지 않을 것을 명시한다: "thread transition 기록, Gate↔action
correlation, coordinator notification pending, **관찰 cursor**".

**[관측]** Bridge는 Run 목록을 이미 전부 갖고 있다.

```ts
// snapshot.ts:52
export async function collectRuns(orca: OrcaRunner): Promise<RunView[]> {
  const runs = await listRuns(orca);          // orchestration run-list --json — 상한·cursor 없이 전체
  for (const run of runs) { const tasks = run.legacy ? [] : await listTasks(orca, run.id); }
}
```

**[관측]** `run-list`를 `--limit`/`--cursor` 없이 부르면 전체가 온다(**[소스]** `listRuns`가 두 인자가
모두 undefined일 때 페이지네이션 경로를 타지 않는다). 이 호스트 실측 8건, `nextCursor: null`.

### [결론]

**[관측]** 복사 방식은 **성립한다.** 필요한 재료가 모두 있다. store는 append-only 마이그레이션으로
테이블을 하나 늘릴 수 있고, Bridge는 Run 목록을 이미 갖고 있으며, §(c)의 조회는 무권한·비소비다.

**[관측]** 그러나 요구되는 polling 주기와 유실 조건은 다음과 같고, 이것이 선택의 핵심이다.

**요구 polling 주기.** **[관측]** 현재 Bridge에 주기가 없다. `digest` 1회 실행이 관찰 1회다(OD-023).
복사 시점은 `digest`가 실행되는 순간뿐이다. **[추론]** 따라서 "얼마나 자주 복사해야 하는가"는
"연속한 두 `digest` 실행 사이에 조회 범위 밖으로 밀려나는 `worker_done`이 있어서는 안 된다"로
바뀐다. 조회를 §(c)의 Run 범위로 바꾸면 그 Run의 메시지 수가 상한을 넘을 때만 밀려나므로,
전역 5000행 기준보다 훨씬 느슨한 주기로 충분하다. **[관측]** 구체적 값은 정할 수 없다.
OD-062(허용 지연·비용 한도)와 OD-065(동시 Run 규모)가 열려 있다.

**유실 조건.** **[관측]** 다음 넷이다.

1. **관찰 공백.** `digest`가 실행되지 않는 동안 메시지가 조회 범위 밖으로 밀려나면 영영 복사되지
   않는다. 복사 방식은 이 창을 **닫지 못한다.** 원래 문제와 같은 성질이다.
2. **Orca 쪽 삭제/정리.** **[관측]** Orca가 messages 행을 정리하는지 **관측하지 못했다.**
   `orca orchestration reset --messages`가 존재하지만(**[문서]**) 실행하지 않았다. 자동 retention은
   확인하지 않았다.
3. **crash 창.** **[관측]** `schema.ts`가 이미 같은 성질의 창 둘(post 성공 후 insert 전 crash,
   결과를 모르는 delivery 실패)을 문서화하고 C1 범위 밖으로 두었다. `worker_report` 복사도
   같은 경계를 갖는다. OD-051이 열려 있다.
4. **store 파일 유실.** **[관측]** `%APPDATA%\orca-slack-bridge\state.db` 하나이고 backup 정책은
   OD-045에서 열려 있다.

**[추론]** 요약하면, 복사는 (a)의 덮어쓰기는 확실히 막지만 (b)의 "충분히 멀리 못 본다"는 성질은
막지 못한다. 후자를 실제로 줄이는 것은 §(c)의 Run 범위 조회다.

### [남는 선택지]

**[관측]** 아래 넷 중 어느 것도 구현하거나 검증하지 않았다.

1. **복사 없음 + Run 범위 조회.** `listWorkerDone`을 `inbox --terminal run:<id>`로 바꾸고 store는
   그대로 둔다. **[추론]** 가장 작은 변경이다. Orca가 유일한 source로 남는다. Orca의 retention을
   모른다는 위험(유실 조건 2)이 남는다.
2. **복사 + Run 범위 조회.** 위에 더해 관측할 때마다 새 `worker_done`을 store에 upsert한다.
   필요한 스키마 변경은 새 테이블 하나와 `MIGRATIONS` 한 항목(`SCHEMA_VERSION` 3)이다.
   **[추론]** `message_id`가 PRIMARY KEY면 재관찰 멱등성이 자연히 나온다. Orca retention과
   무관해지는 대신 store가 두 번째 진실 원본이 된다.
3. **복사 + 관찰 cursor.** 마지막으로 본 `sequence`를 store에 남겨 다음 관찰이 그 이후만 읽는다.
   **[관측]** `inbox`에 cursor 파라미터가 없으므로 CLI에서 `sequence`로 자를 수 없고, 전체를 받아
   Bridge가 거르는 형태가 된다. **[관측]** `schema.ts`가 "관찰 cursor"를 명시적으로 담지 않기로
   했으므로 그 결정을 되돌리는 변경이다.
4. **`task.result` 병합.** (a)의 선택지 1. **[추론]** Bridge 변경이 아니라 coordinator 규약 변경이다.
   store도 조회 방식도 바꾸지 않는다.

**[관측]** 이 절은 선택지 제시까지이며 결정하지 않는다.

---

## 5. 실험이 남긴 리소스

**[관측]** 실험이 만든 것과 정리 결과.

| 리소스 | 상태 |
|---|---|
| `run_c940ec042fc1` (THROWAWAY OD-075 probe) | **남음.** Run을 지우는 CLI 명령이 없다 |
| `task_a027eb19b0e2` | **남음.** 위 Run에 속함 |
| `ctx_95ba7239bbaa` | **남음.** `worker-release` → `{"state":"retained","reason":"no_owned_resource"}` |
| `msg_a5080d33049b` (THROWAWAY worker_done, sequence 122) | **남음.** 전역 `inbox`에 보인다 |
| `term_2bdfdfe6-...` (THROWAWAY coordinator) | 닫음. `terminal close --tab` |
| `term_2058bfe6-...` (THROWAWAY worker) | 닫음. `terminal close --tab` |
| `run_b82acb7fe8c2` (§(a) [재현] Run) | **남음.** Run을 지우는 CLI 명령이 없다 |
| `task_33a60121fe62`, `ctx_8b5bbcee31c7` | **남음.** `worker-release` → `{"state":"retained","reason":"no_owned_resource"}` |
| `msg_24e91fbd2df6` (재현 worker_done, sequence 273) | **남음.** 전역 `inbox`에 보인다 |
| `term_e08e20a0-...`, `term_25ede6a0-...` (재현용 터미널 둘) | 닫음. `terminal close --tab` |
| 임시 스크립트·원시 로그 | 시스템 temp에만 있다. 레포에 커밋하지 않았다 |

**[관측]** `orca orchestration reset --messages`/`--all`은 전역 파괴 명령이므로 실행하지 않았다.

**[관측]** 실험 전부터 있던 THROWAWAY Run이 넷 더 있다. 내가 만들지 않았고 건드리지도 않았다:
`run_e2c19c691c49`(OD-075 T2 probe, 04:15:42), `run_f039af831871`(T3 Gate observation, 04:25:23),
`run_ebd0bb4592d2`, `run_a48566be983b`.

**[관측]** 실험 뒤 `run-show --id run_36d28e6e947a`는 `coordinator_handle: term_29548394-...`,
`consumer_generation: 1`을 반환했다. 이 handle은 이 Dispatch preamble이 지정한 coordinator handle과
같다. **[추론]** 따라서 이 Run의 소유권은 실험으로 바뀌지 않았다. 실험 전 `run-show`는 실행하지
않았으므로 "바뀌지 않았다"는 관측이 아니라 이 대조에 근거한 판단이다.
**[관측]** `run_7804be5a654f`에는 읽기 명령만 실행했다.

## 6. 관측하지 못한 것 — 남는 가설

**[관측]** 아래는 확인하지 않았다. 관측한 것처럼 쓰지 않는다.

1. **`T > 5000`에서의 `inbox` 동작.** 전역 메시지도 한 Run mailbox도 5000행 이상 쌓지 않았다.
   실제 측정 범위는 전역 `T` = 114…132, Run mailbox `T` = 97(`L` = 3…5000)이다. 그 범위 밖에서
   clamp 부재의 근거는 **[소스]**뿐이고 **[관측]**이 아니다.
2. **Orca의 messages retention.** 오래된 메시지를 자동으로 지우는지, 그 기준이 무엇인지 확인하지
   않았다. §(d) 유실 조건 2가 여기 걸려 있다.
3. **`worker-list --run`과 `task-list --run`의 상한.** 각각 40행·38행만 관측했다. 상한이 있는지
   특정하지 못했다.
4. **`worker-read --source transcript`가 실제로 성공하는 Dispatch.** 시도한 두 Dispatch 모두
   `session_not_reported`였다. transcript가 있는 Dispatch에서 무엇이 오는지 관측하지 못했다.
5. **`--to dispatch:<id>`로 보낸 `worker_done`.** **[소스]**는 `send` 핸들러가 수신자를
   `run:<id>`로 덮어쓴다고 말하지만, `routing.dispatchId`가 없는 경로에서도 그런지는 실행하지 않았다.
6. **재dispatch가 남긴 복수 `worker_done`의 Run mailbox 보존.** 실제 Run에서 Task당 여러 건이
   남는지 세어보지 않았다.
7. **`check --run --all` 100행 상한의 실제 도달.** `run_7804be5a654f`는 Run mailbox 97행이라
   상한에 닿지 않는다. 상한이 잘림을 어떻게 드러내는지(혹은 드러내지 않는지) 관측하지 못했다.

## 7. 권장(미확정)

**[추론]** 관측에 근거한 권장이며 결정은 사용자가 한다.

- **(b)** C1의 포화 판정은 **바꿀 필요가 없다.** clamp가 없어 판정이 건전하고, 양의 정수가 아닌
  `--limit`은 CLI가 이미 거절한다.
- **(c)** `listWorkerDone`을 `inbox --terminal "run:<run_id>"` Run별 호출로 바꾸는 것이 가장 작은
  변경으로 Run 필터와 상한 압박을 동시에 해결한다. Bridge가 이미 Run 목록을 갖고 있어 추가 재료가 없다.
- **(a)** `task.result` 덮어쓰기 자체는 Orca 동작이므로 Bridge에서 막을 수 없다. `worker_done`을
  `task.result`가 아니라 Run mailbox에서 읽으면 Bridge는 덮어쓰기와 무관해진다.
- **(d)** durable store 복사는 성립하지만 (b)의 성질을 닫지 못하므로, (c)를 먼저 하고 복사는
  OD-045/OD-051/OD-062가 닫힌 뒤에 판단하는 편이 낫다.
