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
  | 'github_unavailable'
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
  /** Required proof for consuming durable LKG. Null explicitly declares that no LKG is trusted. */
  readonly lastKnownGoodConfigFingerprint: string | null;
  /** Cancels GitHub confirmation and makes the whole pass fail without a store write. */
  readonly signal?: AbortSignal;
  /** Optional earlier absolute epoch deadline; config still supplies the hard upper bound. */
  readonly deadlineAt?: number;
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

type ConfirmedCandidate = CanonicalCandidate & {
  readonly authoritative: CanonicalGithubRepository;
  readonly githubRepositoryId: number;
};

class RepositoryConfirmationDeadlineError extends Error {
  constructor() {
    super('GitHub repository confirmation deadline exceeded');
    this.name = 'RepositoryConfirmationDeadlineError';
  }
}

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

function autoProjectKey(identity: CanonicalGithubRepository): string {
  return `auto:${identity.canonicalKey}`;
}

async function confirmBeforeDeadline(
  confirmer: RepositoryIdentityConfirmer,
  candidate: CanonicalCandidate,
  deadlineAt: number,
  externalSignal: AbortSignal | undefined,
): Promise<ConfirmedCandidate> {
  const remaining = Math.trunc(deadlineAt - Date.now());
  if (externalSignal?.aborted === true || remaining <= 0) {
    throw new RepositoryConfirmationDeadlineError();
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectCancellation!: (error: RepositoryConfirmationDeadlineError) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (): void => {
    controller.abort();
    rejectCancellation(new RepositoryConfirmationDeadlineError());
  };
  externalSignal?.addEventListener('abort', cancel, { once: true });
  timer = setTimeout(cancel, remaining);
  try {
    const confirmed = await Promise.race([
      confirmer.confirm(candidate.observed.nameWithOwner, {
        signal: controller.signal,
        deadlineAt,
      }),
      cancellation,
    ]);
    if (controller.signal.aborted || Boolean(externalSignal?.aborted) || Date.now() >= deadlineAt) {
      throw new RepositoryConfirmationDeadlineError();
    }
    if (!Number.isSafeInteger(confirmed.githubId) || confirmed.githubId <= 0) {
      throw new TypeError('GitHub repository identity is invalid');
    }
    return {
      ...candidate,
      authoritative: normalizeGithubNameWithOwner(confirmed.nameWithOwner),
      githubRepositoryId: confirmed.githubId,
    };
  } catch (error) {
    if (controller.signal.aborted || Boolean(externalSignal?.aborted) || Date.now() >= deadlineAt) {
      throw new RepositoryConfirmationDeadlineError();
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    externalSignal?.removeEventListener('abort', cancel);
  }
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
  const lkgProof = options.lastKnownGoodConfigFingerprint as string | null | undefined;
  const lkgCompatible = typeof lkgProof === 'string' && lkgProof === fingerprint;
  const previous = options.store.readEffectiveDiscoverySnapshot();
  const hasDurableLkg = previous.repositories.length > 0 || previous.bindings.length > 0;
  const lkgProofFailed = lkgProof === undefined || (hasDurableLkg && !lkgCompatible);

  const failedFromPrevious = (
    requestedFailure: RepositoryDiscoveryFailure,
    sourceRows: number,
    blocks: readonly EffectiveBindingBlock[] = [],
    diagnostics: readonly RepositoryDiscoveryDiagnostic[] = [],
    deferredRepositories = 0,
    routingBlock?: 'capacity_conflict',
  ): RepositoryDiscoveryPassResult => {
    const failure = lkgProofFailed ? 'config_drift' : requestedFailure;
    const usable = lkgCompatible ? previous : EMPTY_SNAPSHOT;
    const effectiveConfig = buildEffectiveBridgeConfig(options.config, usable, {
      configFingerprint: fingerprint,
      blockedBindings: blocks,
      diagnostics,
      ...(lkgProofFailed
        ? { routingBlock: 'config_drift' as const }
        : routingBlock === undefined ? {} : { routingBlock }),
    });
    return {
      status: 'failed',
      failure,
      configFingerprint: fingerprint,
      snapshot: previous,
      effectiveConfig,
      counts: resultCounts(sourceRows, usable, blocks, deferredRepositories),
    };
  };

  let source: RepositoryDiscoverySnapshot;
  try {
    source = await listRepositories(options.orca,
      options.signal === undefined ? undefined : { signal: options.signal });
  } catch (error) {
    const failure: RepositoryDiscoveryFailure = error instanceof OrcaRepositoryContractError &&
      error.code !== 'ORCA_REPOSITORY_COMMAND_FAILED' ? 'schema_drift' : 'query_failed';
    // An envelope that was not accepted has no authority to mutate registry, bindings, or issues.
    return failedFromPrevious(failure, 0);
  }

  const repositoryLimit = options.config.automation.capacity.repositories;
  const idLimit = options.config.automation.capacity.orcaIdsPerCanonicalRepository;
  const explicitByCanonical = new Map<string, string>();
  const manualById = new Map<string, string>();
  for (const project of options.config.projects) {
    for (const name of project.repositories) {
      explicitByCanonical.set(normalizeGithubNameWithOwner(name).canonicalKey, project.name);
    }
    for (const id of project.orcaRepositoryIds) manualById.set(id, project.name);
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
  const idsForNumeric = (numeric: number, extra: readonly string[] = []): string[] => {
    const repository = previousByNumeric.get(numeric);
    return repository === undefined ? [...new Set(extra)].sort() :
      idsForCanonical(repository.canonicalKey, extra);
  };

  const configuredByProject = new Map(
    options.config.projects.map((project) => [project.name, project.repositories.length]),
  );
  const priorExplicitByProject = new Map<string, Set<number>>();
  for (const repository of previous.repositories) {
    if (repository.projectOrigin !== 'explicit' || repository.githubRepositoryId === null) continue;
    const ids = priorExplicitByProject.get(repository.projectKey) ?? new Set<number>();
    ids.add(repository.githubRepositoryId);
    priorExplicitByProject.set(repository.projectKey, ids);
  }
  let explicitCapacityFloor = 0;
  for (const projectKey of new Set([
    ...configuredByProject.keys(), ...priorExplicitByProject.keys(),
  ])) {
    explicitCapacityFloor += Math.max(
      configuredByProject.get(projectKey) ?? 0,
      priorExplicitByProject.get(projectKey)?.size ?? 0,
    );
  }
  const activeAutoNumeric = new Set<number>();
  for (const repository of previous.repositories) {
    if (repository.projectOrigin !== 'auto' || repository.githubRepositoryId === null) continue;
    const stableAlias = repository.projectKey.startsWith('auto:')
      ? repository.projectKey.slice('auto:'.length) : '';
    if (explicitByCanonical.has(repository.canonicalKey) || explicitByCanonical.has(stableAlias)) {
      continue;
    }
    activeAutoNumeric.add(repository.githubRepositoryId);
  }
  const capacityFloor = explicitCapacityFloor + activeAutoNumeric.size;
  if (explicitByCanonical.size > repositoryLimit || capacityFloor > repositoryLimit) {
    const diagnostics: RepositoryDiscoveryDiagnostic[] = [{
      rowIndex: -1,
      code: 'capacity_conflict',
      effect: 'group_blocked',
      entityRef: redactedEntityRef('repository-capacity', String(capacityFloor)),
    }];
    return failedFromPrevious(
      'capacity_conflict', source.rows.length, [], diagnostics, 0, 'capacity_conflict',
    );
  }

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
  const carryNumeric = (numeric: number): void => {
    const repository = previousByNumeric.get(numeric);
    if (repository !== undefined) carryCanonical(repository.canonicalKey);
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

  const eligible: CanonicalCandidate[] = [];
  for (const group of [...canonical.values()].sort((a, b) =>
    compareText(a.identity.canonicalKey, b.identity.canonicalKey))) {
    const ids = [...new Set(group.ids)].sort();
    if (ids.length > idLimit) {
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
    eligible.push({
      observed: group.identity, rowIndex: group.rowIndex, orcaRepositoryIds: ids,
    });
  }

  const handleGithubFailure = (candidate: CanonicalCandidate): void => {
      const priorCanonicals = new Set(candidate.orcaRepositoryIds
        .map((id) => previousBindingById.get(id)?.canonicalKey)
        .filter((key): key is CanonicalGithubRepository['canonicalKey'] => key !== null && key !== undefined));
      const existing = previousByCanonical.get(candidate.observed.canonicalKey) ??
        (priorCanonicals.size === 1 ? previousByCanonical.get([...priorCanonicals][0]!) : undefined);
      if (lkgCompatible && existing?.githubRepositoryId !== null &&
          existing?.githubRepositoryId !== undefined) {
        if (priorCanonicals.size > 1 ||
            (priorCanonicals.size === 1 && !priorCanonicals.has(existing.canonicalKey))) {
          const ids = [
            ...candidate.orcaRepositoryIds,
            ...[...priorCanonicals].flatMap((key) => idsForCanonical(key)),
          ];
          addBlock(ids, 'canonical_conflict', candidate.rowIndex, candidate.observed);
          for (const key of priorCanonicals) carryCanonical(key);
          return;
        }
        const observedProject = explicitByCanonical.get(candidate.observed.canonicalKey);
        const durableProject = existing.projectOrigin === 'explicit'
          ? existing.projectKey : explicitByCanonical.get(existing.canonicalKey);
        const canonicalChanged = existing.canonicalKey !== candidate.observed.canonicalKey;
        const autoAliasProven = existing.projectOrigin === 'auto' &&
          existing.projectKey === autoProjectKey(candidate.observed);
        const explicitAliasProven = observedProject !== undefined &&
          durableProject === observedProject;
        if (observedProject !== undefined && durableProject !== undefined &&
            observedProject !== durableProject) {
          addBlock(
            idsForCanonical(existing.canonicalKey, candidate.orcaRepositoryIds),
            'project_conflict',
            candidate.rowIndex,
            candidate.observed,
          );
          carryCanonical(existing.canonicalKey);
          return;
        }
        if (canonicalChanged && !autoAliasProven && !explicitAliasProven) {
          addBlock(
            idsForCanonical(existing.canonicalKey, candidate.orcaRepositoryIds),
            'canonical_conflict', candidate.rowIndex, candidate.observed,
          );
          carryCanonical(existing.canonicalKey);
          return;
        }
        const allIds = idsForNumeric(existing.githubRepositoryId, candidate.orcaRepositoryIds);
        if (allIds.length > idLimit) {
          addBlock(allIds, 'capacity_conflict', candidate.rowIndex, candidate.observed);
          carryCanonical(existing.canonicalKey);
          return;
        }
        carryCanonical(existing.canonicalKey);
        const projectKey = observedProject ?? existing.projectKey;
        const projectOrigin: EffectiveProjectOrigin = observedProject === undefined
          ? existing.projectOrigin : 'explicit';
        projectOverrides.set(existing.canonicalKey, {
          projectKey,
          projectOrigin,
        });
        for (const id of candidate.orcaRepositoryIds) {
          bindingInputs.set(id, {
            orcaRepositoryId: id,
            canonicalKey: existing.canonicalKey,
            projectKey,
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
  };

  const configuredDeadline = Date.now() +
    options.config.automation.repositoryDiscovery.timeoutSeconds * 1_000;
  const deadlineAt = options.deadlineAt === undefined
    ? configuredDeadline
    : Number.isFinite(options.deadlineAt)
      ? Math.min(configuredDeadline, Math.trunc(options.deadlineAt))
      : Date.now() - 1;
  const related: CanonicalCandidate[] = [];
  const newAuto: CanonicalCandidate[] = [];
  for (const candidate of eligible) {
    const prior = candidate.orcaRepositoryIds.some((id) => {
      const canonicalKey = previousBindingById.get(id)?.canonicalKey;
      if (canonicalKey === null || canonicalKey === undefined) return false;
      return previousByCanonical.get(canonicalKey)?.githubRepositoryId != null;
    });
    const observedLkg = previousByCanonical.get(candidate.observed.canonicalKey);
    if (explicitByCanonical.has(candidate.observed.canonicalKey) ||
        observedLkg?.githubRepositoryId != null ||
        prior) {
      related.push(candidate);
    } else {
      newAuto.push(candidate);
    }
  }

  const confirmed: ConfirmedCandidate[] = [];
  const newAutoNumerics = new Set<number>();
  const attempt = async (candidate: CanonicalCandidate): Promise<void> => {
    try {
      const row = await confirmBeforeDeadline(
        options.github, candidate, deadlineAt, options.signal,
      );
      confirmed.push(row);
      const explicit = explicitByCanonical.has(row.observed.canonicalKey) ||
        explicitByCanonical.has(row.authoritative.canonicalKey);
      if (!explicit && !previousByNumeric.has(row.githubRepositoryId)) {
        newAutoNumerics.add(row.githubRepositoryId);
      }
    } catch (error) {
      if (error instanceof RepositoryConfirmationDeadlineError) throw error;
      handleGithubFailure(candidate);
    }
  };

  try {
    for (const candidate of related) await attempt(candidate);
    const autoSlots = repositoryLimit - capacityFloor;
    for (const candidate of newAuto) {
      if (newAutoNumerics.size >= autoSlots) {
        deferredRepositories += 1;
        addBlock(
          candidate.orcaRepositoryIds, 'capacity_deferred', candidate.rowIndex,
          candidate.observed, 'group_deferred',
        );
        continue;
      }
      await attempt(candidate);
    }
  } catch (error) {
    if (!(error instanceof RepositoryConfirmationDeadlineError)) throw error;
    // A deadline makes all GitHub evidence from this pass unusable. Overlay every current group on
    // the unchanged LKG so no already-confirmed prefix can leak as a partial identity snapshot.
    for (const candidate of eligible) {
      addBlock(
        idsForCanonical(candidate.observed.canonicalKey, candidate.orcaRepositoryIds),
        'github_identity_unverified', candidate.rowIndex, candidate.observed,
      );
    }
    return failedFromPrevious(
      'github_unavailable', source.rows.length, blocks, diagnostics, deferredRepositories,
    );
  }

  const confirmedByNumeric = new Map<number, ConfirmedCandidate[]>();
  for (const row of confirmed) {
    const rows = confirmedByNumeric.get(row.githubRepositoryId) ?? [];
    rows.push(row);
    confirmedByNumeric.set(row.githubRepositoryId, rows);
  }
  const conflictedNumeric = new Set<number>();
  const currentIdsForNumeric = (numeric: number): string[] => [
    ...new Set((confirmedByNumeric.get(numeric) ?? [])
      .flatMap((row) => row.orcaRepositoryIds)),
  ].sort();
  const markNumericConflict = (
    numerics: ReadonlySet<number>,
    reason: 'canonical_conflict' | 'project_conflict',
    rowIndex: number,
    identity: CanonicalGithubRepository,
  ): void => {
    const ids = [...numerics].flatMap((numeric) => [
      ...currentIdsForNumeric(numeric), ...idsForNumeric(numeric),
    ]);
    for (const numeric of numerics) {
      conflictedNumeric.add(numeric);
      carryNumeric(numeric);
    }
    addBlock(ids, reason, rowIndex, identity);
  };

  const evidenceByCanonical = new Map<string, ConfirmedCandidate[]>();
  for (const row of confirmed) {
    for (const canonicalKey of [row.observed.canonicalKey, row.authoritative.canonicalKey]) {
      const rows = evidenceByCanonical.get(canonicalKey) ?? [];
      rows.push(row);
      evidenceByCanonical.set(canonicalKey, rows);
    }
  }
  for (const rows of evidenceByCanonical.values()) {
    const numerics = new Set(rows.map((row) => row.githubRepositoryId));
    if (numerics.size > 1) {
      markNumericConflict(
        numerics,
        'canonical_conflict',
        Math.min(...rows.map((row) => row.rowIndex)),
        rows[0]!.authoritative,
      );
    }
  }
  for (const row of confirmed) {
    const linked = new Set<number>();
    for (const canonicalKey of [
      row.observed.canonicalKey,
      row.authoritative.canonicalKey,
      ...row.orcaRepositoryIds.map((id) => previousBindingById.get(id)?.canonicalKey)
        .filter((key): key is CanonicalGithubRepository['canonicalKey'] =>
          key !== null && key !== undefined),
    ]) {
      const numeric = previousByCanonical.get(canonicalKey)?.githubRepositoryId;
      if (numeric !== null && numeric !== undefined) linked.add(numeric);
    }
    const contradictory = new Set([...linked].filter((numeric) =>
      numeric !== row.githubRepositoryId));
    if (contradictory.size > 0) {
      markNumericConflict(
        new Set([row.githubRepositoryId, ...contradictory]),
        'canonical_conflict', row.rowIndex, row.authoritative,
      );
    }
  }

  const resolvedByNumeric = new Map<number, ResolvedRepository>();
  for (const [numeric, rows] of [...confirmedByNumeric.entries()].sort(([a], [b]) => a - b)) {
    if (conflictedNumeric.has(numeric)) continue;
    const authoritativeKeys = new Set(rows.map((row) => row.authoritative.canonicalKey));
    if (authoritativeKeys.size !== 1) {
      markNumericConflict(
        new Set([numeric]), 'canonical_conflict',
        Math.min(...rows.map((row) => row.rowIndex)), rows[0]!.authoritative,
      );
      continue;
    }
    const numericLkg = previousByNumeric.get(numeric);
    const explicitProjects = new Set<string>();
    const addExplicitProject = (
      canonicalKey: CanonicalGithubRepository['canonicalKey'],
    ): void => {
      const configured = explicitByCanonical.get(canonicalKey);
      if (configured !== undefined) explicitProjects.add(configured);
      const durable = previousByCanonical.get(canonicalKey);
      if (durable?.projectOrigin === 'explicit') explicitProjects.add(durable.projectKey);
    };
    if (numericLkg?.projectOrigin === 'explicit') explicitProjects.add(numericLkg.projectKey);
    for (const row of rows) {
      addExplicitProject(row.observed.canonicalKey);
      addExplicitProject(row.authoritative.canonicalKey);
      for (const id of row.orcaRepositoryIds) {
        const canonicalKey = previousBindingById.get(id)?.canonicalKey;
        if (canonicalKey !== null && canonicalKey !== undefined) addExplicitProject(canonicalKey);
      }
    }
    const identity = rows[0]!.authoritative;
    const rowIndex = Math.min(...rows.map((row) => row.rowIndex));
    if (explicitProjects.size > 1) {
      markNumericConflict(new Set([numeric]), 'project_conflict', rowIndex, identity);
      continue;
    }
    const observedCanonicalKeys = new Set(rows.map((row) => row.observed.canonicalKey));
    const firstObservedCanonical = [...observedCanonicalKeys].sort(compareText)[0]!;
    const projectKey = [...explicitProjects][0] ??
      (numericLkg?.projectOrigin === 'auto'
        ? numericLkg.projectKey
        : `auto:${firstObservedCanonical}`);
    const projectOrigin: EffectiveProjectOrigin = explicitProjects.size === 0 ? 'auto' : 'explicit';
    const currentIds = [...new Set(rows.flatMap((row) => row.orcaRepositoryIds))].sort();
    const allIds = idsForNumeric(numeric, currentIds);
    if (allIds.length > idLimit) {
      addBlock(allIds, 'capacity_conflict', rowIndex, identity);
      carryNumeric(numeric);
      continue;
    }
    resolvedByNumeric.set(numeric, {
      observedCanonicalKeys,
      identity,
      githubRepositoryId: numeric,
      projectKey,
      projectOrigin,
      rowIndex,
      orcaRepositoryIds: new Set(currentIds),
    });
  }

  for (const resolved of resolvedByNumeric.values()) {
    const numericLkg = previousByNumeric.get(resolved.githubRepositoryId);
    if (numericLkg !== undefined && numericLkg.canonicalKey !== resolved.identity.canonicalKey) {
      repositoryInputs.delete(numericLkg.canonicalKey);
    }
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

  const projectedAutoNumeric = new Set(activeAutoNumeric);
  for (const repository of repositoryInputs.values()) {
    if (repository.githubRepositoryId === null) continue;
    if (repository.projectOrigin === 'auto') projectedAutoNumeric.add(repository.githubRepositoryId);
    else projectedAutoNumeric.delete(repository.githubRepositoryId);
  }
  if (explicitCapacityFloor + projectedAutoNumeric.size > repositoryLimit) {
    diagnostics.push({
      rowIndex: -1,
      code: 'capacity_conflict',
      effect: 'group_blocked',
      entityRef: redactedEntityRef(
        'repository-capacity', String(explicitCapacityFloor + projectedAutoNumeric.size),
      ),
    });
    return failedFromPrevious(
      'capacity_conflict', source.rows.length, blocks, diagnostics,
      deferredRepositories, 'capacity_conflict',
    );
  }

  const renameCanonical = new Map<string, string>();
  for (const repository of repositoryInputs.values()) {
    if (repository.githubRepositoryId === null) continue;
    const prior = previousByNumeric.get(repository.githubRepositoryId);
    if (prior !== undefined) renameCanonical.set(prior.canonicalKey, repository.canonicalKey);
  }
  const inactiveCutoff = Date.parse(at) - 24 * 60 * 60 * 1_000;
  const projectedBindings = new Map<string, string | null>();
  for (const binding of previous.bindings) {
    const submitted = bindingInputs.get(binding.orcaRepositoryId);
    const remainsActive = submitted !== undefined ||
      !(binding.consecutiveMissingPasses >= 1 && Date.parse(binding.lastSeenAt) <= inactiveCutoff);
    if (!remainsActive) continue;
    const canonicalKey = submitted?.canonicalKey ?? binding.canonicalKey;
    projectedBindings.set(
      binding.orcaRepositoryId,
      canonicalKey === null ? null : renameCanonical.get(canonicalKey) ?? canonicalKey,
    );
  }
  for (const binding of bindingInputs.values()) {
    if (projectedBindings.has(binding.orcaRepositoryId)) continue;
    projectedBindings.set(
      binding.orcaRepositoryId,
      binding.canonicalKey === null
        ? null : renameCanonical.get(binding.canonicalKey) ?? binding.canonicalKey,
    );
  }
  const projectedIdsByCanonical = new Map<string, string[]>();
  for (const [id, canonicalKey] of projectedBindings) {
    if (canonicalKey === null) continue;
    const ids = projectedIdsByCanonical.get(canonicalKey) ?? [];
    ids.push(id);
    projectedIdsByCanonical.set(canonicalKey, ids);
  }
  for (const [canonicalKey, ids] of projectedIdsByCanonical) {
    const ordered = [...new Set(ids)].sort();
    if (ordered.length <= idLimit) continue;
    addBlock(
      ordered, 'capacity_conflict', -1, identityFromRecord(
        canonicalKey, canonicalKey.slice('github.com/'.length),
      ),
    );
    return failedFromPrevious(
      'capacity_conflict', source.rows.length, blocks, diagnostics, deferredRepositories,
    );
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
        blockedBindings: blocks,
        remoteUnverifiedOrcaRepositoryIds: remoteUnverifiedIds,
        diagnostics,
        repositoryProjects: projectOverrides,
        ...(lkgProofFailed ? { routingBlock: 'config_drift' as const } : {}),
      },
    );
    return {
      status: 'failed', failure: lkgProofFailed ? 'config_drift' : 'store_failed',
      configFingerprint: fingerprint,
      snapshot: previous, effectiveConfig,
      counts: resultCounts(
        source.rows.length, lkgCompatible ? previous : EMPTY_SNAPSHOT,
        blocks, deferredRepositories,
      ),
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
