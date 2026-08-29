import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { cursorDelta, hasPromptAnchor, parseTerminalPrompt } from '../src/terminal/prompt.js';

/**
 * 실제 Claude Code 세션 화면.
 *
 * 2026-08-29에 막혀 있던 Academic-Platform coordinator 터미널에서 `orca terminal read --screen`
 * 으로 그대로 받아 왔다. 손으로 만든 화면이 아니라 이 기능이 실제로 상대할 화면이다.
 */
const LIVE_SCREEN: readonly string[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/claude-code-option-prompt.json', import.meta.url)), 'utf8'),
) as string[];

const SUBMIT_SCREEN: readonly string[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/claude-code-submit-prompt.json', import.meta.url)), 'utf8'),
) as string[];

describe('agent 터미널 화면의 선택 프롬프트', () => {
  it('실제 Claude Code 화면에서 질문과 선택지를 읽는다', () => {
    const prompt = parseTerminalPrompt(LIVE_SCREEN);
    if (prompt === null) throw new Error('실제 화면을 읽지 못했다');

    expect(prompt.title).toBe('Windows 빌드');
    expect(prompt.question).toContain('이 머신에 무엇을 설치할지 결정해 주세요');
    expect(prompt.options.map((option) => option.index)).toEqual([1, 2, 3, 4, 5]);
    expect(prompt.options[0]?.label).toBe('고정 portable Strawberry Perl 설치 (권장)');
    expect(prompt.options[1]?.label).toBe('NOT_RUN으로 기록하고 설치하지 않음');
    // 5번은 구분선 뒤에 있다. 구분선이 목록을 끊으면 이 선택지가 사라진다.
    expect(prompt.options[4]?.label).toBe('Chat about this');
    expect(prompt.cursorIndex).toBe(1);
    expect(prompt.options[0]?.selected).toBe(true);
    expect(prompt.options.filter((option) => option.selected)).toHaveLength(1);
  });

  it('화면 다른 곳의 ❯를 커서로 읽지 않는다', () => {
    // 0행이 "❯ You have 1 orchestration message..."다. 커서는 ❯ <숫자>. 형태만 인정한다.
    expect(LIVE_SCREEN[0]?.startsWith('❯')).toBe(true);
    const prompt = parseTerminalPrompt(LIVE_SCREEN);
    expect(prompt?.cursorIndex).toBe(1);
  });

  it('설명 줄을 그 선택지에 붙인다', () => {
    const prompt = parseTerminalPrompt(LIVE_SCREEN);
    expect(prompt?.options[0]?.description).toContain('OPENSSL_SRC_PERL');
    expect(prompt?.options[1]?.description).toContain('영구 공백');
    // 마지막 선택지 뒤에는 anchor뿐이라 설명이 없다.
    expect(prompt?.options[4]?.description).toBeNull();
  });

  it('지문은 프롬프트 영역만 쓴다', () => {
    const prompt = parseTerminalPrompt(LIVE_SCREEN);
    if (prompt === null) throw new Error('실제 화면을 읽지 못했다');
    // 화면 아래쪽 로그가 움직여도 같은 프롬프트는 같은 지문이어야 한다. 그렇지 않으면 답을
    // 보내기 직전 재확인이 늘 실패한다.
    const noisier = [...LIVE_SCREEN.slice(0, 38), '  ← orca-slack: 새 이벤트', '  ← 또 다른 줄'];
    const again = parseTerminalPrompt(noisier);
    expect(again?.fingerprint).toBe(prompt.fingerprint);

    // 질문이 바뀌면 지문이 바뀐다.
    const changed = [...LIVE_SCREEN];
    changed[23] = '│ 완전히 다른 질문입니다.';
    expect(parseTerminalPrompt(changed)?.fingerprint).not.toBe(prompt.fingerprint);
  });

  it('커서 이동 거리를 선택지 번호에서 계산한다', () => {
    const prompt = parseTerminalPrompt(LIVE_SCREEN);
    if (prompt === null) throw new Error('실제 화면을 읽지 못했다');
    expect(cursorDelta(prompt, 1)).toBe(0);
    expect(cursorDelta(prompt, 3)).toBe(2);
    expect(cursorDelta(prompt, 9)).toBeNull();
  });

  it('모양이 맞지 않으면 null이다', () => {
    // 선택지 목록이 잘려 1번이 화면에 없다.
    expect(parseTerminalPrompt(LIVE_SCREEN.slice(28))).toBeNull();
    // 선택지가 하나뿐이다.
    expect(parseTerminalPrompt([
      '│ 질문',
      '❯ 1. 하나뿐',
      'Enter to select · ↑/↓ to navigate',
    ])).toBeNull();
    // 번호가 이어지지 않는다.
    expect(parseTerminalPrompt([
      '│ 질문',
      '❯ 1. 하나',
      '  3. 셋',
      'Enter to select · ↑/↓ to navigate',
    ])).toBeNull();
    // 커서가 없다.
    expect(parseTerminalPrompt([
      '│ 질문',
      '  1. 하나',
      '  2. 둘',
      'Enter to select · ↑/↓ to navigate',
    ])).toBeNull();
    // 질문이 없다. 무엇을 고르는지 모르는 버튼은 만들지 않는다.
    expect(parseTerminalPrompt([
      '❯ 1. 하나',
      '  2. 둘',
      'Enter to select · ↑/↓ to navigate',
    ])).toBeNull();
  });

  it('안내 문구가 없는 제출 확인 화면도 읽는다', () => {
    /*
     * 여러 질문에 답한 뒤 나오는 제출 확인 화면에는 `Enter to select …` 줄이 없다. 목록과
     * 커서만 있다. 그 화면을 못 읽으면 사람은 마지막 한 번을 터미널에서 눌러야 하는데,
     * 그럴 수 있었으면 이 기능이 필요 없다. 실제로 그렇게 막혔다.
     */
    const prompt = parseTerminalPrompt(SUBMIT_SCREEN);
    if (prompt === null) throw new Error('제출 확인 화면을 읽지 못했다');
    expect(prompt.question).toBe('Ready to submit your answers?');
    expect(prompt.options.map((option) => option.label)).toEqual(['Submit answers', 'Cancel']);
    expect(prompt.cursorIndex).toBe(1);
    // 이전 질문과 답이 질문으로 딸려 들어오지 않는다.
    expect(prompt.question).not.toContain('두 번째 기기');
  });

  it('프롬프트가 떠 있으면 선택지를 읽지 못해도 그 사실을 구분한다', () => {
    // 커서가 아래쪽 선택지로 내려가면 화면이 스크롤되어 1번이 화면 밖으로 밀린다. 그때 목록을
    // 만들 수 없는데, 그것을 "프롬프트가 사라졌다"로 처리하면 카드가 "이미 처리됨"이라고
    // 말하면서 코디네이터는 그대로 막혀 있다. 실제로 그렇게 됐다.
    const scrolled = [
      '❯ 4. Type something.',
      '─'.repeat(60),
      '  5. Chat about this',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ];
    expect(parseTerminalPrompt(scrolled)).toBeNull();
    expect(hasPromptAnchor(scrolled)).toBe(true);

    // 프롬프트가 정말 사라진 화면과는 구분된다.
    const finished = ['● 작업을 계속합니다.', '  Ran 2 shell commands'];
    expect(parseTerminalPrompt(finished)).toBeNull();
    expect(hasPromptAnchor(finished)).toBe(false);
  });

  it('질문만 있고 선택지 형식이 성한 최소 화면을 읽는다', () => {
    const prompt = parseTerminalPrompt([
      ' ☐ 권한 확인',
      '│ 이 명령을 실행할까요?',
      '❯ 1. 예',
      '  2. 아니오',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ]);
    expect(prompt?.title).toBe('권한 확인');
    expect(prompt?.question).toBe('이 명령을 실행할까요?');
    expect(prompt?.options.map((option) => option.label)).toEqual(['예', '아니오']);
  });
});
