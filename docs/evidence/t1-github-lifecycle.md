# T1 · GitHub PR lifecycle 실측 — OD-030/031/032/044/046/076/077

[관측] 실측 시각은 2026-08-23이며 GitHub API 시각은 UTC다.

[관측] `gh 2.98.0`을 `dnhynk` 계정으로 사용했고 인증 scope는 `gist`, `read:org`, `repo`, `workflow`였다.

[관측] 기존 운영 repository와 PR은 읽기만 했고, write 관측은 명시적으로 허용된 `dnhynk/THROWAWAY-orca-github-lifecycle-bc06`, 독립 재현용 `dnhynk/THROWAWAY-orca-pr11-od032-71b6`, head polling 재현용 `dnhynk/THROWAWAY-orca-pr11-headpoll-6180d8`에서만 수행했다. 세 repository는 관측 뒤 archive했다.

[관측] 기존 [platform-capabilities.md §5](../platform-capabilities.md#5-github)의 `merged PR은 mergeable/mergeStateStatus가 UNKNOWN`, `reviewDecision은 대상 repository에서 null`, `check 수는 repository별로 다름`과 어긋나는 결과는 없었다.

[관측] 이번 문서는 열린 결정을 닫지 않으며, 관측 사실과 배제되는 선택지와 남는 선택지만 적는다.

## 0. 표본과 공통 경계

| 표본 | 사용 목적 |
|---|---|
| `cli/cli#14200`, `#14198`, `#14215`, `#14222`, `#14240` | [관측] draft, changes-requested, approved/clean, merged, closed-unmerged 현재 snapshot |
| `cli/cli#14007` | [관측] ready → draft → ready 전이 timeline |
| `cli/cli#14136` | [관측] 같은 reviewer의 changes-requested → approved |
| `cli/cli#13250` | [관측] approval 뒤 새 commit이 있어도 approval이 유지되는 경우 |
| `microsoft/vscode#331771` | [관측] approval 뒤 새 commit으로 approval이 dismissed되는 경우 |
| `cli/cli#14056` | [관측] changes-requested review의 명시적 dismissal |
| THROWAWAY PR `#1` | [관측] required/optional checks, commit status, `mergeable:null`, out-of-order snapshot, body edit, commit trailer, 실제 merge |
| `THROWAWAY-orca-pr11-od032-71b6#1` | [관측] 빈 repository부터 OD-032 절차 독립 재현, 미보고 required의 405와 제거 뒤 optional failure 상태의 실제 merge |
| `THROWAWAY-orca-pr11-headpoll-6180d8#1` | [관측] final update 뒤 stale head read와 bounded polling, 새 head의 required success·optional failure 상태에서 실제 merge 재현 |
| `THROWAWAY-orca-c2-ruleset-11c46c2b#1` | [관측] classic protection과 repository ruleset이 동시에 적용된 base branch의 required rule 합집합과 rollup 조인 |

[문서] REST PR, review, check, status, protection, timeline의 현재 계약은 각각 [Pull requests](https://docs.github.com/en/rest/pulls/pulls), [Pull request reviews](https://docs.github.com/en/rest/pulls/reviews), [Check runs](https://docs.github.com/en/rest/checks/runs), [Commit statuses](https://docs.github.com/en/rest/commits/statuses), [Protected branches](https://docs.github.com/en/rest/branches/branch-protection), [Timeline events](https://docs.github.com/en/rest/issues/timeline)에 있다.

[관측] `gh pr view --json`은 GraphQL을 사용하므로 같은 PR을 REST와 직접 GraphQL로도 조회해 필드 차이를 확인했다.

## OD-030 · canonical PR state

### [실행한 명령]

[관측] 첫 block은 최초 표본에서 캡처한 명령 발췌이고 단독 재현 절차가 아니다. 바로 뒤 두 번째 block은 최초 버전에서 누락됐던 final check 생성과 미보고 required 제거를 포함해 빈 repository부터 실행한 완결 절차다.

```powershell
gh pr view 14215 --repo cli/cli `
  --json number,state,isDraft,reviewDecision,mergeable,mergeStateStatus,mergedAt,closedAt,headRefOid,updatedAt,statusCheckRollup
gh pr view 14198 --repo cli/cli --json state,isDraft,reviewDecision,mergeable,mergeStateStatus,mergedAt,closedAt
gh pr view 14200 --repo cli/cli --json state,isDraft,reviewDecision,mergeable,mergeStateStatus,mergedAt,closedAt
gh pr view 14222 --repo cli/cli --json state,isDraft,reviewDecision,mergeable,mergeStateStatus,mergedAt,closedAt,mergeCommit
gh pr view 14240 --repo cli/cli --json state,isDraft,reviewDecision,mergeable,mergeStateStatus,mergedAt,closedAt,mergeCommit

gh api repos/cli/cli/pulls/14215 --jq `
  '{state,draft,merged,merged_at,closed_at,mergeable,mergeable_state,head_sha:.head.sha,updated_at,node_id,id,has_reviewDecision:has("reviewDecision")}'
gh api graphql -F owner=cli -F name=cli -F number=14215 -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id databaseId state isDraft reviewDecision mergeable mergeStateStatus mergedAt closedAt headRefOid updatedAt}}}'

gh api repos/cli/cli/issues/14007/timeline --paginate --jq `
  '[.[]|select(.event=="convert_to_draft" or .event=="ready_for_review")|{id,node_id,event,created_at,actor:.actor.login}]'

gh api graphql -f query='query{prState:__type(name:"PullRequestState"){enumValues{name description}} mergeable:__type(name:"MergeableState"){enumValues{name description}}}'
gh api graphql -f query='query{mergeState:__type(name:"MergeStateStatus"){enumValues{name description}} reviewDecision:__type(name:"PullRequestReviewDecision"){enumValues{name description}}}'
```

### [출력 발췌]

```text
cli/cli#14200  state=OPEN   isDraft=true  reviewDecision=REVIEW_REQUIRED mergeable=MERGEABLE mergeStateStatus=BLOCKED
cli/cli#14198  state=OPEN   isDraft=false reviewDecision=CHANGES_REQUESTED mergeable=MERGEABLE mergeStateStatus=BLOCKED
cli/cli#14215  state=OPEN   isDraft=false reviewDecision=APPROVED mergeable=MERGEABLE mergeStateStatus=CLEAN
cli/cli#14222  state=MERGED mergedAt=2026-08-21T19:44:44Z mergeable=UNKNOWN mergeStateStatus=UNKNOWN
cli/cli#14240  state=CLOSED mergedAt=null mergeCommit=null mergeable=MERGEABLE mergeStateStatus=BLOCKED
```

```text
// REST, cli/cli#14215
{"state":"open","draft":false,"merged":false,"merged_at":null,"mergeable":true,"mergeable_state":"clean","has_reviewDecision":false}

// GraphQL, 같은 PR
{"state":"OPEN","isDraft":false,"reviewDecision":"APPROVED","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","mergedAt":null}
```

```text
cli/cli#14007 timeline
2026-07-29T15:20:41Z ready_for_review
2026-07-30T13:00:46Z convert_to_draft
2026-08-19T13:56:42Z ready_for_review
```

```text
PullRequestState        OPEN, CLOSED, MERGED
MergeableState          MERGEABLE, CONFLICTING, UNKNOWN
PullRequestReviewDecision CHANGES_REQUESTED, APPROVED, REVIEW_REQUIRED
MergeStateStatus        DIRTY, UNKNOWN, BLOCKED, BEHIND, UNSTABLE, HAS_HOOKS, CLEAN
```

### [관측된 사실]

- [관측] GraphQL/`gh pr view`의 `state` 하나는 `OPEN`, `CLOSED`, `MERGED`를 구분한다.
- [관측] REST의 `state`는 merged와 closed-unmerged를 모두 `closed`로 반환하므로 `merged` 또는 `merged_at`을 함께 봐야 한다.
- [관측] draft는 별도 boolean인 GraphQL `isDraft` 또는 REST `draft`이며 state는 계속 `OPEN`이다.
- [관측] changes-requested와 approved는 PR state가 아니라 GraphQL `reviewDecision` 축이다.
- [관측] REST PR 객체에는 `reviewDecision` 필드가 없고 reviews endpoint를 별도로 축약해야 한다.
- [관측] `mergeable=MERGEABLE`인 PR도 draft, changes-requested, required-check 미충족 때문에 `mergeStateStatus=BLOCKED`일 수 있다.
- [관측] merged PR은 GraphQL `state=MERGED`와 `mergedAt`, REST `state=closed`와 `merged=true`/`merged_at`으로 확정되고 두 API 모두 mergeability는 `UNKNOWN`/`null`로 돌아갔다.
- [관측] closed-unmerged는 GraphQL `state=CLOSED`, REST `state=closed`이면서 `merged=false`, `merged_at=null`이었다.
- [관측] draft 전이는 현재 snapshot에 누적되지 않지만 timeline의 `ready_for_review`와 `convert_to_draft` event로 남았다.
- [추론] `open/draft/changes_requested/approved/merge-ready/merged/closed`를 한 enum으로 GitHub에서 읽을 수 없고, 적어도 terminal state, draft, review, check/protection, mergeability 축을 조합해야 한다.
- [추론] `merge-ready`는 persisted GitHub state가 아니라 현재 정책을 반영한 derived state여야 한다.

### [배제되는 선택지]

- [추론] REST `state` 한 필드만 canonical state로 쓰는 선택지는 merged와 closed-unmerged를 구분하지 못하므로 배제된다.
- [추론] GraphQL `state` 한 필드만 쓰는 선택지는 draft, review, required check, merge conflict를 표현하지 못하므로 배제된다.
- [추론] `mergeable=true`를 merge-ready로 동일시하는 선택지는 `cli/cli#14198`과 THROWAWAY 관측에 반한다.
- [추론] `mergeStateStatus=CLEAN`만을 모든 repository의 merge-ready로 동일시하는 선택지도 ruleset, review, merge queue를 별도로 확인하지 못하므로 배제된다.

### [남는 선택지]

- [추론] terminal state를 `open | closed | merged`로 두고 `draft`, `review`, `checks`, `mergePolicy`를 직교 축으로 보존한 뒤 UI 의미 상태를 파생하는 선택지가 남는다.
- [추론] terminal enum에 draft/review/check를 우선순위로 접어 한 enum을 만드는 선택지도 남지만 원본 축을 함께 저장해야 전이 손실을 막을 수 있다.
- [권장(미확정)] merged는 `mergedAt != null` 또는 GraphQL `state=MERGED`를 terminal latch로 두고, closed-unmerged만 reopen 가능한 상태로 취급하는 편이 OD-044의 역행 방지와 맞는다.

## OD-031 · review verdict 축약과 새 commit 후 approval

### [실행한 명령]

```powershell
gh api repos/cli/cli/pulls/14136/reviews --paginate --jq `
  '[.[]|select(.user.login=="babakks")|{id,node_id,user:.user.login,state,commit_id,submitted_at}]'
gh pr view 14136 --repo cli/cli --json state,reviewDecision,headRefOid,reviews,latestReviews

gh pr view 13250 --repo cli/cli --json baseRefName,headRefOid,reviewDecision,reviews,commits

gh api repos/microsoft/vscode/pulls/331771/reviews --paginate --jq `
  '[.[]|{id,node_id,user:.user.login,state,commit_id,submitted_at}]'
gh api repos/microsoft/vscode/issues/331771/timeline --paginate --jq `
  '[.[]|select(.event=="review_dismissed")|{id,node_id,event,created_at,actor:.actor.login,dismissed_review}]'
gh pr view 331771 --repo microsoft/vscode --json state,isDraft,reviewDecision,headRefOid,commits,reviews,latestReviews

gh api repos/cli/cli/pulls/14056/reviews --paginate --jq `
  '[.[]|{id,node_id,user:.user.login,state,commit_id,submitted_at}]'
gh api repos/cli/cli/issues/14056/timeline --paginate --jq `
  '[.[]|select(.event=="review_dismissed")|{id,node_id,event,created_at,actor:.actor.login,dismissed_review}]'
```

### [출력 발췌]

```text
cli/cli#14136, reviewer=babakks
4960472345 CHANGES_REQUESTED commit=10e8f3c... submitted=2026-08-18T11:46:11Z
4994423993 APPROVED         commit=f5dce1a... submitted=2026-08-21T14:36:57Z
current head=f5dce1a... reviewDecision=APPROVED
```

```text
cli/cli#13250
approval commit=b0929b5... submitted=2026-04-21T15:40:25Z
current head=d725e0a... latest commit=2026-05-13T18:08:54Z
review state=APPROVED, reviewDecision=APPROVED
```

```text
microsoft/vscode#331771
review 4985524821 state=DISMISSED commit=602781a... submitted=2026-08-20T17:20:34Z
new head eadb3fa... committed=2026-08-20T19:46:34Z
review_dismissed at 2026-08-20T19:46:55Z original_state=approved dismissal_commit_id=eadb3fa...
current reviewDecision=REVIEW_REQUIRED
```

```text
cli/cli#14056
review 4885888245 current state=DISMISSED
review_dismissed original_state=changes_requested message="The requested changes are applied."
```

### [관측된 사실]

- [문서] REST reviews 목록은 chronological order로 반환되며 각 review에 `id`, `node_id`, `state`, `commit_id`, `submitted_at`이 있다.
- [관측] 같은 reviewer가 changes-requested 뒤 approve하면 두 review row가 모두 남고 현재 `reviewDecision`은 `APPROVED`가 됐다.
- [관측] `gh pr view.reviews`는 두 row를 모두 주고 `latestReviews`는 reviewer별 최신 verdict만 남겼다.
- [관측] 새 commit 뒤 approval의 처리에는 repository 정책에 따른 두 경로가 실제로 있었다.
- [관측] `cli/cli#13250`은 approval의 `commit_id`와 현재 head가 달라도 review가 `APPROVED`, aggregate가 `APPROVED`로 유지됐다.
- [관측] `microsoft/vscode#331771`은 새 head 직후 같은 review id가 `DISMISSED`로 바뀌고 timeline에 원래 state `approved`와 `dismissal_commit_id`가 남았으며 aggregate는 `REVIEW_REQUIRED`였다.
- [관측] dismissed review의 reviews API row는 원래 `APPROVED`/`CHANGES_REQUESTED`를 보존하지 않고 현재 `DISMISSED`만 준다.
- [관측] 원래 verdict와 dismissal 이유/commit은 `review_dismissed` timeline event를 합쳐야 복원됐다.
- [문서] branch protection/ruleset의 `Dismiss stale approvals`가 켜져 있고 diff가 바뀌면 approval은 dismissed되고 다시 approval을 받아야 한다.
- [추론] API에 별도 `staleApproval: true`는 없고, `review.commit_id != current head`는 오래된 head에 대한 review라는 사실만 알려 준다.
- [추론] mismatch가 GitHub 정책상 무효라는 뜻은 아니며 `cli/cli#13250`이 반례다.
- [추론] 기존 `reviewer_result.reviewedHeadSha`와 현재 `headRefOid`를 비교한 `headMatch`는 GitHub review의 `commit_id` 비교와 같은 사실 축이지만, 유효성 정책까지 대신하지 않는다.
- [관측] 기존 계약은 formal verdict의 durable source를 Orca로 정했고 이번 GitHub 관측은 그 결정을 뒤집지 않는다.

### [배제되는 선택지]

- [추론] reviews 배열의 마지막 row 하나만 전체 verdict로 쓰는 선택지는 여러 reviewer와 dismissed history를 처리하지 못하므로 배제된다.
- [추론] `commit_id != head`인 approval을 무조건 request-changes/review-required로 바꾸는 선택지는 stale dismissal이 꺼진 repository의 실제 `APPROVED`와 충돌하므로 배제된다.
- [추론] reviews API만으로 dismissed review의 원래 state를 복원하는 선택지는 배제된다.
- [추론] `reviewDecision`만 저장해 review 전이와 reviewed head를 버리는 선택지는 changes-requested → approved 및 dismissal 원인을 재구성하지 못하므로 배제된다.

### [남는 선택지]

- [추론] Orca verdict에는 현재 `headMatch` 사실을 계속 표시하고, 유효성은 별도의 C2 정책으로 결정하는 선택지가 남는다.
- [추론] GitHub formal review를 보조 표시할 경우 GraphQL `reviewDecision`을 현재 aggregate로 쓰고 REST review/timeline을 history와 진단에 쓰는 선택지가 남는다.
- [추론] 새 head마다 review를 무조건 재요구하는 Bridge 정책과 GitHub repository의 stale-review 설정을 따르는 정책이 모두 남아 있으며 사용자가 결정해야 한다.

## OD-032 · required/optional check와 merge-ready

### [실행한 명령]

```powershell
# THROWAWAY main protection에 존재하는 check와 아직 존재하지 않는 context를 함께 required로 설정
$body = '{"required_status_checks":{"strict":true,"contexts":["required-ci","optional-skip","legacy-required","never-starts"]},"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null}'
$body | gh api --method PUT `
  repos/dnhynk/THROWAWAY-orca-github-lifecycle-bc06/branches/main/protection --input -
gh api repos/dnhynk/THROWAWAY-orca-github-lifecycle-bc06/branches/main/protection/required_status_checks

# PR 생성 직후 mergeability 반복 조회
gh api --method POST repos/dnhynk/THROWAWAY-orca-github-lifecycle-bc06/pulls `
  -f title='THROWAWAY lifecycle probe' -f head=probe -f base=main `
  -f body='<!-- orca-run: run_THROWAWAY -->'
1..5 | ForEach-Object { gh api repos/dnhynk/THROWAWAY-orca-github-lifecycle-bc06/pulls/1 }

# commit status와 check run/rollup
gh api --method POST repos/dnhynk/THROWAWAY-orca-github-lifecycle-bc06/statuses/2cba3aff11cb6b003fd32212e804557c080300dd `
  -f state=pending -f context=legacy-required -f description='THROWAWAY pending'
gh api repos/dnhynk/THROWAWAY-orca-github-lifecycle-bc06/commits/2cba3aff11cb6b003fd32212e804557c080300dd/check-runs
gh api repos/dnhynk/THROWAWAY-orca-github-lifecycle-bc06/commits/2cba3aff11cb6b003fd32212e804557c080300dd/status
gh pr view 1 --repo dnhynk/THROWAWAY-orca-github-lifecycle-bc06 `
  --json mergeable,mergeStateStatus,headRefOid,updatedAt,statusCheckRollup
gh pr checks 1 --repo dnhynk/THROWAWAY-orca-github-lifecycle-bc06 --required

# required success/skipped/status-success, optional failure인 상태에서 admin enforcement 후 실제 merge
gh api --method POST `
  repos/dnhynk/THROWAWAY-orca-github-lifecycle-bc06/branches/main/protection/enforce_admins
gh api --method PUT repos/dnhynk/THROWAWAY-orca-github-lifecycle-bc06/pulls/1/merge `
  -f merge_method=squash -f sha=ed617a01fc66ec4cf7849b2f1ac23d819dd557f3

# live neutral 표본 검색과 schema 확인
gh pr list --repo cli/cli --state open --limit 50 --json number,url,statusCheckRollup `
  --jq '[.[] as $pr|$pr.statusCheckRollup[]|select(.conclusion=="NEUTRAL")]'
gh api graphql -f query='query{checkStatus:__type(name:"CheckStatusState"){enumValues{name description}} checkConclusion:__type(name:"CheckConclusionState"){enumValues{name description}}}'
```

```powershell
$repo = 'dnhynk/THROWAWAY-orca-pr11-headpoll-6180d8'
gh repo create $repo --public --add-readme `
  --description 'THROWAWAY: PR #11 stale head polling reproduction; safe to archive'

# final check들을 실제로 만드는 workflow를 main에 설치
$workflowText = @'
name: lifecycle

on:
  pull_request:

jobs:
  required-ci:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - name: Select outcome from the branch
        run: grep -qx success result.txt

  optional-skip:
    if: ${{ false }}
    runs-on: ubuntu-latest
    steps:
      - run: echo skipped

  optional-fail:
    runs-on: ubuntu-latest
    steps:
      - run: exit 1
'@
$workflowBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($workflowText))
gh api --method PUT repos/$repo/contents/.github/workflows/lifecycle.yml `
  -f message='test: add lifecycle workflow' -f content=$workflowBase64 -f branch=main

$mainSha = gh api repos/$repo/git/ref/heads/main --jq .object.sha
gh api --method POST repos/$repo/git/refs -f ref='refs/heads/probe' -f sha=$mainSha
$failureBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("failure`n"))
gh api --method PUT repos/$repo/contents/result.txt `
  -f message='test: begin with required failure' -f content=$failureBase64 -f branch=probe

$initialProtection = '{"required_status_checks":{"strict":true,"contexts":["required-ci","optional-skip","legacy-required","never-starts"]},"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null}'
$initialProtection | gh api --method PUT repos/$repo/branches/main/protection --input -
gh pr create --repo $repo --head probe --base main `
  --title 'THROWAWAY lifecycle probe' --body '<!-- orca-run: run_THROWAWAY_pr11_headpoll -->'

# final update 직전 head를 기억하고 content API가 반환한 새 commit을 기대값으로 잡는다.
$previousHeadSha = gh pr view 1 --repo $repo --json headRefOid --jq .headRefOid
Write-Output "previous_head=$previousHeadSha"
$resultBlobSha = gh api "repos/$repo/contents/result.txt?ref=probe" --jq .sha
$successBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("success`n"))
$expectedHeadSha = gh api --method PUT repos/$repo/contents/result.txt `
  -f message='test: create final required success' -f content=$successBase64 `
  -f branch=probe -f sha=$resultBlobSha --jq .commit.sha
Write-Output "expected_head=$expectedHeadSha"
if ($expectedHeadSha -eq $previousHeadSha) {
  throw 'Final update did not advance the head; stop before posting status, selecting a run, or merging.'
}

# headRefOid는 update 직후 stale할 수 있다. 최대 60초 동안 2초 간격으로 기대 SHA를 확인한다.
# timeout이면 throw로 중단하며 잘못된 head에 status/run/merge를 연결하지 않는다.
$headDeadline = (Get-Date).AddSeconds(60)
$headPollCount = 0
do {
  $headPollCount += 1
  $headSha = gh pr view 1 --repo $repo --json headRefOid --jq .headRefOid
  Write-Output "head_poll[$headPollCount]=$headSha"
  if ($headSha -eq $expectedHeadSha) { break }
  if ((Get-Date) -ge $headDeadline) {
    throw "Timed out waiting for final head: previous=$previousHeadSha expected=$expectedHeadSha observed=$headSha. Stop before posting status, selecting a run, or merging."
  }
  Start-Sleep -Seconds 2
} while ($true)
Write-Output "head_advanced previous=$previousHeadSha final=$headSha polls=$headPollCount"

# 확인된 final head에만 status를 만들고 그 SHA의 Actions 완료까지 기다린다.
gh api --method POST repos/$repo/statuses/$headSha `
  -f state=success -f context=legacy-required -f description='THROWAWAY required status success'
do {
  $finalRunId = gh run list --repo $repo --workflow lifecycle.yml --commit $headSha `
    --limit 1 --json databaseId --jq '.[0].databaseId'
  if (-not $finalRunId) { Start-Sleep -Seconds 2 }
} until ($finalRunId)
gh run watch $finalRunId --repo $repo
gh run view $finalRunId --repo $repo --json headSha,status,conclusion,jobs --jq `
  '{headSha,status,conclusion,jobs:[.jobs[]|{name,status,conclusion}]}'
gh pr checks 1 --repo $repo --required

# admin에도 protection을 강제하면 미보고 required가 남은 동안 merge는 405다.
gh api --method POST repos/$repo/branches/main/protection/enforce_admins
gh api --include --method PUT repos/$repo/pulls/1/merge `
  -f merge_method=squash -f sha=$headSha
Write-Output "merge_with_never_starts_exit=$LASTEXITCODE"

# 누락됐던 단계: 초기 required set에서 never-starts를 제거한 뒤 같은 head를 merge한다.
gh api --method DELETE `
  repos/$repo/branches/main/protection/required_status_checks/contexts `
  -f 'contexts[]=never-starts'
gh api repos/$repo/branches/main/protection/required_status_checks --jq '{strict,contexts,checks}'
gh pr view 1 --repo $repo --json mergeable,mergeStateStatus,headRefOid
gh api --include --method PUT repos/$repo/pulls/1/merge `
  -f merge_method=squash -f sha=$headSha
gh api --method PATCH repos/$repo -F archived=true --jq '{full_name,archived,html_url}'
```

### [출력 발췌]

```json
{"strict":true,"contexts":["required-ci","optional-skip","legacy-required","never-starts"],"checks":[{"context":"required-ci","app_id":null},{"context":"optional-skip","app_id":null},{"context":"legacy-required","app_id":null},{"context":"never-starts","app_id":null}]}
```

```text
PR create response: mergeable=null mergeable_state=unknown updated_at=2026-08-23T04:28:07Z
first GET:          mergeable=null mergeable_state=unknown updated_at=2026-08-23T04:28:07Z
second GET:         mergeable=true mergeable_state=blocked updated_at=2026-08-23T04:28:07Z
```

```text
required-ci    REST status=in_progress conclusion=null
optional-skip  REST status=completed   conclusion=skipped
optional-fail  REST status=completed   conclusion=failure
legacy-required commit status state=pending
never-starts   required list에는 있으나 rollup/check-runs/statuses에는 row 없음
```

```text
gh pr checks --required while reported required-ci is pending:
required-ci       pending
optional-skip     skipping
legacy-required   pass
exit=8

gh pr checks --required before required-ci/optional-skip had reported, legacy-required only:
legacy-required   pass
exit=0
```

```text
final rollup before merge:
required-ci       COMPLETED/SUCCESS
optional-skip     COMPLETED/SKIPPED
optional-fail     COMPLETED/FAILURE    (optional)
legacy-required   SUCCESS              (commit status)
mergeable=MERGEABLE mergeStateStatus=UNSTABLE

merge API with enforce_admins=true:
merged=true message="Pull Request successfully merged"
```

```text
CheckStatusState: REQUESTED, QUEUED, IN_PROGRESS, COMPLETED, WAITING, PENDING
CheckConclusionState: ACTION_REQUIRED, TIMED_OUT, CANCELLED, FAILURE, SUCCESS, NEUTRAL, SKIPPED, STARTUP_FAILURE, STALE
```

```text
독립 재현 repository: https://github.com/dnhynk/THROWAWAY-orca-pr11-headpoll-6180d8
initial required contexts: required-ci, optional-skip, legacy-required, never-starts

previous_head=8ea532ad63f3e8c25c20310180cac79a9a809b36
expected_head=0fd0c73b04c17ec3be8958f60c517ba4af7db2cf
head_poll[1]=8ea532ad63f3e8c25c20310180cac79a9a809b36
head_poll[2]=0fd0c73b04c17ec3be8958f60c517ba4af7db2cf
head_advanced previous=8ea532ad63f3e8c25c20310180cac79a9a809b36 final=0fd0c73b04c17ec3be8958f60c517ba4af7db2cf polls=2

final head 0fd0c73b04c17ec3be8958f60c517ba4af7db2cf, Actions run 32620551511:
required-ci   completed/success
optional-skip completed/skipped
optional-fail completed/failure
legacy-required commit status success

gh pr checks --required:
required-ci       pass
optional-skip     skipping
legacy-required   pass

enforce_admins=true, never-starts가 required set에 남은 merge:
HTTP/2.0 405 Method Not Allowed
{"message":"Required status check \"never-starts\" is expected.","status":"405"}
merge_with_never_starts_exit=1

never-starts 제거 응답: ["required-ci","optional-skip","legacy-required"]
mergeable=MERGEABLE mergeStateStatus=UNSTABLE

같은 head의 merge 재시도:
HTTP/2.0 200 OK
{"sha":"1446c5ad3f969c63da9fbec659260993325746c8","merged":true,"message":"Pull Request successfully merged"}
repository archived=true
```

### [관측된 사실]

- [관측] check run은 REST에서 `status=in_progress, conclusion=null`로 진행 중을, `status=completed`와 `conclusion=failure|success|skipped`로 terminal 결과를 표현했다.
- [관측] GraphQL rollup은 같은 값을 대문자 enum으로 주고 commit status는 `__typename=StatusContext`, `context`, `state=PENDING|FAILURE|SUCCESS`로 분리했다.
- [문서] commit status의 가능한 state는 `error`, `failure`, `pending`, `success`다.
- [관측] required 여부는 check run/commit status row 자체에 없고 base branch protection의 `required_status_checks.contexts/checks`를 별도 조회해야 했다.
- [관측] required context가 아직 한 번도 보고되지 않으면 rollup에 placeholder row가 생기지 않았다.
- [관측] `gh pr checks --required`도 미보고 required context를 표시하지 않았고, 보고된 required row가 모두 pass인 순간에는 다른 required context가 미보고여도 exit `0`이었다.
- [추론] required 목록과 현재 head rollup의 set difference를 계산하지 않으면 미시작 check를 성공으로 오판할 수 있다.
- [관측] optional failure는 전체 rollup에 있었지만 `gh pr checks --required`에는 없었다.
- [관측] required success, required skipped, required commit-status success, optional failure 조합에서 GraphQL `mergeStateStatus=UNSTABLE`이었지만 admin protection까지 강제한 실제 merge API는 성공했다.
- [관측] 새 THROWAWAY의 final head에서 Actions로 위 check run 3개를 생성하고 commit status를 success로 만든 뒤에도, 미보고 `never-starts`가 admin-enforced required set에 남아 있으면 merge API는 `405 Required status check "never-starts" is expected`로 거절했다.
- [관측] 같은 head와 check 상태에서 `never-starts`만 required set에서 제거하자 `mergeStateStatus=UNSTABLE`이 됐고 merge API는 `200`, `merged=true`를 반환했다. 따라서 optional failure에도 merge 가능하다는 기존 결론은 독립 재현에서도 유지됐다.
- [관측] final content update 직후 첫 `gh pr view`는 PUT이 반환한 새 SHA가 아니라 이전 SHA를 반환했고, 2초 뒤 두 번째 조회에서 새 SHA로 수렴했다.
- [추론] 이 endpoint 간 stale read는 OD-044의 ordering·reconciliation에서도 head update와 후속 status/run을 단발 PR snapshot만으로 결합하면 안 된다는 근거다.
- [문서] protected branch의 required check는 `successful`, `skipped`, `neutral`이면 통과로 취급되며 check run과 commit status가 모두 required context가 될 수 있다.
- [관측] required-neutral live PR은 찾은 공개 표본에 없었고 THROWAWAY에서 직접 만들지 못했다.
- [실행하지 않음] 현재 자격증명은 GitHub App `checks:write`가 아니므로 neutral check run 생성은 시도하지 않았다.
- [문서] neutral의 API 표현은 completed check run의 `conclusion=neutral`이며 GraphQL schema는 `status=COMPLETED`, `conclusion=NEUTRAL`을 제공한다.
- [관측] classic branch protection required list는 `GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks`에서 `strict`, `contexts`, `checks[].app_id`까지 반환했다.
- [문서] fine-grained token에는 이 GET을 위해 repository `Administration: read`, 설정 변경에는 `Administration: write`가 필요하다.
- [관측] classic `repo` scope인 소유자 토큰으로 THROWAWAY 조회/설정은 성공했지만 `cli/cli`의 review protection GET은 `404`여서 타인 repository의 상세 정책은 읽지 못했다.
- [문서] ruleset을 사용하는 repository는 classic protection과 별도인 [repository rules API](https://docs.github.com/en/rest/repos/rules)도 고려해야 한다.
- [문서] REST `mergeable=null`은 계산 background job이 시작됐다는 뜻이며 잠시 뒤 같은 GET을 재시도해야 한다.
- [관측] 실제로 첫 두 응답은 `null/unknown`, 다음 응답은 같은 `updated_at`에서 `true/blocked`로 바뀌었다.
- [관측] `mergeable=true`는 changes-requested나 required-check failure를 막지 않았고 merge conflict 가능 여부와 정책 충족 여부가 다른 축임을 확인했다.
- [추론] `mergeStateStatus`는 유용한 요약이지만 `UNSTABLE`인 PR도 optional failure뿐이면 merge 가능하므로 단독 merge-ready boolean이 아니다.

### [추가 관측] ruleset 표본 (2026-08-23, C2-2 구현 중)

[관측] 위 §9의 `[관측 불가] ruleset ... 권한이 없어 조회하지 못했다`는 표본 부재였다. 같은 scope
(`gist`, `read:org`, `repo`, `workflow`)의 토큰으로 `dnhynk/dev-infra`의 두 정책 API가 모두 읽혔다.

```powershell
gh api repos/dnhynk/dev-infra/branches/main/protection   # 404 {"message":"Branch not protected"}
gh api repos/dnhynk/dev-infra/rulesets                   # []
```

[관측] ruleset이 실제로 적용된 표본을 만들기 위해 `dnhynk/THROWAWAY-orca-c2-ruleset-11c46c2b`에
classic protection과 repository ruleset을 **동시에** 걸고 PR `#1`의 head에 commit status 3개만 만들었다.

```powershell
$repo = 'dnhynk/THROWAWAY-orca-c2-ruleset-11c46c2b'
'{"required_status_checks":{"strict":false,"contexts":["classic-passing","classic-failing"]},"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null}' |
  gh api --method PUT repos/$repo/branches/main/protection --input -
# ruleset: target=branch, refs/heads/main, required_status_checks = ruleset-pending, ruleset-missing
gh api --method POST repos/$repo/rulesets --input ruleset.json

gh api repos/$repo/rules/branches/main
gh api repos/$repo/branches/main/protection/required_status_checks
gh pr view 1 --repo $repo --json headRefOid,mergeable,mergeStateStatus,statusCheckRollup,reviews
gh pr checks 1 --repo $repo --required
```

```text
rules/branches/main:
[{"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":false,
  "do_not_enforce_on_create":false,"required_status_checks":[{"context":"ruleset-pending"},
  {"context":"ruleset-missing"}]},"ruleset_source_type":"Repository",
  "ruleset_source":"dnhynk/THROWAWAY-orca-c2-ruleset-11c46c2b","ruleset_id":21233618}]

protection/required_status_checks:
{"strict":false,"contexts":["classic-passing","classic-failing"],
 "checks":[{"context":"classic-passing","app_id":null},{"context":"classic-failing","app_id":null}]}

statusCheckRollup (head 41326a121680602f736d39ced9f6a4990f949c0a):
{"__typename":"StatusContext","context":"classic-failing","state":"FAILURE"}
{"__typename":"StatusContext","context":"ruleset-pending","state":"PENDING"}
{"__typename":"StatusContext","context":"classic-passing","state":"SUCCESS"}
mergeable=MERGEABLE mergeStateStatus=BLOCKED

gh pr checks 1 --required:
classic-failing  fail
ruleset-pending  pending
classic-passing  pass
exit=1
```

- [관측] `rules/branches/{branch}`는 ruleset이 준 required context만 반환했고 classic protection의
  `classic-passing`/`classic-failing`은 포함하지 않았다. 두 API는 서로를 포함하지 않는다.
- [관측] 반대로 `protection/required_status_checks`에는 ruleset이 준 두 context가 없었다.
- [관측] 한 번도 보고되지 않은 `ruleset-missing`은 rollup에도 `gh pr checks --required`에도 없었다.
  ruleset 경로에서도 미보고 required는 §OD-032 본문의 classic 경로와 같게 보이지 않는다.
- [관측] `cli/cli` trunk에서는 `rules/branches/trunk`가 `200`으로 `copilot_code_review` rule을 반환했고
  같은 시각 `branches/trunk/protection/required_status_checks`는 `404 Not Found`였다. rules API는 admin이
  아니어도 읽히고 protection GET은 그렇지 않다.
- [관측] `protection/required_status_checks`의 `404`는 소유 repository에서 `Branch not protected`,
  타인 repository에서 `Not Found`였다. 미설정과 권한 없음을 이 응답만으로 구분할 수 없다.
- [관측] 이 repository는 관측 뒤 archive했다.
- [실행하지 않음] merge queue가 적용된 표본은 만들지 않았고 merge queue rule은 조회하지 않았다.

### [배제되는 선택지]

- [추론] 현재 `statusCheckRollup`만 읽어 required/optional을 판정하는 선택지는 배제된다.
- [추론] `gh pr checks --required` exit code만 gate로 쓰는 선택지는 미보고 required context를 놓치므로 배제된다.
- [추론] 모든 check가 success여야 merge-ready라는 선택지는 required `skipped` 허용과 optional failure 상태의 실제 merge에 반하므로 배제된다.
- [추론] `mergeable=true` 또는 `mergeStateStatus in {CLEAN}` 하나만 merge-ready로 쓰는 선택지는 배제된다.
- [추론] `mergeable=null`을 conflict 또는 failure로 terminal 처리하는 선택지는 배제된다.

### [남는 선택지]

- [추론] current head별 rollup과 base branch의 effective required rule을 조인해 missing/pending/failing/passing을 파생하는 선택지가 남는다.
- [추론] classic branch protection만 지원하고 ruleset repository를 명시적으로 degraded 처리하는 범위와 두 정책 API를 모두 지원하는 범위가 남는다.
- [추론] merge queue, required reviews, up-to-date(strict), conversation resolution까지 포함한 merge-ready 정책 범위를 사용자가 정해야 한다.
- [권장(미확정)] check row는 `CheckRun`/`StatusContext` 종류, 이름/context, id, head SHA, status, conclusion/state, 시작·완료 시각을 보존하고 required 판정은 별도 rule snapshot에서 파생하는 편이 관측 손실이 적다.

## OD-044 · event idempotency와 out-of-order

### [실행한 명령]

```powershell
# 같은 PR REST snapshot 10회
$prSamples = 1..10 | ForEach-Object {
  $p = gh api repos/dnhynk/THROWAWAY-orca-github-lifecycle-bc06/pulls/1 | ConvertFrom-Json
  [pscustomobject]@{
    id=$p.id; node_id=$p.node_id; updated_at=$p.updated_at; head_sha=$p.head.sha
    state=$p.state; merged=$p.merged; mergeable=$p.mergeable; mergeable_state=$p.mergeable_state
  }
}
$prSamples | Group-Object id,node_id,updated_at,head_sha,state,merged,mergeable,mergeable_state |
  Select-Object Count,Name

# 같은 head check runs 6회
$checkSamples = 1..6 | ForEach-Object {
  $r = gh api repos/dnhynk/THROWAWAY-orca-github-lifecycle-bc06/commits/ed617a01fc66ec4cf7849b2f1ac23d819dd557f3/check-runs | ConvertFrom-Json
  (($r.check_runs | Sort-Object name | ForEach-Object {
    "$($_.id):$($_.name):$($_.status):$($_.conclusion)"
  }) -join '|')
}
$checkSamples | Group-Object | Select-Object Count,Name

# push 직후 body PATCH response와 바로 뒤 GraphQL snapshot 비교
git push
gh api --method PATCH repos/dnhynk/THROWAWAY-orca-github-lifecycle-bc06/pulls/1 `
  -f body="<!-- orca-run: run_THROWAWAY -->`n<!-- orca-task: task_THROWAWAY_two -->`n<!-- orca-dispatch: ctx_THROWAWAY_two -->"
gh pr view 1 --repo dnhynk/THROWAWAY-orca-github-lifecycle-bc06 --json headRefOid,updatedAt

# 동일 context의 commit status history
gh api repos/dnhynk/THROWAWAY-orca-github-lifecycle-bc06/commits/2cba3aff11cb6b003fd32212e804557c080300dd/statuses --paginate

# timeline event type별 identity/time field 재조회
gh api repos/dnhynk/THROWAWAY-orca-pr11-od032-71b6/issues/1/timeline --paginate --jq `
  '[.[]|{event,id,node_id,created_at,submitted_at,commit_date:.committer.date}]'
gh api repos/cli/cli/issues/14136/timeline --paginate --jq `
  '[.[]|select(.event=="reviewed")|{event,id,node_id,created_at,submitted_at}] | .[0]'
```

### [출력 발췌]

```text
REST PR snapshot 10회: 1개 group, count=10
id=4340854005
node_id=PR_kwDOUBInC88AAAABArws9Q
updated_at=2026-08-23T04:29:33Z
head=ed617a01...
state=open merged=false mergeable=true mergeable_state=unstable
```

```text
check snapshot 6회: 1개 group, count=6
97141729519 required-ci   completed/success
97141729588 optional-fail completed/failure
97141729939 optional-skip completed/skipped
```

```text
push 후 PATCH response at updated_at=2026-08-23T04:29:33Z: head_sha=2cba3aff... (이전 head)
바로 뒤 gh pr view at updatedAt=2026-08-23T04:29:33Z: headRefOid=ed617a01... (새 head)
```

```text
required-ci check id 97141729519: in_progress/null → 같은 id로 completed/success
old head legacy-required status: id 52728921646 pending → 새 id 52728926249 failure
```

```text
timeline field 재조회:
committed id=null node_id=C_kwDOUBJ6rdoAKDhkMWJlZDUzNGFmM2ZjOGZlNTc3ZjYwOTQ0NmIxNGZlOWU3NTJiZjE
          created_at=null submitted_at=null commit_date=2026-08-23T05:07:51Z
merged    id=29864308585 node_id=ME_lADOUBJ6rc8AAAABN3WTQc8AAAAG9A0vaQ
          created_at=2026-08-23T05:10:18Z submitted_at=null commit_date=null
reviewed  id=4926001186 node_id=PRR_kwDODKw3uc8AAAABJZzQIg
          created_at=null submitted_at=2026-08-13T10:30:25Z commit_date=null
```

### [관측된 사실]

- [관측] 안정된 구간의 짧은 반복 조회에서는 PR snapshot 10회와 check snapshot 6회가 역행하거나 달라지지 않았다.
- [관측] 이 bounded sample은 eventual consistency가 항상 없다는 보장은 아니다.
- [관측] push 직후 PR body PATCH 응답은 `updated_at`이 새 시각인데 head는 이전 SHA였고 바로 뒤 GraphQL은 같은 updatedAt에서 새 SHA를 줬다.
- [관측] 하나의 API 응답도 서로 다른 계산/cache 시점의 필드를 섞을 수 있음을 직접 봤다.
- [관측] `mergeable`은 `null→true`로 바뀌었지만 PR `updated_at`은 그대로였고 check run이 in-progress→completed로 바뀌어도 PR `updated_at`은 그대로였다.
- [관측] merge 뒤 remote head 삭제·protection 삭제·repository archive 정리를 마친 후 PR 의미 상태는 그대로 `MERGED`인데 `updated_at`은 `04:38:03Z→04:38:36Z`로 바뀌어 있었다.
- [추론] 세 cleanup write를 분리 관측하지 않았으므로 어느 write가 timestamp를 바꿨는지는 확정할 수 없다.
- [추론] PR `updated_at`은 PR resource의 change marker일 뿐 review/check/mergeability 전체의 엄격한 version이 아니다.
- [관측] PR 숫자 `id`와 `node_id`는 모든 snapshot에서 안정적이었지만 값 자체는 순서를 표현하지 않았다.
- [관측] review `id`는 review identity로 안정적이지만 dismissal은 같은 review id의 state를 `DISMISSED`로 바꾸므로 event version이 아니다.
- [관측] check run id는 한 run의 진행→완료 동안 유지됐고 새 head의 새 run에는 새 id가 생겼다.
- [관측] commit status는 같은 head/context의 pending→failure마다 새 id가 생겼고 list endpoint는 둘을 최신순으로 보존했다.
- [관측] head SHA는 head version 경계로 쓸 수 있지만 값의 대소/사전순은 시간 순서가 아니다.
- [관측] timeline의 `merged`/`closed` row는 `id`, `node_id`, `created_at`을 줬지만, `reviewed` row는 `id`와 `node_id`가 있으면서 `created_at=null`이고 `submitted_at`을 썼다. `committed` row는 `node_id`, `sha`, `committer.date`를 주지만 `id=null`, `created_at=null`이었다.
- [추론] 공통 timestamp field가 없을 뿐 아니라 `committed`에는 공통 numeric `id`도 없으므로, 모든 GitHub resource를 가로지르거나 timeline 전체에 적용되는 단일 monotonic sequence key는 관측되지 않았다.
- [추론] `mergedAt != null`/GraphQL `state=MERGED`는 GitHub에서 되돌릴 수 없는 terminal fact이므로 이를 한 번 저장한 PR은 오래된 open/closed snapshot으로 downgrade하지 않는 latch가 C2 출구 조건을 직접 만족한다.
- [추론] nonterminal 전이는 PR identity와 head SHA를 먼저 scope로 나누고, resource별 identity(`id`/`node_id`/SHA)와 event type별 timestamp(`created_at`/`submitted_at`/commit date) 또는 status를 써야 한다.

### [배제되는 선택지]

- [추론] `updated_at` 하나로 PR, review, check, mergeability를 모두 last-write-wins 처리하는 선택지는 배제된다.
- [추론] `node_id`, review id, check run id를 순서 key로 쓰는 선택지는 이들이 identity이고 mutable resource의 version이 아니므로 배제된다.
- [추론] SHA 문자열 정렬로 head 순서를 정하는 선택지는 배제된다.
- [추론] 전체 상태를 한 선형 rank로 만들어 `closed > open`으로 두는 선택지는 reopen을 막으므로 배제된다.

### [남는 선택지]

- [추론] `(repository databaseId, PR number)`를 identity로, `mergedAt`을 terminal latch로, `headSha`를 review/check scope로 쓰는 선택지가 남는다.
- [추론] resource별 event identity를 보존하면서 semantic snapshot fingerprint로 thread 중복을 제거하는 선택지가 남는다.
- [추론] webhook을 추가한다면 delivery id를 transport dedupe에 쓰고 polling reconciliation으로 최종 사실을 확인하는 선택지가 남지만 이번 Task에서는 webhook을 실행하지 않았다.
- [권장(미확정)] `merged` downgrade 금지는 timestamp 비교보다 terminal dominance rule로 명시하고, 동일 head 안의 review/check는 각 resource timestamp와 id로 reconcile하는 편이 관측과 맞는다.

## OD-046 · GitHub 이력으로 카드 재구성 가능한가

### [실행한 명령]

```powershell
gh api repos/cli/cli/issues/14215/timeline --paginate --jq `
  '[.[]|{id,node_id,event,created_at,commit_id}]'
gh api repos/cli/cli/pulls/14222/commits --paginate --jq `
  '[.[]|{sha,committed:.commit.committer.date,message:(.commit.message|split("\n")[0])}]'
gh api repos/cli/cli/pulls/14222/reviews --paginate --jq `
  '[.[]|{id,node_id,user:.user.login,state,commit_id,submitted_at}]'

# THROWAWAY PR을 merge한 뒤 GraphQL history 재조회
gh api graphql -F owner=dnhynk -F name=THROWAWAY-orca-github-lifecycle-bc06 -F number=1 `
  -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){state mergedAt body userContentEdits(first:20){totalCount nodes{id editedAt diff}} commits(first:20){totalCount nodes{commit{oid message}}} reviews(first:20){totalCount nodes{id state commit{oid}}} timelineItems(first:100){totalCount}}}}'
```

### [출력 발췌]

```text
merged cli/cli#14222 commits endpoint: 3 commits retained
merged cli/cli#14222 reviews endpoint: COMMENTED + APPROVED retained
merged cli/cli#14222 timeline: merged event + closed event retained
```

```text
merged THROWAWAY#1
state=MERGED mergedAt=2026-08-23T04:38:03Z
userContentEdits.totalCount=2
commits.totalCount=2
reviews.totalCount=0
timelineItems.totalCount=5
```

### [관측된 사실]

- [관측] merged PR에서도 current PR body/state, PR commit 목록, review 목록, timeline을 다시 읽을 수 있었다.
- [관측] timeline에는 draft/ready, review, dismissal, force-push, merged, closed 같은 전이가 event id와 시각으로 남았다.
- [관측] review history는 별도 reviews endpoint, commit message/trailer는 별도 commits endpoint를 합쳐야 했다.
- [관측] body edit는 REST timeline의 event로 나오지 않았지만 GraphQL `userContentEdits`가 edit별 node id, editedAt, diff를 반환했다.
- [관측] dismissed review의 현재 reviews row만으로 사라진 원래 verdict는 timeline의 `review_dismissed.dismissed_review.state`를 합쳐 복구할 수 있었다.
- [문서] REST timeline과 reviews/commits는 pagination 대상이므로 첫 page만 읽으면 전체 이력이 아니다.
- [문서] GitHub [status check 데이터 보존](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-status-checks#retention-of-checks)은 400일 뒤 archive되고 그 뒤 10일 후 삭제된다.
- [추론] 현재 카드와 최근 주요 transition을 다시 만드는 데 필요한 GitHub 사실은 표본에서 남아 있었다.
- [추론] 모든 과거 check snapshot과 모든 중간 semantic transition을 영구히 처음부터 재생할 수 있다는 보장은 없으며 check retention이 명시적 반례다.
- [추론] body edit history의 존재는 관측했지만 보존 기간과 exact replay 완전성은 문서에서 확인하지 못했다.
- [추론] 카드 재생성은 current snapshot + 필요한 paginated history로 가능하지만 Bridge가 이미 발행한 semantic transition의 영구 event store를 GitHub가 대신한다고 볼 수 없다.

### [배제되는 선택지]

- [추론] REST PR current object 하나만으로 이전 review/draft/check 전이를 모두 복구하는 선택지는 배제된다.
- [추론] REST timeline 하나만으로 body edit와 commit trailer까지 복구하는 선택지는 배제된다.
- [추론] GitHub history가 무기한 완전하다고 가정해 Bridge durable transition state를 두지 않는 선택지는 배제된다.

### [남는 선택지]

- [추론] Slack root card 유실 시 GitHub current snapshot, Orca facts, Bridge store identity로 current card만 재생성하는 선택지가 남는다.
- [추론] thread의 과거 semantic transition까지 복구하려면 GitHub paginated history를 best-effort로 재해석하는 선택지와 Bridge가 semantic transition을 durable하게 저장하는 선택지가 남는다.
- [권장(미확정)] current card 재구성과 과거 thread 완전 재생을 별도 복구 수준으로 정의해야 한다.

## OD-076 · PR 1 : Task N의 GitHub 단서

### [실행한 명령]

```powershell
# 서로 다른 trailer를 가진 두 commit을 같은 THROWAWAY PR에 push
git commit -m 'test: force required check failure' -m 'Orca-Task: task_THROWAWAY_one'
git commit -m 'test: make required check succeed' -m 'Orca-Task: task_THROWAWAY_two'

gh api repos/dnhynk/THROWAWAY-orca-github-lifecycle-bc06/pulls/1/commits --paginate --jq `
  '[.[]|{sha,message:.commit.message}]'
gh api graphql -F owner=dnhynk -F name=THROWAWAY-orca-github-lifecycle-bc06 -F number=1 `
  -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){body userContentEdits(first:20){totalCount nodes{id editedAt diff}}}}}'
gh api repos/dnhynk/THROWAWAY-orca-github-lifecycle-bc06/issues/1/timeline --paginate --jq `
  '[.[]|{id,node_id,event,created_at,commit_id}]'

rg -n 'orca-task|duplicates|task_missing' `
  apps/orca-slack-bridge/src/correlate `
  apps/orca-slack-bridge/src/digest
```

### [출력 발췌]

```text
2cba3aff... message trailer: Orca-Task: task_THROWAWAY_one
ed617a01... message trailer: Orca-Task: task_THROWAWAY_two
merged 뒤에도 PR commits endpoint에서 두 trailer가 모두 조회됨
```

```text
userContentEdits #1 at 04:28:07Z: <!-- orca-run: run_THROWAWAY -->
userContentEdits #2 at 04:29:33Z: run + task_THROWAWAY_two + dispatch_THROWAWAY_two
current body: task_THROWAWAY_two만 포함
REST timeline: committed event 2개, body-edited event 없음
```

### [관측된 사실]

- [관측] current PR body는 한 `orca-task`만 가리켰지만 같은 PR의 두 commit message에 서로 다른 Task trailer를 넣어 merge 후에도 둘 다 조회할 수 있었다.
- [관측] GraphQL `userContentEdits`는 이전 run-only body와 이후 task-bearing body snapshot을 둘 다 반환했다.
- [추론] 이전 body에 Task id가 있었다면 edit history가 그 흔적을 제공할 가능성은 높지만 이번 실험은 Task1을 이전 body에 쓰지 않았으므로 그 조합을 직접 관측한 것은 아니다.
- [관측] REST timeline의 `committed` event는 commit message/trailer를 싣지 않아 commits endpoint join이 필요했다.
- [관측] 현재 adapter parser는 current body만 읽고, 같은 metadata key에 서로 다른 값이 두 개 있으면 `conflict`로 만든다.
- [관측] 현재 adapter는 PR commits, `userContentEdits`, body history를 correlation source로 조회하지 않는다.
- [추론] commit trailer는 Task N 이력의 GitHub 단서가 될 수 있지만 worker가 빠뜨리거나 사용자가 임의 작성할 수 있고 force-push/squash 전에는 PR commit 집합이 바뀔 수 있다.
- [추론] body edit history는 유용한 감사 단서지만 REST가 아니라 GraphQL 전용이고 보존/완전성 계약을 확인하지 못했다.

### [배제되는 선택지]

- [추론] current body의 단일 `orca-task`만으로 PR 1 : Task N 전체 이력을 복원한다는 선택지는 배제된다.
- [추론] 서로 다른 `orca-task` comment를 current body에 단순 누적하는 선택지는 현 parser가 conflict로 처리하므로 배제된다.
- [추론] REST timeline만으로 Task trailer/body edit 이력을 복원하는 선택지는 배제된다.
- [추론] commit trailer나 body edit history를 검증 없이 authoritative correlation로 승격하는 선택지는 신뢰성과 retention 근거가 부족하므로 배제된다.

### [남는 선택지]

- [추론] current body는 primary/latest Task 하나만 유지하고 Bridge durable store에 PR↔Task N association을 별도로 저장하는 선택지가 남는다.
- [추론] 표준 commit trailer를 의무화해 GitHub-side audit clue로 쓰되 authoritative mapping은 별도 저장하는 선택지가 남는다.
- [추론] body metadata schema 자체를 Task 목록으로 바꾸고 parser 계약을 개정하는 선택지가 남는다.
- [추론] GraphQL body edit history를 migration/recovery용 best-effort source로만 쓰는 선택지가 남는다.

## OD-077 · run-only correlation의 실제 경로

### [실행한 명령]

```powershell
# 실제 dev-infra PR에서 run-only 검색
gh pr list --repo dnhynk/dev-infra --state all --limit 100 `
  --json number,state,title,body,url `
  --jq '[.[]|select((.body|contains("orca-run:")) and ((.body|contains("orca-task:"))|not))]'

# GitHub가 run-only body를 허용하는지 THROWAWAY에서 생성
gh api --method POST repos/dnhynk/THROWAWAY-orca-github-lifecycle-bc06/pulls `
  -f title='THROWAWAY lifecycle probe' -f head=probe -f base=main `
  -f body='<!-- orca-run: run_THROWAWAY -->'

rg -n 'run만 있으면 correlated|task_missing|metadata.taskId' `
  apps/orca-slack-bridge/src/correlate/resolve.ts `
  apps/orca-slack-bridge/src/digest/project.ts `
  apps/orca-slack-bridge/src/digest/types.ts `
  apps/orca-slack-bridge/test/correlate.test.ts `
  apps/orca-slack-bridge/test/project.test.ts
```

### [출력 발췌]

```text
dnhynk/dev-infra: orca-run이 있는 PR #1~#9는 모두 orca-task와 orca-dispatch도 있음
run-only query result: []
```

```text
THROWAWAY PR create: HTTP success, body에는 orca-run만 존재
GraphQL body edit #1: <!-- orca-run: run_THROWAWAY -->
```

```text
resolve.ts: run이 존재하고 taskId가 null이면 kind='correlated', task=null
project.ts: !isCorrelatedOrigin(correlation) → skipped(reason='task_missing')
existing test name: 'run만 있으면 correlated'
existing test name: 'correlated지만 task가 없으면 task_missing이다'
```

### [관측된 사실]

- [관측] GitHub는 body metadata schema를 검증하지 않으므로 run-only PR을 정상 생성했다.
- [관측] 실제 `dnhynk/dev-infra`의 metadata-bearing PR 9개에는 run-only 사례가 없었다.
- [관측] repository 안에는 PR body 생성기가 없고 worker 계약만 run/task 필수 형식을 요구한다.
- [관측] parser는 `runId`가 live Run이면 `taskId=null`이어도 `correlated`로 반환한다.
- [관측] downstream projection은 Task 목적과 `worker_done`을 찾을 수 없으므로 `task_missing`으로 카드를 skip한다.
- [실행하지 않음] Task 지시대로 dependency 설치와 test/build를 하지 않았으므로 기존 unit test는 이번 세션에서 재실행하지 않았다.
- [추론] 현재 정상 자동 경로에서 run-only를 생성해야 할 이유는 찾지 못했다.
- [추론] 실제 발생 경로는 수동/외부 PR 작성, worker의 metadata 일부 누락, 사람의 body edit, 과거 schema migration 같은 malformed 또는 partial input이다.
- [추론] PR body update는 한 PATCH이므로 Bridge가 run comment를 먼저 쓰고 task comment를 나중에 쓰는 정상적인 partial-write window는 현재 repository 코드에서 관측되지 않았다.

### [배제되는 선택지]

- [추론] run-only를 완전한 Task correlation로 취급해 Task 목적/worker report를 추측하는 선택지는 배제된다.
- [추론] branch명, title, commit author로 누락 Task를 자동 보완하는 선택지는 기존 no-guessing 계약과 충돌하므로 배제된다.
- [추론] run-only가 GitHub에서 발생할 수 없다고 가정하는 선택지는 THROWAWAY 생성으로 배제된다.

### [남는 선택지]

- [추론] `uncorrelated(reason='task_missing')`로 승격해 correlation layer에서 거부하는 선택지가 남는다.
- [추론] 현재처럼 `correlated + task:null`을 유지하고 projection에서 `task_missing`으로 skip하는 선택지가 남는다.
- [추론] 별도 `run_correlated` kind를 만들어 Run-level 카드만 허용하는 선택지가 남는다.
- [권장(미확정)] OD-021이 task를 필수로 이미 정했으므로 C2가 Task card를 만들 때는 run-only를 invalid/degraded input으로 명시하고, 별도 Run-only 제품 의미가 필요할 때만 새 kind를 도입하는 편이 현재 근거와 맞는다.

## 8. 기존 adapter와 C2 추가 조회 경계

| 영역 | 현재 `apps/orca-slack-bridge/src/github/` | C2에 새로 필요한 후보 |
|---|---|---|
| PR terminal/draft | [관측] `state`, `isDraft`, `mergedAt`, `headRefOid` | [추론] `closedAt`, `updatedAt`, `mergeable`, `mergeStateStatus`; merged terminal latch |
| review | [관측] `reviewDecision`, reviews의 개수만 저장 | [추론] review `id/node_id`, author, state, `commit_id`, `submitted_at`; dismissal timeline 또는 Orca `reviewer_result` history |
| checks | [관측] rollup의 name/status/conclusion만 저장 | [추론] `__typename`, check/status id, context, app/source, head SHA, started/completed time; base branch effective required list; missing required set |
| history | [관측] 조회하지 않음 | [추론] paginated timeline/reviews/commits, 필요 시 GraphQL `userContentEdits` |
| correlation | [관측] current body의 단일 run/task/dispatch만 파싱 | [추론] PR↔Task N durable association 또는 명시적 새 body schema |

[관측] 현재 `listPullRequests()`의 `statusCheckRollup`은 존재하는 row만 가져오므로 미보고 required context를 발견할 수 없다.

[관측] 현재 adapter는 mergeability, required rule, review detail, timeline, commit history를 전혀 조회하지 않는다.

[추론] C2 최소 증분은 current snapshot 필드 확장만이 아니라 base branch policy 조회와 head-scoped check/review detail 조회를 포함해야 한다.

## 9. 관측 불가·실험 정리·검증

- [관측 불가] required-neutral의 live PR 조합은 공개 표본에서 찾지 못했고 GitHub App `checks:write`가 없어 직접 생성하지 않았다.
- [관측 불가] 같은 API의 응답이 네트워크 out-of-order로 도착하는 장시간/고동시성 경우는 실행하지 않았고, 대신 push 직후 서로 다른 endpoint에서 stale head snapshot이 섞인 경우를 관측했다.
- [관측 불가] GraphQL `userContentEdits`와 timeline/reviews/commits의 무기한 retention 보장은 문서에서 확인하지 못했다.
- [관측 불가] ruleset과 merge queue가 실제로 적용된 repository의 상세 required rule은 권한이 없어 조회하지 못했다. — SUPERSEDED (ruleset 부분은 §OD-032 추가 관측에서 반증됐다. 권한 부족이 아니라 표본 부재였다.)
- [관측 불가] merge queue가 적용된 repository의 상세 rule은 그런 repository 표본을 만들지 않아 여전히 조회하지 않았다.
- [관측] THROWAWAY PR `#1`은 merge했고 remote `probe` branch와 classic branch protection을 삭제했다.
- [관측] repository 삭제는 token에 `delete_repo` scope가 없어 HTTP `403`으로 거부됐다.
- [관측] scope를 넓히지 않고 `dnhynk/THROWAWAY-orca-github-lifecycle-bc06`를 public archived 상태로 남겼다.
- [관측] 시스템 temp clone `C:\Users\dongh\AppData\Local\Temp\THROWAWAY-orca-github-lifecycle-bc06` 삭제는 안전 정책이 두 차례 명령 실행 전에 거부해 남아 있다.
- [관측] repository 안에는 이 문서 한 파일만 추가했고 다른 tracked 파일은 수정하지 않았다.
- [실행하지 않음] `pnpm install`, test, build는 Task 공통 규칙에 따라 실행하지 않았다.
