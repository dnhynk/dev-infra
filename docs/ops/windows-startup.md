# Windows current-user 자동 시작 운영

상태: **O1 canonical operator workflow**
대상: Windows PowerShell 5.1, Node.js 26.x, pnpm 11.22.0

## 불변 release 만들기

worktree나 일반 `pnpm deploy` 결과를 `--app-root`로 주지 않는다. 저장소 root에서 frozen install과
build를 끝낸 뒤 지원되는 staging 명령을 그대로 실행한다.

```powershell
pnpm install --frozen-lockfile
pnpm --filter @dev-infra/orca-slack-bridge build
pnpm --filter @dev-infra/orca-slack-bridge stage:windows
```

마지막 명령은 current-user-only publication mutex를 잡고 hoisted production dependency tree를
regular file로 물질화한다. Windows reparse attribute, hard link, non-NFC 이름과
`OrdinalIgnoreCase` 충돌을 거부하고 app-owned `dist/**`와 launcher의 text EOL을 LF로
canonicalize한 다음 전체 closure를 검사·hash한다. 따라서 동일 source commit은 checkout/build의
CRLF 설정과 동시 stage 여부에 무관하게 다음 형태의 같은 경로와 digest로 수렴한다.

```text
%LOCALAPPDATA%\OrcaSlackBridge\releases\<64-lowercase-hex-digest>
```

출력된 `release` 경로만 최종 install에 사용한다. 같은 digest가 이미 있으면 전체 tree를 다시
검증하고 `status=unchanged`로 재사용한다. symlink, junction/reparse point, hard link, 외부 경로,
production dependency 누락, digest 불일치는 모두 fail closed다.

## 설치와 실행

`ORCA_SLACK_BRIDGE_BOT_TOKEN`과 `ORCA_SLACK_BRIDGE_APP_TOKEN`은 Windows **User scope**에 각각
비어 있지 않게 설정한다. 값을 config, 명령행, task XML, runtime manifest, 로그에 쓰지 않는다.
그런 다음 실제 절대경로를 사용해 staged CLI를 실행한다.

```powershell
$release = '<stage:windows가 출력한 release 절대경로>'
$node = '<versioned Node 26 node.exe 절대경로>'
& $node "$release\dist\cli.js" install `
  --app-root $release `
  --node $node `
  --orca '<orca.exe 절대경로>' `
  --config '<credential-free config 절대경로>' `
  --state '<state.db 절대경로>' `
  --log-dir '<운영 log directory 절대경로>'
```

plain install은 task를 시작하지 않는다. 즉시 확인하려면 같은 install에 `--run-now`를 추가하거나
나중에 staged CLI의 `run-now --wait-seconds 90`을 사용한다. install은 현재 SID의 root Scheduled
Task를 COM validate-only로 먼저 검증하고, protected runtime manifest와 task를 CAS/rollback으로
갱신한다. task action에는 절대 System32 Windows PowerShell, versioned launcher, protected manifest
경로만 들어간다. Task XML은 schema `1.2`부터 host COM `HighestVersion`까지의 export만 허용하며,
현재 host 범위를 벗어난 `1.99` 같은 plausible future 값도 fail closed한다.

launcher는 매 시작마다 상속된 두 canonical token과 build identity를 먼저 버린다. 현재 User의
known-folder `%LOCALAPPDATA%` 아래 canonical release root인지 확인하고, 모든 transitive byte/path와
reparse point, hard link, tree 변화 및 release digest를 다시 검증한다. 이어서 실제 고정 Task export의
전체 closed semantics와 marker fingerprint가 protected manifest와 일치하는지 확인한 뒤에만 token을 읽는다. token은
Windows User scope에서 정확히 한 번씩 다시 읽어 daemon child 환경에만 넣고, build identity는
release digest로 고정한다. token 누락이나 runtime/release drift는 값 없이 static error로 종료한다.

설치 preflight의 Orca readiness probe는 trusted known-folder API로 얻어 canonicalize한 `APPDATA`와
`LOCALAPPDATA`만 기존의 최소 Windows system 환경에 추가해 `orca status --json`을 실행한다. exit,
bounded timeout 및 closed ready shape 중 하나라도 맞지 않으면 설치를 시작하지 않는다.

## 재설치와 제거

같은 task를 재설치할 때도 protected manifest, 전체 release digest, 기존 v13 state를 read-only로
검증한다. present 상태 파일에 `schema_version`이 없거나 손상된 경우 foreign/unversioned DB로
fail closed하며 v13을 덧씌우지 않는다. missing/corrupt/legacy 상태를 `unchanged`로 받아들이지 않으며
healthy daemon을 멈추거나 state migration을 조용히 수행하지 않는다.

```powershell
& $node "$release\dist\cli.js" uninstall --wait-seconds 90
```

기본 uninstall은 task/release/state identity와 관찰한 daemon health revision/lifetime을 먼저 lease로
고정한 뒤 task를 CAS-disable하고 같은 lease에서만 durable stop으로 전이한다. 그 사이 health가
바뀌면 desired-state write를 거부하고 exact disabled XML CAS로 기존 enabled Task를 복구한다.
정상 stop timeout이면 disabled task와
config/state/log/release를 보존한다. 정상 graceful timeout 뒤에만 명시적으로 `--force`를 붙일 수
있다. force는 static warning을 출력한 뒤 exact-owned task/XML/manifest identity를 다시 검증하고 그
task의 daemon만 중지하며, pipe와 task release를 bounded wait한 후 unregister한다. 어떤 uninstall도
operator data나 release를 삭제하지 않는다.
