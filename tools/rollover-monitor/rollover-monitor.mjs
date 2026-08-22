#!/usr/bin/env node
// rollover-monitor — Claude Code Stop hook.
//
// 활성 coordinator Run 마커가 있는 세션에서만 동작한다. 컨텍스트 여유가 임계값 아래로
// 내려가면 {"decision":"block"}으로 사전 승인된 롤오버 절차를 지시한다.
//
// 계약: docs/open-decisions.md OD-014, skills/init-orchestrate/SKILL.md §6·§7·§10
// 관측 근거: docs/platform-capabilities.md §3.6

import { readFileSync, writeFileSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MARKER_DIR = join(homedir(), ".claude", "orchestration");
const TAIL_BYTES = 1024 * 1024;
const MAX_TRIGGERS = 3;

/** 아무것도 하지 않고 세션을 정상 종료시킨다. monitor의 모든 실패는 이 경로로 수렴한다. */
function passthrough(note) {
  if (note) process.stderr.write(`[rollover-monitor] ${note}\n`);
  process.stdout.write("{}");
  process.exit(0);
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** worktree 경로를 마커 파일명으로 바꾼다. Claude Code의 projects 디렉터리 규칙과 같은 형태다. */
function markerPathFor(cwd) {
  return join(MARKER_DIR, cwd.replace(/[^A-Za-z0-9]/g, "-") + ".json");
}

/** 파일 끝 TAIL_BYTES만 읽는다. transcript는 무한히 커지므로 전체를 읽지 않는다. */
function readTail(path) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString("utf8");
    // 첫 줄은 잘렸을 수 있다.
    return size > len ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

/**
 * 마지막 assistant 레코드의 usage에서 입력 컨텍스트 점유량을 구한다.
 * 창 크기는 여기서 알 수 없다. transcript의 model 필드는 컨텍스트 창 변형을 구분하지 않는다.
 */
function usedTokens(transcriptPath) {
  const lines = readTail(transcriptPath).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const u = rec?.message?.usage;
    if (!u) continue;
    return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  }
  return null;
}

/**
 * 임계값. 마커가 명시하지 않으면 창 크기에서 파생한다.
 *
 * 하한 80k는 실측한 롤오버 절차 비용 18.5k의 4배 이상이다(작업 없는 Run 1회 관측).
 * 실제 Run은 handoff에 담을 상태가 많아 절차 비용이 커지므로 배수가 필요하다.
 * 비율 15%는 "창이 크면 세션이 다루는 상태도 크고 handoff도 커진다"는 가정이며 미검증이다.
 *
 * auto-compact와의 경쟁은 이 값으로 회피한다. 발동 이후 coordinator는 새 작업을 받지 않으므로
 * 컨텍스트 증가가 절차 비용으로 묶인다. 따라서 reserve가 절차 비용보다 충분히 크면
 * 압축 임계값을 몰라도 세션이 창 끝에 닿지 않는다.
 */
function reserveFor(marker) {
  if (Number.isFinite(marker.reserve_tokens)) return marker.reserve_tokens;
  return Math.max(80_000, Math.round(marker.context_window * 0.15));
}

function main() {
  const raw = readStdin();
  let hook;
  try {
    hook = JSON.parse(raw);
  } catch {
    return passthrough();
  }

  // 플랫폼이 재호출에 이 플래그를 세운다. 확인하지 않으면 세션이 끝나지 않는다.
  if (hook.stop_hook_active) return passthrough();
  if (!hook.cwd || !hook.transcript_path || !hook.session_id) return passthrough();

  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPathFor(hook.cwd), "utf8"));
  } catch {
    return passthrough(); // 마커 없음 = 일반 세션. 침묵한다.
  }

  if (marker.rollover_approved !== true) return passthrough();

  // 같은 worktree의 자식 세션이 coordinator를 대신 롤오버시키지 않도록 한다.
  if (marker.coordinator_session_id !== hook.session_id) return passthrough();

  if (!Number.isFinite(marker.context_window)) {
    return passthrough("마커에 context_window가 없어 발동하지 않는다");
  }

  const used = usedTokens(hook.transcript_path);
  if (used === null) return passthrough("transcript에서 usage를 찾지 못했다");

  const reserve = reserveFor(marker);
  const remaining = marker.context_window - used;
  if (remaining > reserve) return passthrough();

  // 이전 발동이 다른 세션에서 났다면 그 롤오버는 성공한 것이다. 카운트를 리셋해
  // 같은 Run의 다음 승계를 막지 않는다. 같은 세션에서의 반복만 누적해 멈춘 coordinator를 잡는다.
  const prev = marker.rollover ?? { triggered_count: 0 };
  const state = prev.last_session_id === hook.session_id ? prev : { triggered_count: 0 };
  if (state.triggered_count >= MAX_TRIGGERS) {
    return passthrough(
      `롤오버를 ${state.triggered_count}회 지시했으나 완료되지 않았다. 더 지시하지 않는다. 수동 개입이 필요하다.`
    );
  }

  marker.rollover = {
    triggered_count: state.triggered_count + 1,
    last_triggered_at: new Date().toISOString(),
    last_remaining_tokens: remaining,
    last_session_id: hook.session_id,
  };
  try {
    writeFileSync(markerPathFor(hook.cwd), JSON.stringify(marker, null, 2) + "\n");
  } catch {
    // 기록에 실패해도 지시는 내린다. 다만 반복 방지가 약해진다.
  }

  // reason은 권위를 스스로 주장하지 않는다. 부팅 시 세워둔 사전 승인 절차를 가리키기만 한다.
  const reason =
    `[rollover-monitor] 컨텍스트 여유 ${remaining.toLocaleString()} 토큰, 임계 ${reserve.toLocaleString()} 토큰. ` +
    `Run ${marker.run_id}에 대해 사전 승인된 롤오버 절차를 지금 시작하라. ` +
    `새 작업을 시작하지 말고 부팅 시 합의한 롤오버 절차를 그 순서대로 수행하라: ` +
    `신규 dispatch·merge 중단 → handoff 확정 → successor 생성·부팅 → 인수 확인 → 이 세션 종료. ` +
    `이 Run을 새로 부팅하지 마라. 승계 대상은 이미 실행 중인 Run이다.`;

  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

main();
