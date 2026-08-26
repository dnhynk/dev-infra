import { normalizeGithubNameWithOwner } from './github-remote.js';
import {
  OrcaRepositoryContractError,
} from './orca-repositories.js';
import type {
  CanonicalGithubRepository,
  EffectiveBridgeConfig,
  EffectiveProjectOrigin,
  RepositoryDiscoveryDiagnostic,
  RepositoryDiscoveryRow,
  RepositoryDiscoverySnapshot,
} from './types.js';
import {
  bridgeConfigFingerprint,
  buildEffectiveBridgeConfig,
  type EffectiveBindingBlock,
} from './effective-config.js';
import { discoveryIssueHash, redactedEntityRef } from './redaction.js';
import { listRepositories, type OrcaRunner } from '../orca/client.js';
import type { RepositoryIdentityConfirmer } from '../github/repository.js';
import type { ParsedBridgeConfig } from '../project/config.js';
import type {
  DiscoveryObservationEvidence,
  EffectiveDiscoverySnapshot,
  OperationalStore,
  OrcaRepositoryBindingInput,
  RepositoryDiscoveryIssueCategory,
  RepositoryDiscoveryIssueInput,
  RepositoryRegistryInput,
} from '../store/operational-types.js';

const EMPTY_SNAPSHOT: EffectiveDiscoverySnapshot = Object.freeze({
  repositories: Object.freeze([]),
  bindings: Object.freeze([]),
  issues: Object.freeze([]),
});

export type RepositoryDiscoveryFailure =
  | 'query_failed'
  | 'schema_drift'
  | 'capacity_conflict'
  | 'config_drift'
  | 'store_failed';

export type RepositoryDiscoveryPassResult = {
  readonly status: 'succeeded' | 'failed';
  readonly failure?: RepositoryDiscoveryFailure;
  readonly configFingerprint: string;
  readonly snapshot: EffectiveDiscoverySnapshot;
  readonly effectiveConfig: EffectiveBridgeConfig;
  readonly counts: {
    readonly sourceRows: number;
    readonly verifiedRepositories: number;
    readonly effectiveBindings: number;
    readonly blockedBindings: number;
    readonly deferredRepositories: number;
  };
};

export type RepositoryDiscoveryPassOptions = {
  readonly orca: OrcaRunner;
  readonly github: RepositoryIdentityConfirmer;
  readonly store: OperationalStore;
  readonly config: ParsedBridgeConfig;
  readonly now?: () => Date;
  /** The daemon may supply its canonical config fingerprint; otherwise it is derived here. */
  readonly configFingerprint?: string;
  /** Fences a process-local LKG snapshot captured under a different explicit configuration. */
  readonly lastKnownGoodConfigFingerprint?: string;
};

type RowCandidate = {
  readonly orcaRepositoryId: string;
  readonly rowIndex: number;
  readonly rows: readonly RepositoryDiscoveryRow[];
  readonly identity: CanonicalGithubRepository | null;
  readonly fallback: 'no_remote' | 'unsupported_remote' | 'invalid_remote' | null;
  readonly conflict: 'canonical_conflict' | 'duplicate_orca_id' | null;
};

type CanonicalCandidate = {
  readonly observed: CanonicalGithubRepository;
  readonly rowIndex: number;
  readonly orcaRepositoryIds: readonly string[];
};

type ResolvedRepository = {
  readonly observedCanonicalKeys: Set<string>;
  readonly identity: CanonicalGithubRepository;
  readonly githubRepositoryId: number;
  readonly projectKey: string;
  readonly projectOrigin: EffectiveProjectOrigin;
  readonly rowIndex: number;
  readonly orcaRepositoryIds: Set<string>;
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function categoryForRow(row: RepositoryDiscoveryRow): RepositoryDiscoveryIssueCategory {
  if (row.status === 'valid') return 'schema_drift';
  if (row.status === 'canonical_conflict') return 'canonical_conflict';
  return row.status;
}

function rowCandidates(snapshot: RepositoryDiscoverySnapshot): RowCandidate[] {
  const grouped = new Map<string, RepositoryDiscoveryRow[]>();
  for (const row of snapshot.rows) {
    const rows = grouped.get(row.orcaRepositoryId) ?? [];
    rows.push(row);
    grouped.set(row.orcaRepositoryId, rows);
  }
  return [...grouped.entries()].map(([orcaRepositoryId, rows]) => {
    const ordered = [...rows].sort((a, b) => a.rowIndex - b.rowIndex);
    const signatures = new Set(ordered.map((row) =>
      row.status === 'valid' ? `valid:${row.identity.canonicalKey}` : row.status));
    const valid = ordered.filter((row): row is Extract<RepositoryDiscoveryRow, { status: 'valid' }> =>
      row.status === 'valid');
    const identity = valid[0]?.identity ?? null;
    const canonicalMismatch = ordered.some((row) => row.status === 'canonical_conflict');
    const duplicateConflict = signatures.size > 1 ||
      new Set(valid.map((row) => row.identity.canonicalKey)).size > 1;
    const invalid = ordered.some((row) => row.status === 'invalid_remote');
    const unsupported = ordered.some((row) => row.status === 'unsupported_remote');
    const fallback: RowCandidate['fallback'] =
      valid.length > 0 || canonicalMismatch || duplicateConflict
        ? null
        : invalid ? 'invalid_remote' : unsupported ? 'unsupported_remote' : 'no_remote';
    const conflict: RowCandidate['conflict'] = canonicalMismatch
      ? 'canonical_conflict'
      : duplicateConflict ? 'duplicate_orca_id' : null;
    return {
      orcaRepositoryId,
      rowIndex: ordered[0]?.rowIndex ?? 0,
      rows: ordered,
      identity,
      fallback,
      conflict,
    };
  }).sort((a, b) => compareText(a.orcaRepositoryId, b.orcaRepositoryId));
}

function uniqueIssues(issues: readonly RepositoryDiscoveryIssueInput[]): RepositoryDiscoveryIssueInput[] {
  return [...new Map(issues.map((issue) => [issue.issueHash, issue])).values()]
    .sort((a, b) => compareText(a.issueHash, b.issueHash));
}

function failedIssue(category: RepositoryDiscoveryIssueCategory): RepositoryDiscoveryIssueInput {
  return { issueHash: discoveryIssueHash(category, 'whole-pass'), category };
}

function repositoryInput(
  identity: CanonicalGithubRepository,
  githubRepositoryId: number | null,
  projectKey: string,
  projectOrigin: EffectiveProjectOrigin,
  evidence: DiscoveryObservationEvidence,
): RepositoryRegistryInput {
  return {
    ...identity, githubRepositoryId, projectKey, projectOrigin, evidence,
  };
}

function resultCounts(
  sourceRows: number,
  snapshot: EffectiveDiscoverySnapshot,
  blocked: readonly EffectiveBindingBlock[],
  deferredRepositories: number,
): RepositoryDiscoveryPassResult['counts'] {
  return {
    sourceRows,
    verifiedRepositories: snapshot.repositories.filter((row) => row.githubRepositoryId !== null).length,
    effectiveBindings: snapshot.bindings.length,
    blockedBindings: new Set(blocked.flatMap((row) => row.orcaRepositoryIds)).size,
    deferredRepositories,
  };
}

/** One exact Orca repository-list read followed by one atomic O1-2 reconciliation transaction. */
export async function runRepositoryDiscoveryPass(
  options: RepositoryDiscoveryPassOptions,
): Promise<RepositoryDiscoveryPassResult> {
  const at = (options.now ?? (() => new Date()))().toISOString();
  const fingerprint = options.configFingerprint ?? bridgeConfigFingerprint(options.config);
  const lkgCompatible = options.lastKnownGoodConfigFingerprint === undefined ||
    options.lastKnownGoodConfigFingerprint === fingerprint;
  const previous = options.store.readEffectiveDiscoverySnapshot();

  let source: RepositoryDiscoverySnapshot;
  try {
    source = await listRepositories(options.orca);
  } catch (error) {
    const failure: RepositoryDiscoveryFailure = error instanceof OrcaRepositoryContractError &&
      error.code !== 'ORCA_REPOSITORY_COMMAND_FAILED' ? 'schema_drift' : 'query_failed';
    const category: RepositoryDiscoveryIssueCategory = failure === 'schema_drift'
      ? 'schema_drift' : 'query_failed';
    let retained = previous;
    try {
      retained = options.store.replaceDiscoverySnapshot({
        passOutcome: 'failed', repositories: [], bindings: [], issues: [failedIssue(category)], at,
      });
    } catch {
      // The old snapshot was read before the transaction and is the only safe fallback.
    }
    const usable = lkgCompatible ? retained : EMPTY_SNAPSHOT;
    const effectiveConfig = buildEffectiveBridgeConfig(options.config, usable, {
      configFingerprint: fingerprint,
      ...(lkgCompatible ? {} : { routingBlock: 'config_drift' as const }),
    });
    return {
      status: 'failed', failure: lkgCompatible ? failure : 'config_drift',
      configFingerprint: fingerprint, snapshot: retained, effectiveConfig,
      counts: resultCounts(0, usable, [], 0),
    };
  }

  const repositoryLimit = options.config.automation.capacity.repositories;
  const explicitByCanonical = new Map<string, string>();
  const manualById = new Map<string, string>();
  for (const project of options.config.projects) {
    for (const name of project.repositories) {
      explicitByCanonical.set(normalizeGithubNameWithOwner(name).canonicalKey, project.name);
    }
    for (const id of project.orcaRepositoryIds) manualById.set(id, project.name);
  }

  const activeCanonical = new Set((lkgCompatible ? previous.repositories : [])
    .filter((row) => row.githubRepositoryId !== null)
    .map((row) => row.canonicalKey));
  const capacityFloor = new Set([...explicitByCanonical.keys(), ...activeCanonical]).size;
  if (explicitByCanonical.size > repositoryLimit || capacityFloor > repositoryLimit) {
    let retained = previous;
    try {
      retained = options.store.replaceDiscoverySnapshot({
        passOutcome: 'failed', repositories: [], bindings: [],
        issues: [failedIssue('capacity_conflict')], at,
      });
    } catch { /* return the pre-read LKG */ }
    const effectiveConfig = buildEffectiveBridgeConfig(
      options.config, lkgCompatible ? retained : EMPTY_SNAPSHOT,
      { configFingerprint: fingerprint, routingBlock: 'capacity_conflict' },
    );
    return {
      status: 'failed', failure: 'capacity_conflict', configFingerprint: fingerprint,
      snapshot: retained, effectiveConfig,
      counts: resultCounts(source.rows.length, lkgCompatible ? retained : EMPTY_SNAPSHOT, [], 0),
    };
  }

  const previousByCanonical = new Map(previous.repositories.map((row) => [row.canonicalKey, row]));
  const previousByNumeric = new Map(previous.repositories
    .filter((row) => row.githubRepositoryId !== null)
    .map((row) => [row.githubRepositoryId as number, row]));
  const previousBindingsByCanonical = new Map<string, typeof previous.bindings>();
  for (const binding of previous.bindings) {
    if (binding.canonicalKey === null) continue;
    const rows = previousBindingsByCanonical.get(binding.canonicalKey) ?? [];
    previousBindingsByCanonical.set(binding.canonicalKey, [...rows, binding]);
  }
  const previousBindingById = new Map(previous.bindings.map((row) => [row.orcaRepositoryId, row]));
  const idsForCanonical = (
    canonicalKey: CanonicalGithubRepository['canonicalKey'],
    extra: readonly string[] = [],
  ): string[] => [...new Set([
    ...extra,
    ...(previousBindingsByCanonical.get(canonicalKey) ?? []).map((row) => row.orcaRepositoryId),
  ])].sort();

  const diagnostics: RepositoryDiscoveryDiagnostic[] = [...source.diagnostics];
  const issues: RepositoryDiscoveryIssueInput[] = [];
  const blocks: EffectiveBindingBlock[] = [];
  const repositoryInputs = new Map<string, RepositoryRegistryInput>();
  const bindingInputs = new Map<string, OrcaRepositoryBindingInput>();
  const projectOverrides = new Map<string, {
    readonly projectKey: string;
    readonly projectOrigin: EffectiveProjectOrigin;
  }>();
  const remoteUnverifiedIds = new Set<string>();
  let deferredRepositories = 0;

  const addIssue = (
    category: RepositoryDiscoveryIssueCategory,
    privateIdentity: string,
  ): void => {
    issues.push({ issueHash: discoveryIssueHash(category, privateIdentity), category });
  };
  const addBlock = (
    ids: readonly string[],
    reason: EffectiveBindingBlock['reason'],
    rowIndex: number,
    identity?: CanonicalGithubRepository,
    effect: RepositoryDiscoveryDiagnostic['effect'] = 'group_blocked',
  ): void => {
    const ordered = [...new Set(ids)].sort();
    if (ordered.length === 0) return;
    const block: EffectiveBindingBlock = {
      orcaRepositoryIds: ordered, reason, ...(identity === undefined ? {} : { identity }),
    };
    blocks.push(block);
    diagnostics.push({
      rowIndex, code: reason, effect,
      entityRef: redactedEntityRef('orca-repository-group', ordered.join('\u0000')),
    });
    addIssue(reason, ordered.join('\u0000'));
  };
  const carryCanonical = (canonicalKey: CanonicalGithubRepository['canonicalKey']): void => {
    if (!lkgCompatible) return;
    const repository = previousByCanonical.get(canonicalKey);
    if (repository === undefined) return;
    if (!repositoryInputs.has(canonicalKey)) {
      repositoryInputs.set(canonicalKey, repositoryInput(
        identityFromRecord(repository.canonicalKey, repository.nameWithOwner),
        repository.githubRepositoryId,
        repository.projectKey,
        repository.projectOrigin,
        'carried_forward',
      ));
    }
    for (const binding of previousBindingsByCanonical.get(canonicalKey) ?? []) {
      if (!bindingInputs.has(binding.orcaRepositoryId)) {
        bindingInputs.set(binding.orcaRepositoryId, {
          orcaRepositoryId: binding.orcaRepositoryId,
          canonicalKey: binding.canonicalKey,
          projectKey: binding.projectKey,
          origin: binding.origin,
          evidence: 'carried_forward',
        });
      }
    }
  };
  const carryId = (id: string): void => {
    if (!lkgCompatible) return;
    const binding = previousBindingById.get(id);
    if (binding === undefined) return;
    if (binding.canonicalKey !== null) carryCanonical(binding.canonicalKey);
    else if (!bindingInputs.has(id)) {
      bindingInputs.set(id, {
        orcaRepositoryId: id, canonicalKey: null, projectKey: binding.projectKey,
        origin: 'manual', evidence: 'carried_forward',
      });
    }
  };

  const candidates = rowCandidates(source);
  const canonical = new Map<string, { identity: CanonicalGithubRepository; rowIndex: number; ids: string[] }>();
  for (const candidate of candidates) {
    if (candidate.rows.length > 1) {
      diagnostics.push({
        rowIndex: candidate.rowIndex,
        code: 'duplicate_orca_id',
        effect: candidate.conflict === null ? 'coalesced' : 'group_blocked',
        entityRef: redactedEntityRef('orca-repository', candidate.orcaRepositoryId),
      });
      addIssue('duplicate_orca_id', candidate.orcaRepositoryId);
    }
    if (candidate.conflict !== null) {
      addBlock([candidate.orcaRepositoryId], candidate.conflict, candidate.rowIndex,
        candidate.identity ?? undefined);
      carryId(candidate.orcaRepositoryId);
      continue;
    }
    if (candidate.identity !== null) {
      const group = canonical.get(candidate.identity.canonicalKey) ?? {
        identity: candidate.identity, rowIndex: candidate.rowIndex, ids: [],
      };
      group.ids.push(candidate.orcaRepositoryId);
      canonical.set(candidate.identity.canonicalKey, group);
      continue;
    }
    const manualProject = manualById.get(candidate.orcaRepositoryId);
    if (manualProject !== undefined &&
        (candidate.fallback === 'no_remote' || candidate.fallback === 'unsupported_remote')) {
      const existingBinding = previousBindingById.get(candidate.orcaRepositoryId);
      const existingRepository = existingBinding?.canonicalKey === null ||
        existingBinding?.canonicalKey === undefined
        ? undefined : previousByCanonical.get(existingBinding.canonicalKey);
      if (lkgCompatible && existingBinding?.canonicalKey !== null &&
          existingBinding?.canonicalKey !== undefined &&
          existingRepository?.githubRepositoryId !== null &&
          existingRepository?.githubRepositoryId !== undefined) {
        carryId(candidate.orcaRepositoryId);
        remoteUnverifiedIds.add(candidate.orcaRepositoryId);
        projectOverrides.set(existingRepository.canonicalKey, {
          projectKey: manualProject,
          projectOrigin: 'explicit',
        });
      } else {
        bindingInputs.set(candidate.orcaRepositoryId, {
          orcaRepositoryId: candidate.orcaRepositoryId,
          canonicalKey: null,
          projectKey: manualProject,
          origin: 'manual',
          evidence: 'verified',
        });
      }
      diagnostics.push({
        rowIndex: candidate.rowIndex, code: 'remote_unverified', effect: 'remote_unverified',
        entityRef: redactedEntityRef('orca-repository', candidate.orcaRepositoryId),
      });
      addIssue(categoryForRow(candidate.rows[0]!), candidate.orcaRepositoryId);
    } else {
      const reason = candidate.fallback ?? 'invalid_remote';
      addBlock([candidate.orcaRepositoryId], reason, candidate.rowIndex);
      carryId(candidate.orcaRepositoryId);
    }
  }

  const selected: CanonicalCandidate[] = [];
  const autoSlots = repositoryLimit - capacityFloor;
  let selectedNewAuto = 0;
  for (const group of [...canonical.values()].sort((a, b) =>
    compareText(a.identity.canonicalKey, b.identity.canonicalKey))) {
    const ids = [...new Set(group.ids)].sort();
    if (ids.length > options.config.automation.capacity.orcaIdsPerCanonicalRepository) {
      addBlock(idsForCanonical(group.identity.canonicalKey, ids),
        'capacity_conflict', group.rowIndex, group.identity);
      carryCanonical(group.identity.canonicalKey);
      continue;
    }
    const explicitProject = explicitByCanonical.get(group.identity.canonicalKey);
    const manualProjects = new Set(ids.map((id) => manualById.get(id)).filter(
      (value): value is string => value !== undefined));
    if (manualProjects.size > 0 &&
        (explicitProject === undefined || [...manualProjects].some((p) => p !== explicitProject))) {
      addBlock(idsForCanonical(group.identity.canonicalKey, ids),
        'manual_remote_conflict', group.rowIndex, group.identity);
      carryCanonical(group.identity.canonicalKey);
      continue;
    }
    const isNewAuto = explicitProject === undefined && !activeCanonical.has(group.identity.canonicalKey);
    if (isNewAuto && selectedNewAuto >= autoSlots) {
      deferredRepositories += 1;
      addBlock(ids, 'capacity_deferred', group.rowIndex, group.identity, 'group_deferred');
      continue;
    }
    if (isNewAuto) selectedNewAuto += 1;
    selected.push({
      observed: group.identity, rowIndex: group.rowIndex, orcaRepositoryIds: ids,
    });
  }

  const resolvedByNumeric = new Map<number, ResolvedRepository>();
  const conflictedNumeric = new Set<number>();
  for (const candidate of selected) {
    let confirmed: { readonly githubId: number; readonly nameWithOwner: string };
    let authoritative: CanonicalGithubRepository;
    try {
      confirmed = await options.github.confirm(candidate.observed.nameWithOwner);
      if (!Number.isSafeInteger(confirmed.githubId) || confirmed.githubId <= 0) {
        throw new TypeError('GitHub repository identity is invalid');
      }
      authoritative = normalizeGithubNameWithOwner(confirmed.nameWithOwner);
    } catch {
      const priorCanonicals = new Set(candidate.orcaRepositoryIds
        .map((id) => previousBindingById.get(id)?.canonicalKey)
        .filter((key): key is CanonicalGithubRepository['canonicalKey'] => key !== null && key !== undefined));
      const existing = previousByCanonical.get(candidate.observed.canonicalKey) ??
        (priorCanonicals.size === 1 ? previousByCanonical.get([...priorCanonicals][0]!) : undefined);
      if (lkgCompatible && existing?.githubRepositoryId !== null &&
          existing?.githubRepositoryId !== undefined) {
        const observedProject = explicitByCanonical.get(candidate.observed.canonicalKey);
        const durableProject = explicitByCanonical.get(existing.canonicalKey);
        const canonicalChanged = existing.canonicalKey !== candidate.observed.canonicalKey;
        if ((observedProject !== undefined && durableProject !== undefined &&
             observedProject !== durableProject) ||
            (canonicalChanged && observedProject === undefined && durableProject === undefined)) {
          addBlock(
            idsForCanonical(existing.canonicalKey, candidate.orcaRepositoryIds),
            observedProject !== undefined && durableProject !== undefined
              ? 'project_conflict' : 'canonical_conflict',
            candidate.rowIndex,
            candidate.observed,
          );
          carryCanonical(existing.canonicalKey);
          continue;
        }
        carryCanonical(existing.canonicalKey);
        projectOverrides.set(existing.canonicalKey, {
          projectKey: observedProject ?? durableProject ?? existing.projectKey,
          projectOrigin: observedProject !== undefined || durableProject !== undefined
            ? 'explicit' : existing.projectOrigin,
        });
        for (const id of candidate.orcaRepositoryIds) {
          bindingInputs.set(id, {
            orcaRepositoryId: id,
            canonicalKey: existing.canonicalKey,
            projectKey: existing.projectKey,
            origin: 'discovered',
            evidence: 'verified',
          });
        }
        addIssue('github_identity_unverified', candidate.observed.canonicalKey);
        diagnostics.push({
          rowIndex: candidate.rowIndex,
          code: 'github_identity_unverified',
          effect: 'lkg_carried',
          entityRef: redactedEntityRef('github-repository', existing.canonicalKey),
        });
      } else {
        addBlock(candidate.orcaRepositoryIds, 'github_identity_unverified', candidate.rowIndex,
          candidate.observed);
      }
      continue;
    }
    const priorCanonicalKeys = new Set(candidate.orcaRepositoryIds
      .map((id) => previousBindingById.get(id)?.canonicalKey)
      .filter((key): key is CanonicalGithubRepository['canonicalKey'] => key !== null && key !== undefined));
    const priorRepositories = [...priorCanonicalKeys]
      .map((key) => previousByCanonical.get(key))
      .filter((row): row is NonNullable<typeof row> => row !== undefined && row.githubRepositoryId !== null);
    if (priorRepositories.some((row) => row.githubRepositoryId !== confirmed.githubId)) {
      addBlock([
        ...candidate.orcaRepositoryIds,
        ...priorRepositories.flatMap((row) => idsForCanonical(row.canonicalKey)),
      ], 'canonical_conflict', candidate.rowIndex, candidate.observed);
      for (const row of priorRepositories) carryCanonical(row.canonicalKey);
      continue;
    }
    const existingCanonical = previousByCanonical.get(candidate.observed.canonicalKey);
    const existingAuthoritative = previousByCanonical.get(authoritative.canonicalKey);
    const contradictoryExisting = [existingCanonical, existingAuthoritative].find((row) =>
      row?.githubRepositoryId !== null && row?.githubRepositoryId !== undefined &&
      row.githubRepositoryId !== confirmed.githubId);
    if (contradictoryExisting !== undefined) {
      addBlock([
        ...idsForCanonical(candidate.observed.canonicalKey, candidate.orcaRepositoryIds),
        ...idsForCanonical(contradictoryExisting.canonicalKey),
      ],
        'canonical_conflict', candidate.rowIndex, candidate.observed);
      carryCanonical(candidate.observed.canonicalKey);
      carryCanonical(contradictoryExisting.canonicalKey);
      continue;
    }

    const observedProject = explicitByCanonical.get(candidate.observed.canonicalKey);
    const authoritativeProject = explicitByCanonical.get(authoritative.canonicalKey);
    const numericLkg = previousByNumeric.get(confirmed.githubId);
    const priorExplicitProject = numericLkg === undefined
      ? undefined : explicitByCanonical.get(numericLkg.canonicalKey);
    const explicitProjects = new Set(
      [observedProject, authoritativeProject, priorExplicitProject]
        .filter((value): value is string => value !== undefined),
    );
    if (explicitProjects.size > 1) {
      addBlock([
        ...candidate.orcaRepositoryIds,
        ...(numericLkg === undefined ? [] : idsForCanonical(numericLkg.canonicalKey)),
      ], 'project_conflict', candidate.rowIndex, authoritative);
      if (numericLkg !== undefined) carryCanonical(numericLkg.canonicalKey);
      continue;
    }
    const current = resolvedByNumeric.get(confirmed.githubId);
    const projectKey = [...explicitProjects][0] ??
      (current?.identity.canonicalKey === authoritative.canonicalKey
        ? current.projectKey
        : `auto:${authoritative.canonicalKey}`);
    const projectOrigin: EffectiveProjectOrigin = explicitProjects.size === 0
      ? (current?.identity.canonicalKey === authoritative.canonicalKey
          ? current.projectOrigin : 'auto')
      : 'explicit';
    if (conflictedNumeric.has(confirmed.githubId)) {
      addBlock(candidate.orcaRepositoryIds, 'canonical_conflict', candidate.rowIndex, authoritative);
      continue;
    }
    if (current !== undefined &&
        (current.identity.canonicalKey !== authoritative.canonicalKey ||
         current.projectKey !== projectKey)) {
      const old = previousByNumeric.get(confirmed.githubId);
      const ids = [
        ...current.orcaRepositoryIds,
        ...candidate.orcaRepositoryIds,
        ...(old === undefined ? [] : idsForCanonical(old.canonicalKey)),
      ];
      resolvedByNumeric.delete(confirmed.githubId);
      conflictedNumeric.add(confirmed.githubId);
      addBlock(ids,
        current.identity.canonicalKey !== authoritative.canonicalKey
          ? 'canonical_conflict' : 'project_conflict',
        Math.min(current.rowIndex, candidate.rowIndex), authoritative);
      if (old !== undefined) carryCanonical(old.canonicalKey);
      continue;
    }
    if (current === undefined) {
      resolvedByNumeric.set(confirmed.githubId, {
        observedCanonicalKeys: new Set([candidate.observed.canonicalKey]),
        identity: authoritative,
        githubRepositoryId: confirmed.githubId,
        projectKey,
        projectOrigin,
        rowIndex: candidate.rowIndex,
        orcaRepositoryIds: new Set(candidate.orcaRepositoryIds),
      });
    } else {
      current.observedCanonicalKeys.add(candidate.observed.canonicalKey);
      for (const id of candidate.orcaRepositoryIds) current.orcaRepositoryIds.add(id);
    }
  }

  for (const resolved of resolvedByNumeric.values()) {
    repositoryInputs.set(resolved.identity.canonicalKey, repositoryInput(
      resolved.identity,
      resolved.githubRepositoryId,
      resolved.projectKey,
      resolved.projectOrigin,
      'verified',
    ));
    projectOverrides.set(resolved.identity.canonicalKey, {
      projectKey: resolved.projectKey, projectOrigin: resolved.projectOrigin,
    });
    for (const id of resolved.orcaRepositoryIds) {
      bindingInputs.set(id, {
        orcaRepositoryId: id,
        canonicalKey: resolved.identity.canonicalKey,
        projectKey: resolved.projectKey,
        origin: 'discovered',
        evidence: 'verified',
      });
    }
  }

  let durable: EffectiveDiscoverySnapshot;
  try {
    durable = options.store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded',
      repositories: [...repositoryInputs.values()].sort((a, b) =>
        compareText(a.canonicalKey, b.canonicalKey)),
      bindings: [...bindingInputs.values()].sort((a, b) =>
        compareText(a.orcaRepositoryId, b.orcaRepositoryId)),
      issues: uniqueIssues(issues),
      at,
    });
  } catch {
    const effectiveConfig = buildEffectiveBridgeConfig(
      options.config, lkgCompatible ? previous : EMPTY_SNAPSHOT,
      {
        configFingerprint: fingerprint,
        ...(lkgCompatible ? {} : { routingBlock: 'config_drift' as const }),
      },
    );
    return {
      status: 'failed', failure: 'store_failed', configFingerprint: fingerprint,
      snapshot: previous, effectiveConfig,
      counts: resultCounts(source.rows.length, lkgCompatible ? previous : EMPTY_SNAPSHOT, [], 0),
    };
  }

  const effectiveSnapshot: EffectiveDiscoverySnapshot = lkgCompatible ? durable : {
    repositories: durable.repositories.filter((row) =>
      repositoryInputs.get(row.canonicalKey)?.evidence === 'verified'),
    bindings: durable.bindings.filter((row) =>
      bindingInputs.get(row.orcaRepositoryId)?.evidence === 'verified'),
    issues: durable.issues,
  };
  const effectiveConfig = buildEffectiveBridgeConfig(options.config, effectiveSnapshot, {
    configFingerprint: fingerprint,
    blockedBindings: blocks,
    remoteUnverifiedOrcaRepositoryIds: remoteUnverifiedIds,
    diagnostics,
    repositoryProjects: projectOverrides,
  });
  return {
    status: 'succeeded', configFingerprint: fingerprint, snapshot: durable, effectiveConfig,
    counts: resultCounts(source.rows.length, effectiveSnapshot, blocks, deferredRepositories),
  };
}

function identityFromRecord(
  canonicalKey: string,
  nameWithOwner: string,
): CanonicalGithubRepository {
  const normalized = normalizeGithubNameWithOwner(nameWithOwner);
  if (normalized.canonicalKey !== canonicalKey) {
    throw new TypeError('durable canonical repository identity is inconsistent');
  }
  return normalized;
}
