import { GithubRemoteError, normalizeGithubRemote } from './github-remote.js';
import type {
  RepositoryDiscoveryDiagnostic,
  RepositoryDiscoveryRow,
  RepositoryDiscoverySnapshot,
} from './types.js';

const ENVELOPE_KEYS = ['_meta', 'id', 'ok', 'result'] as const;
const RESULT_KEYS = ['repos'] as const;
const META_KEYS = ['runtimeId'] as const;
const ROW_KEYS_WITH_REPO_ICON = [
  'addedAt',
  'badgeColor',
  'displayName',
  'externalWorktreeVisibility',
  'externalWorktreeVisibilityLegacy',
  'gitRemoteIdentity',
  'gitUsername',
  'hookSettings',
  'id',
  'kind',
  'path',
  'projectHostSetupMethod',
  'repoIcon',
  'upstream',
] as const;
const ROW_KEYS_WITHOUT_REPO_ICON = [
  'addedAt',
  'badgeColor',
  'displayName',
  'externalWorktreeVisibility',
  'externalWorktreeVisibilityLegacy',
  'gitRemoteIdentity',
  'gitUsername',
  'hookSettings',
  'id',
  'kind',
  'path',
  'projectHostSetupMethod',
  'upstream',
] as const;
const REMOTE_KEYS = ['canonicalKey', 'remoteName', 'remoteUrl'] as const;

export type OrcaRepositoryContractErrorCode =
  | 'ORCA_REPOSITORY_JSON_INVALID'
  | 'ORCA_REPOSITORY_ENVELOPE_INVALID'
  | 'ORCA_REPOSITORY_COMMAND_FAILED'
  | 'ORCA_REPOSITORY_RESULT_INVALID'
  | 'ORCA_REPOSITORY_ROW_INVALID';

const MESSAGES: Readonly<Record<OrcaRepositoryContractErrorCode, string>> = {
  ORCA_REPOSITORY_JSON_INVALID: 'Orca repository response is not valid JSON',
  ORCA_REPOSITORY_ENVELOPE_INVALID: 'Orca repository response envelope does not match the installed contract',
  ORCA_REPOSITORY_COMMAND_FAILED: 'Orca repository command failed',
  ORCA_REPOSITORY_RESULT_INVALID: 'Orca repository result does not match the installed contract',
  ORCA_REPOSITORY_ROW_INVALID: 'Orca repository row does not match the installed contract',
};

/** Static public error. It deliberately excludes raw rows, paths, URLs, IDs, and payloads. */
export class OrcaRepositoryContractError extends TypeError {
  constructor(readonly code: OrcaRepositoryContractErrorCode) {
    super(MESSAGES[code]);
    this.name = 'OrcaRepositoryContractError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function fail(code: OrcaRepositoryContractErrorCode): never {
  throw new OrcaRepositoryContractError(code);
}

function requireString(row: Record<string, unknown>, key: string): void {
  if (typeof row[key] !== 'string') fail('ORCA_REPOSITORY_ROW_INVALID');
}

function validateRowShape(value: unknown): Record<string, unknown> {
  if (
    !isRecord(value) ||
    (!hasExactKeys(value, ROW_KEYS_WITH_REPO_ICON) &&
      !hasExactKeys(value, ROW_KEYS_WITHOUT_REPO_ICON))
  ) {
    fail('ORCA_REPOSITORY_ROW_INVALID');
  }
  for (const key of [
    'id',
    'path',
    'displayName',
    'badgeColor',
    'kind',
    'gitUsername',
    'projectHostSetupMethod',
    'externalWorktreeVisibility',
  ]) {
    requireString(value, key);
  }
  if (!Number.isSafeInteger(value['addedAt'])) fail('ORCA_REPOSITORY_ROW_INVALID');
  if (typeof value['externalWorktreeVisibilityLegacy'] !== 'boolean') {
    fail('ORCA_REPOSITORY_ROW_INVALID');
  }
  if (value['upstream'] !== null) fail('ORCA_REPOSITORY_ROW_INVALID');
  if ('repoIcon' in value && value['repoIcon'] !== null && !isRecord(value['repoIcon'])) {
    fail('ORCA_REPOSITORY_ROW_INVALID');
  }
  if (!isRecord(value['hookSettings'])) fail('ORCA_REPOSITORY_ROW_INVALID');
  const remote = value['gitRemoteIdentity'];
  if (remote !== null) {
    if (!isRecord(remote) || !hasExactKeys(remote, REMOTE_KEYS)) {
      fail('ORCA_REPOSITORY_ROW_INVALID');
    }
    for (const key of REMOTE_KEYS) requireString(remote, key);
  }
  return value;
}

function blocked(
  rowIndex: number,
  code: RepositoryDiscoveryDiagnostic['code'],
): RepositoryDiscoveryDiagnostic {
  return { rowIndex, code, effect: 'row_blocked' };
}

function parseRow(value: unknown, rowIndex: number): RepositoryDiscoveryRow {
  const row = validateRowShape(value);
  const orcaRepositoryId = row['id'] as string;
  const remote = row['gitRemoteIdentity'];
  if (remote === null) {
    return {
      status: 'no_remote',
      orcaRepositoryId,
      rowIndex,
      diagnostic: blocked(rowIndex, 'no_remote'),
    };
  }

  const remoteObject = remote as Record<string, unknown>;
  let identity;
  try {
    identity = normalizeGithubRemote(remoteObject['remoteUrl'] as string);
  } catch (error) {
    if (!(error instanceof GithubRemoteError)) throw error;
    return {
      status: error.code === 'unsupported_host' || error.code === 'unsupported_scheme'
        ? 'unsupported_remote'
        : 'invalid_remote',
      orcaRepositoryId,
      rowIndex,
      diagnostic: blocked(rowIndex, error.code),
    };
  }

  // 대소문자를 접어 대조한다. Bridge가 계산한 key는 계약대로 `<owner-lower>/<repo-lower>`인데
  // Orca가 반환하는 `canonicalKey`는 원래 대소문자를 보존한다. exact 비교하면 이름에 대문자가
  // 하나라도 있는 repository가 전부 `canonical_conflict`로 영구 차단된다 — 실측에서 11개 중
  // `Home_Compass`·`PostFeel`·`MS` 셋이 그렇게 막혀 있었다.
  //
  // 이 검사의 목적은 두 쪽이 **서로 다른 repository**를 가리키는 것을 잡는 것이다. GitHub은
  // owner/name을 대소문자 구분 없이 취급하므로 대소문자만 다른 두 값은 같은 repository이고,
  // 접어서 대조해도 그 목적은 그대로 지켜진다. identity로 보존하는 값은 여전히 Bridge가 계산한
  // 소문자 key뿐이다(contracts §1).
  if (typeof remoteObject['canonicalKey'] !== 'string' ||
      remoteObject['canonicalKey'].toLowerCase() !== identity.canonicalKey) {
    return {
      status: 'canonical_conflict',
      orcaRepositoryId,
      rowIndex,
      computedIdentity: identity,
      diagnostic: blocked(rowIndex, 'canonical_conflict'),
    };
  }
  return { status: 'valid', orcaRepositoryId, rowIndex, identity };
}

export function parseOrcaRepositoryList(raw: unknown): RepositoryDiscoverySnapshot {
  if (!isRecord(raw) || !hasExactKeys(raw, ENVELOPE_KEYS)) {
    fail('ORCA_REPOSITORY_ENVELOPE_INVALID');
  }
  if (typeof raw['id'] !== 'string' || typeof raw['ok'] !== 'boolean') {
    fail('ORCA_REPOSITORY_ENVELOPE_INVALID');
  }
  if (raw['ok'] !== true) fail('ORCA_REPOSITORY_COMMAND_FAILED');
  const meta = raw['_meta'];
  if (!isRecord(meta) || !hasExactKeys(meta, META_KEYS) || typeof meta['runtimeId'] !== 'string') {
    fail('ORCA_REPOSITORY_ENVELOPE_INVALID');
  }
  const result = raw['result'];
  if (!isRecord(result) || !hasExactKeys(result, RESULT_KEYS) || !Array.isArray(result['repos'])) {
    fail('ORCA_REPOSITORY_RESULT_INVALID');
  }
  const rows = result['repos'].map(parseRow);
  return {
    rows,
    diagnostics: rows.flatMap((row) => ('diagnostic' in row ? [row.diagnostic] : [])),
  };
}

export function parseOrcaRepositoryListJson(text: string): RepositoryDiscoverySnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail('ORCA_REPOSITORY_JSON_INVALID');
  }
  return parseOrcaRepositoryList(raw);
}
