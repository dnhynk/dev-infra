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

마지막 명령은 hoisted production dependency tree를 regular file로 물질화하고 전체 closure를
검사·hash한 뒤 다음 형태의 경로와 digest만 출력한다.

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
경로만 들어간다.

launcher는 매 시작마다 상속된 두 canonical token과 build identity를 먼저 버린다. token은 Windows
User scope에서 정확히 한 번씩 다시 읽어 daemon child 환경에만 넣고, build identity는 release
digest로 고정한다. token 누락이나 runtime drift는 값 없이 static error로 종료한다.

## 재설치와 제거

같은 task를 재설치할 때도 protected manifest, 전체 release digest, 기존 v13 state를 read-only로
검증한다. missing/corrupt/legacy 상태를 `unchanged`로 받아들이지 않으며 healthy daemon을 멈추거나
state migration을 조용히 수행하지 않는다.

```powershell
& $node "$release\dist\cli.js" uninstall --wait-seconds 90
```

기본 uninstall은 task를 먼저 disable하고 durable stop을 기다린다. timeout이면 disabled task와
config/state/log/release를 보존한다. 정상 graceful timeout 뒤에만 명시적으로 `--force`를 붙일 수
있다. force는 static warning을 출력한 뒤 exact-owned task/XML/manifest identity를 다시 검증하고 그
task의 daemon만 중지하며, pipe와 task release를 bounded wait한 후 unregister한다. 어떤 uninstall도
operator data나 release를 삭제하지 않는다.
