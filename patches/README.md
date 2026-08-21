# 적용 대기 패치

다른 세션이 소유한 파일에 대한 제안 변경을 여기 둔다. 소유 세션이 검토하고 적용한다.
적용한 패치 파일은 삭제한다.

```text
git apply patches/<name>.patch
```

## init-orchestrate-placement-policy.patch

대상: `skills/init-orchestrate/SKILL.md` (A·B workstream 소유)

이유: [Agent 배치 정책](../docs/specs/orchestration-bootstrap-and-continuity.md#42-agent-배치-정책)이
normative 계약으로 확정됐으나(DL-019, OD-017) 스킬은 배치를 여전히 "제안" 대상으로 다룬다.
현재 문구대로면 coordinator가 정책을 읽고도 자기 판단으로 배치를 새로 제안할 수 있다.

변경 3건:

1. §4-2 — 스펙에 배치 정책이 있으면 그것을 따르도록 지시. 없을 때만 제안한다.
2. §8 — 운영 계약에 배치 항목 추가. terminal 재사용 시 이전 배치가 유지된다는 사실 포함
   (`--model`/`--effort`는 `--terminal`과 결합 불가).
3. §12 — "model·effort·tier 프로파일"에서 `tier` 제거. service tier는 `worker-start`로
   지정할 수 없으므로 repository 계약으로 정할 수 있는 값이 아니다(OD-074).

스킬이 `worker-start` 같은 버전 의존 명령을 직접 쓰지 않는 설계는 유지했다.
