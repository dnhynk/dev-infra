import { describe, it, expect } from 'vitest';
import { maskToken, verifySlack, formatVerify } from '../src/slack/verify.js';
import { parseConfig } from '../src/project/config.js';

const slack = {
  teamId: 'T01ABCDEF',
  ownerUserIds: ['U01OWNER'],
  channels: { prDigest: 'C01PRD', agentRuns: 'C01RUNS' },
};
const base = { slack, projects: [{ name: 'p', repositories: ['o/r'] }] };

/**
 * 가짜 토큰은 리터럴로 두지 않고 조립한다.
 * 실제 토큰 형태를 그대로 적으면 GitHub push protection이 커밋을 막는다.
 */
const fake = (prefix: string, tail: string): string => [prefix, 'FAKE', tail].join('-');

describe('토큰 마스킹', () => {
  it('전체 값을 드러내지 않는다', () => {
    const t = fake('xoxb', 'NOTAREALTOKENVALUE');
    const m = maskToken(t);
    expect(m).not.toContain('NOTAREALTOKENVALUE');
    expect(m).toContain('xoxb-');
  });
  it('짧은 값은 통째로 가린다', () => {
    expect(maskToken('xoxb-1')).toBe('***');
  });
});

describe('설정 파싱', () => {
  it('slack 절을 읽는다', () => {
    const c = parseConfig(base);
    expect(c.slack?.teamId).toBe('T01ABCDEF');
    expect(c.slack?.channels.prDigest).toBe('C01PRD');
  });

  it('slack 절이 없어도 된다 (S0는 Slack을 쓰지 않는다)', () => {
    expect(parseConfig({ projects: base.projects }).slack).toBeNull();
  });

  it('채널 이름을 ID 대신 넣으면 거부한다', () => {
    expect(() =>
      parseConfig({ ...base, slack: { ...slack, channels: { prDigest: '#pr-digest', agentRuns: 'C1' } } }),
    ).toThrow(/채널 ID가 아니다/);
  });

  it('ownerUserIds가 비면 거부한다', () => {
    expect(() => parseConfig({ ...base, slack: { ...slack, ownerUserIds: [] } })).toThrow(/비어 있다/);
  });

  it('teamId 접두가 틀리면 거부한다', () => {
    expect(() => parseConfig({ ...base, slack: { ...slack, teamId: 'X1' } })).toThrow(/T로 시작/);
  });

  it('설정에 토큰을 넣으면 거부한다 — 잘못된 위치에 붙여넣는 사고를 막는다', () => {
    expect(() => parseConfig({ ...base, slack: { ...slack, botToken: fake('xoxb', 'X') } })).toThrow(/토큰으로 보이는 값/);
    expect(() => parseConfig({ ...base, notes: [fake('xapp', 'X')] })).toThrow(/토큰으로 보이는 값/);
  });
});

describe('verifySlack — 네트워크 없이 판정되는 경로', () => {
  it('slack 설정이 없으면 실패로 보고한다', async () => {
    const r = await verifySlack(null, {} as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    expect(r.checks[0]?.name).toBe('config.slack');
  });

  it('토큰이 비면 네트워크를 타지 않고 실패로 보고한다', async () => {
    const r = await verifySlack(slack, {} as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    const names = r.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(names).toContain('SLACK_BOT_TOKEN');
    expect(names).toContain('SLACK_APP_TOKEN');
  });

  it('접두가 틀린 토큰은 호출 전에 잡고 값을 노출하지 않는다', async () => {
    const r = await verifySlack(slack, {
      SLACK_BOT_TOKEN: fake('xapp', 'WRONGPLACEVALUE'),
      SLACK_APP_TOKEN: fake('xoxb', 'WRONGPLACEVALUE'),
    } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    const out = formatVerify(r);
    expect(out).not.toContain('WRONGPLACEVALUE');
  });
});
