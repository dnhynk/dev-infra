# dev-infra 문서 인덱스

상태: **AB Claude 경로 완료 · Codex `$init-orchestrate`/rollover/Gate wake hermetic 구현·Windows Bridge 배포·Astra worker 수용 완료 · C1~D3·O1 구현 완료 · O1-7 production acceptance PASS · Claude D3는 `LIVE_CHANNEL_UNVERIFIED` 유지 · Codex Slack Gate wake·rollover live acceptance 완료**
기준일: **2026-09-08**

이 디렉터리는 1인 개발자가 Orca IDE의 병렬 Agent orchestration을 더 적은 수동 개입으로 운영하기 위한 개인 Agentic Development Infrastructure의 현재 기준 문서다. C1 PR Digest의 구현·검증 결과와 후속 slice의 아직 열린 계약을 함께 보존한다.

## 문서 읽기 순서

1. [작업 규약](process/working-agreement.md)
2. [제품 비전과 전체 범위](product-vision.md)
3. [`/init-orchestrate`와 컨텍스트 승계 스펙](specs/orchestration-bootstrap-and-continuity.md)
4. [`orca-slack-bridge` umbrella 스펙](specs/orca-slack-bridge.md)
5. [Bridge 시스템 구조](architecture/orca-slack-bridge.md)
6. [관찰·상관관계 계약](contracts/observation-and-correlation.md)
7. [Slack 메시지 UX](ux/slack-surfaces.md)
8. [구현 로드맵](roadmap.md)
9. [확정 결정 기록](decision-log.md)
10. [미결정 사항](open-decisions.md)
11. [검증된 플랫폼 역량과 제약](platform-capabilities.md)
12. [Slack App 준비 절차](ops/slack-app-setup.md)
13. [Claude Channel Adapter 운영·live acceptance](ops/channel-adapter-acceptance.md)
14. [Codex coordinator 설치·acceptance](ops/codex-coordinator-setup.md)
15. [Windows current-user 자동 시작 운영](ops/windows-startup.md)
16. [요구사항 추적표](traceability.md)
17. [Phase 0/D3 실측 증거](evidence/) — 한시적. Gate에서 canonical 문서로 흡수한 뒤 삭제한다

## 문서 권위와 표기

충돌 시 다음 순서로 해석한다.

1. 사용자가 명시적으로 확정한 최신 결정
2. 최신 사용자 결정을 시간순으로 옮긴 [확정 결정 기록](decision-log.md)
3. 프로젝트에 적용되는 `AGENTS.md` 및 [작업 규약](process/working-agreement.md)
4. 아래 주제별 canonical 문서
5. 예시, 후보 기술, 향후 아이디어

같은 주제의 결정이 바뀌면 최신 사용자 결정이 이전 기록을 대체한다. `decision-log.md`에는 새 결정을 추가하고 대체된 결정에 `SUPERSEDED`를 표시해야 한다.

| 주제 | Canonical 문서 |
|---|---|
| 사용자 확정 결정 | [확정 결정 기록](decision-log.md) |
| 협업·변경·디버깅·검증 절차 | [작업 규약](process/working-agreement.md) |
| 문제·제품 목표·설계 철학 | [제품 비전](product-vision.md) |
| 기능 범위와 normative 행동 | [`/init-orchestrate` 스펙](specs/orchestration-bootstrap-and-continuity.md), [Bridge 스펙](specs/orca-slack-bridge.md) |
| 컴포넌트·프로세스·장애 경계 | [Bridge 구조](architecture/orca-slack-bridge.md) |
| entity·correlation·상태 의미 | [관찰·상관관계 계약](contracts/observation-and-correlation.md) |
| Slack 정보 구조와 문구 예시 | [Slack UX](ux/slack-surfaces.md) |
| 잠정 작업 순서와 size gate | [로드맵](roadmap.md) |
| 아직 답하지 않은 선택 | [미결정 사항](open-decisions.md) |
| 버전 의존 외부 사실 | [플랫폼 검증](platform-capabilities.md) |

[요구사항 추적표](traceability.md)는 감사용 색인이며 새로운 요구사항을 만들지 않는다.

`docs/evidence/`는 C2·D1·D2·D3의 미결정을 닫기 위해 수집한 실측 기록이며 normative source가 아니다. 사용자 결정 후 [플랫폼 검증](platform-capabilities.md)과 [미결정 사항](open-decisions.md)으로 흡수하고 디렉터리를 삭제한다.

문서의 상태 표기는 다음 의미를 가진다.

- **Draft**: 문서 전체에 아직 TBD가 남아 있어 구현 계약이 완전히 닫히지 않았다는 뜻이다. Draft 안에서 `확정`으로 표시된 사용자 요구까지 임의로 바꿀 수 있다는 뜻은 아니다.
- **확정**: 구현자가 임의로 바꾸거나 추측으로 대체하면 안 되는 요구사항
- **TBD**: 빌드 과정에서 관측과 사용자 판단을 통해 구체화할 사항
- **후속**: 최종 비전에는 포함되지만 현재 핵심 구현 이후에 다룰 사항
- **검증 필요**: 외부 제품 버전이나 실제 통합 환경에서 다시 확인해야 하는 주장
- **Open**: 미결정 장부에서 아직 사용자 결정이 없는 항목
- **Draft audit**: 추적표가 현재 문서 snapshot을 감사한 결과이며 normative source가 아님

예시 JSON, CLI, Slack 문구는 의도를 구체화하지만, 별도로 `확정 계약`이라고 표시되지 않은 한 필드명·명령 문법·문구 자체를 고정하지 않는다.

## 현재 확정된 작업 순서

- `/init-orchestrate`와 컨텍스트 열화·handoff lifecycle은 하나의 workstream으로 다룬다.
- 나머지 `orca-slack-bridge` 범위는 실제 크기와 위험을 확인한 뒤 독립적으로 검증 가능한 슬라이스로 나눈다.
- 구현 stack은 TypeScript on Node.js 26.x와 pnpm workspaces로 확정했으며 별도 monorepo 빌드 오케스트레이터는 두지 않는다. summarizer는 OpenAI API를 사용하고 기본 모델은 설정으로 교체 가능한 `gpt-5.6-luna`다.
- 미정 사항은 구현자가 조용히 채우지 않고 [미결정 사항](open-decisions.md)에 기록해 빌드 과정에서 확정한다.

## 현재 산출물 경계

이 문서 세트는 C1~D3 구현과 검증 결과, 후속 slice의 현재 계약을 함께 보존한다. D3의 daemon,
durable delivery, Task-resume evidence, existing-card projection은 hermetic failure matrix를 통과했고,
사람이 승인한 Claude Code 2.1.243 session에서 live 경로도 관찰됐다. 다만 그 session의 Adapter는
authority repair 전 build에서 시작됐고 daemon만 repair 후 build로 바뀌어 exact-build 조건을 충족하지
못했다. 따라서 상태는 `LIVE_CHANNEL_UNVERIFIED`이며 redacted 관찰과 잔여 조건은
[D3 live acceptance evidence](evidence/d3-live-channel-acceptance.md)에 있다. O1의 hermetic/Windows
검증과 merged-main 배포 잔여 조건은 [O1 operational acceptance evidence](evidence/o1-operational-acceptance.md)에 있다.

2026-09-07부터 Codex coordinator는 `plugins/orca-orchestration/`의 `$init-orchestrate` 스킬과 Stop
hook을 사용한다. worker 배치는 Claude coordinator를 포함해 GPT 계열로 통일했고 최고 lane은
`gpt-6-astra`; coordinator 기본은 `xhigh`, 구조·silent-risk·실패 escalation만 `max`다. Slack Gate는
기존 Claude Channel을 먼저 시도하고 후보가 없을 때 exact Codex Run 마커와 Orca terminal route를 대조한
뒤 `terminal send --text ... --enter`로 wake-only identity를 보낸다. plugin 설치, 새 thread의 skill discovery,
Windows Stop hook 실행, 이 경로의 타입/단위 검증은 완료했다. 이전 Orca 계정은 Astra를 400으로
거절했지만 후속 runtime-home 세션에서는 Astra 응답을 확인했다. 현재 계정에서 exact 미지원 오류가
새로 관측될 때만 `gpt-5.6-sol` `max` compatibility 경로를 쓴다. 2026-09-08에는 새 Astra `xhigh`
worker의 requested/effective receipt, 실제 응답과 release, 수정한 Windows Bridge 배포를 확인했다.
새 TUI의 Stop hook은 설치 2개·활성 2개로 관찰됐다. 사용자가 승인한 throwaway Run에서 stale generation
무전송, 실제 Slack Gate 응답 뒤 wake와 Task 재개, 설치된 Stop hook이 지시한 1회 rollover(Run
generation 1→2)까지 관찰했다. 절차는 [Codex 운영 절차](ops/codex-coordinator-setup.md), 실측 기록은
[Codex coordinator acceptance evidence](evidence/codex-coordinator-acceptance.md)에 있다.
