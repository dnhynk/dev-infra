# 적용 대기 패치

다른 세션이 소유한 파일에 대한 제안 변경을 여기 둔다. 소유 세션이 검토하고 적용한다.
적용한 패치 파일은 삭제한다.

```text
git apply patches/<name>.patch
```

현재 대기 중인 패치는 없다.
## init-orchestrate-embed-placement-table.patch

대상: `skills/init-orchestrate/SKILL.md` (A·B workstream 소유)

이유: 배치 정책 표를 dev-infra 스펙이 아니라 **스킬에 둬야 한다.**
스킬은 `~/.claude/skills/`에 전역 1부로 설치되어 모든 repository의 coordinator에 적용되는데,
표를 dev-infra 스펙에만 두면 다른 repository에서 부팅한 coordinator는 정책을 보지 못하고
배치를 스스로 제안하게 된다. 표의 내용(깊은 추론 / 기계적 작업 / PR 리뷰 / 문서 집필)은
repository와 무관한 분류이므로 스킬이 원본으로 적합하다.

앞선 `init-orchestrate-placement-policy.patch`가 넣은 "스펙에 배치 정책이 있으면 따른다"는
포인터를 이 패치가 대체한다.

변경:

1. §9 신설 — 10행 배치 표와 제약(`launch.effective` 검증, `--terminal` 결합 불가,
   모델별 effort 범위, 은퇴 모델, service tier 지정 불가). 이후 절 번호를 하나씩 민다.
2. §4-2 — "§9의 배치 정책을 적용한 agent·model·effort를 함께 명시한다"로 교체.
3. §8 — 배치 항목이 §9를 가리키게 한다.
4. §13(구 §12) — "reviewer agent의 model·effort 프로파일"을 미지정 목록에서 제거.
   이제 스킬이 지정한다. 대상 repository 스펙이 override하는 경로는 §9 본문에 남겼다.

적용 후 `docs/specs/orchestration-bootstrap-and-continuity.md` §4.2는 이미 표 중복을 없애고
스킬을 원본으로 가리키도록 고쳐 두었다.
