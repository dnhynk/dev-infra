# dev-infra 문서 인덱스

상태: **구현 전 명세 초안**  
기준일: **2026-08-21**

이 디렉터리는 1인 개발자가 Orca IDE의 병렬 Agent orchestration을 더 적은 수동 개입으로 운영하기 위한 개인 Agentic Development Infrastructure의 기준 문서다. 현재 문서 루트는 `D:\dev-infra\docs`다. 현재 세션은 문서 작성 세션이며, 애플리케이션 코드·Slack 설정·GitHub 설정·Orca 상태는 변경하지 않았다.

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
12. [요구사항 추적표](traceability.md)

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
- 언어, 런타임, 패키지 매니저, 모노레포 도구, summarizer 제공자 등은 아직 정하지 않는다.
- 미정 사항은 구현자가 조용히 채우지 않고 [미결정 사항](open-decisions.md)에 기록해 빌드 과정에서 확정한다.

## 현재 산출물 경계

이 문서 세트는 다음 빌드 세션이 무엇을 조사하고 어떤 결정을 받아야 하는지를 명확히 하는 데까지 책임진다. 실제 구현 완료를 의미하지 않는다. 테스트, 실제 Slack 메시지, GitHub API 호출, Orca `gate-resolve`, Channel notification은 실행하지 않았다.
