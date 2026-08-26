import { createHash } from 'node:crypto';
import { normalizeGithubNameWithOwner } from './github-remote.js';
import type {
  CanonicalGithubRepository,
  EffectiveBridgeConfig,
  EffectiveProject,
  EffectiveProjectOrigin,
  EffectiveRepositoryBinding,
  EffectiveRoutingState,
  RepositoryDiscoveryDiagnostic,
} from './types.js';
import {
  AUTO_PROJECT_KEY_PREFIX,
  isReservedAutoProjectName,
  type ParsedBridgeConfig,
} from '../project/config.js';
import type {
  EffectiveDiscoverySnapshot,
} from '../store/operational-types.js';

export type EffectiveBindingBlock = {
  readonly orcaRepositoryIds: readonly string[];
  readonly reason: Extract<EffectiveRepositoryBinding, { readonly status: 'blocked' }>['reason'];
  readonly identity?: CanonicalGithubRepository;
};

export type EffectiveConfigBuildOptions = {
  readonly configFingerprint?: string;
  readonly blockedBindings?: readonly EffectiveBindingBlock[];
  /** Explicit fallbacks that retained numeric LKG while the current live remote was unverifiable. */
  readonly remoteUnverifiedOrcaRepositoryIds?: ReadonlySet<string>;
  readonly diagnostics?: readonly RepositoryDiscoveryDiagnostic[];
  /** Authoritative project decisions made while resolving a rename in the current pass. */
  readonly repositoryProjects?: ReadonlyMap<string, {
    readonly projectKey: string;
    readonly projectOrigin: EffectiveProjectOrigin;
  }>;
  readonly routingBlock?: Extract<EffectiveRoutingState, { readonly status: 'blocked' }>['reason'];
};

type MutableProject = {
  key: string;
  name: string;
  origin: EffectiveProjectOrigin;
  repositories: Map<string, CanonicalGithubRepository>;
  orcaRepositoryIds: Set<string>;
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (typeof input !== 'object' || input === null) return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .sort(([a], [b]) => compareText(a, b))
        .map(([key, child]) => [key, normalize(child)]),
    );
  };
  return JSON.stringify(normalize(value));
}

export function bridgeConfigFingerprint(config: ParsedBridgeConfig): string {
  return createHash('sha256').update(canonicalJson(config), 'utf8').digest('hex');
}

function contentRevision(value: unknown): number {
  const hex = createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex').slice(0, 12);
  return Number.parseInt(hex, 16);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function clonedConfig(config: ParsedBridgeConfig): ParsedBridgeConfig {
  return JSON.parse(JSON.stringify(config)) as ParsedBridgeConfig;
}

function identityFromCanonical(canonicalKey: string): CanonicalGithubRepository {
  return normalizeGithubNameWithOwner(canonicalKey.slice('github.com/'.length));
}

function boundKey(
  identity: CanonicalGithubRepository | null,
  projectKey: string,
  verification: 'github_verified' | 'remote_unverified',
): string {
  return `${identity?.canonicalKey ?? 'manual'}\u0000${projectKey}\u0000${verification}`;
}

/**
 * Builds the sole Run-routing input from explicit configuration plus active durable evidence.
 * The returned graph is deeply frozen and its numeric revision is derived from canonical content.
 */
export function buildEffectiveBridgeConfig(
  config: ParsedBridgeConfig,
  snapshot: EffectiveDiscoverySnapshot,
  options: EffectiveConfigBuildOptions = {},
): EffectiveBridgeConfig {
  const fingerprint = options.configFingerprint ?? bridgeConfigFingerprint(config);
  const projects = new Map<string, MutableProject>();
  const explicitByCanonical = new Map<string, string>();
  const manualById = new Map<string, string>();
  let projectNamespaceConflict = config.projects.some((project) =>
    isReservedAutoProjectName(project.name));
  const namespaceConflictCanonicals = new Set<string>();

  for (const project of config.projects) {
    const mutable: MutableProject = {
      key: project.name,
      name: project.name,
      origin: 'explicit',
      repositories: new Map(),
      orcaRepositoryIds: new Set(),
    };
    for (const configuredName of project.repositories) {
      const identity = normalizeGithubNameWithOwner(configuredName);
      mutable.repositories.set(identity.canonicalKey, identity);
      explicitByCanonical.set(identity.canonicalKey, project.name);
    }
    for (const id of project.orcaRepositoryIds) manualById.set(id, project.name);
    projects.set(project.name, mutable);
  }

  const blockedById = new Map<string, EffectiveBindingBlock>();
  for (const block of options.blockedBindings ?? []) {
    for (const id of block.orcaRepositoryIds) blockedById.set(id, block);
  }

  // Defense in depth for snapshots produced by an older writer. Reconciliation normally catches
  // this before its transaction, but an already-over-limit LKG must still route zero for the
  // complete canonical group rather than reviving the first sixteen aliases.
  const idsByCanonical = new Map<string, string[]>();
  for (const binding of snapshot.bindings) {
    if (binding.canonicalKey === null) continue;
    const ids = idsByCanonical.get(binding.canonicalKey) ?? [];
    ids.push(binding.orcaRepositoryId);
    idsByCanonical.set(binding.canonicalKey, ids);
  }
  for (const [canonicalKey, ids] of idsByCanonical) {
    const ordered = [...new Set(ids)].sort(compareText);
    if (ordered.length <= config.automation.capacity.orcaIdsPerCanonicalRepository) continue;
    const block: EffectiveBindingBlock = {
      orcaRepositoryIds: ordered,
      reason: 'capacity_conflict',
      identity: identityFromCanonical(canonicalKey),
    };
    for (const id of ordered) blockedById.set(id, block);
  }

  const repositories = new Map(snapshot.repositories.map((row) => [row.canonicalKey, row]));
  const repositoryProject = new Map<string, {
    readonly projectKey: string;
    readonly projectOrigin: EffectiveProjectOrigin;
  }>();

  for (const repository of [...snapshot.repositories].sort((a, b) =>
    compareText(a.canonicalKey, b.canonicalKey))) {
    if (repository.githubRepositoryId === null) continue;
    const override = options.repositoryProjects?.get(repository.canonicalKey);
    const explicit = explicitByCanonical.get(repository.canonicalKey);
    let assignment: { projectKey: string; projectOrigin: EffectiveProjectOrigin } | null = null;
    if (override !== undefined) {
      assignment = override;
    } else if (explicit !== undefined) {
      assignment = { projectKey: explicit, projectOrigin: 'explicit' };
    } else if (repository.projectOrigin === 'auto') {
      // Auto Project keys remain stable across an authoritative GitHub rename. Besides avoiding
      // downstream identity churn, the durable key records the observed alias that GitHub already
      // proved, which lets a later bounded outage carry that rename without guessing.
      assignment = { projectKey: repository.projectKey, projectOrigin: 'auto' };
    } else if (projects.has(repository.projectKey)) {
      // A current-pass verified rename can keep an explicit Project while its configured display
      // spelling catches up. Stale explicit rows without a surviving Project are never trusted.
      assignment = { projectKey: repository.projectKey, projectOrigin: 'explicit' };
    }
    if (assignment === null) continue;
    const existingProject = projects.get(assignment.projectKey);
    if (assignment.projectOrigin === 'auto' &&
        (!assignment.projectKey.startsWith(AUTO_PROJECT_KEY_PREFIX) ||
         existingProject?.origin === 'explicit')) {
      projectNamespaceConflict = true;
      namespaceConflictCanonicals.add(repository.canonicalKey);
      continue;
    }
    repositoryProject.set(repository.canonicalKey, assignment);
    let project = existingProject;
    if (project === undefined && assignment.projectOrigin === 'auto') {
      project = {
        key: assignment.projectKey,
        name: repository.nameWithOwner,
        origin: 'auto',
        repositories: new Map(),
        orcaRepositoryIds: new Set(),
      };
      projects.set(project.key, project);
    }
    project?.repositories.set(repository.canonicalKey, identityFromCanonical(repository.canonicalKey));
  }

  type MutableBound = {
    status: 'bound';
    identity: CanonicalGithubRepository | null;
    githubRepositoryId: number | null;
    projectKey: string;
    projectOrigin: EffectiveProjectOrigin;
    verification: 'github_verified' | 'remote_unverified';
    orcaRepositoryIds: Set<string>;
  };
  const bound = new Map<string, MutableBound>();
  const addBound = (
    id: string,
    identity: CanonicalGithubRepository | null,
    githubRepositoryId: number | null,
    projectKey: string,
    projectOrigin: EffectiveProjectOrigin,
    verification: 'github_verified' | 'remote_unverified',
  ): void => {
    if (blockedById.has(id)) return;
    const key = boundKey(identity, projectKey, verification);
    let row = bound.get(key);
    if (row === undefined) {
      row = {
        status: 'bound', identity, githubRepositoryId, projectKey, projectOrigin,
        verification, orcaRepositoryIds: new Set(),
      };
      bound.set(key, row);
    }
    row.orcaRepositoryIds.add(id);
    projects.get(projectKey)?.orcaRepositoryIds.add(id);
  };

  for (const binding of [...snapshot.bindings].sort((a, b) =>
    compareText(a.orcaRepositoryId, b.orcaRepositoryId))) {
    if (blockedById.has(binding.orcaRepositoryId)) continue;
    if (binding.canonicalKey === null) {
      const manualProject = manualById.get(binding.orcaRepositoryId);
      if (manualProject !== undefined && manualProject === binding.projectKey) {
        addBound(binding.orcaRepositoryId, null, null, manualProject, 'explicit', 'remote_unverified');
      } else {
        blockedById.set(binding.orcaRepositoryId, {
          orcaRepositoryIds: [binding.orcaRepositoryId], reason: 'project_conflict',
        });
      }
      continue;
    }
    const repository = repositories.get(binding.canonicalKey);
    const assignment = repositoryProject.get(binding.canonicalKey);
    if (namespaceConflictCanonicals.has(binding.canonicalKey)) {
      blockedById.set(binding.orcaRepositoryId, {
        orcaRepositoryIds: [binding.orcaRepositoryId], reason: 'project_conflict',
        ...(repository === undefined ? {} : { identity: identityFromCanonical(repository.canonicalKey) }),
      });
      continue;
    }
    if (repository?.githubRepositoryId === null || repository === undefined || assignment === undefined) {
      blockedById.set(binding.orcaRepositoryId, {
        orcaRepositoryIds: [binding.orcaRepositoryId], reason: 'github_identity_unverified',
        ...(repository === undefined ? {} : { identity: identityFromCanonical(repository.canonicalKey) }),
      });
      continue;
    }
    addBound(
      binding.orcaRepositoryId,
      identityFromCanonical(repository.canonicalKey),
      repository.githubRepositoryId,
      assignment.projectKey,
      assignment.projectOrigin,
      options.remoteUnverifiedOrcaRepositoryIds?.has(binding.orcaRepositoryId) === true
        ? 'remote_unverified' : 'github_verified',
    );
  }

  // Manual configuration remains the D1 fallback even before the first discovery pass.
  for (const [id, projectKey] of [...manualById].sort(([a], [b]) => compareText(a, b))) {
    if ([...bound.values()].some((row) => row.orcaRepositoryIds.has(id))) continue;
    addBound(id, null, null, projectKey, 'explicit', 'remote_unverified');
  }

  const bindings: EffectiveRepositoryBinding[] = [
    ...[...bound.values()].map((row): EffectiveRepositoryBinding => ({
      ...row,
      orcaRepositoryIds: [...row.orcaRepositoryIds].sort(),
    })),
    ...[...new Set(blockedById.values())].map((row): EffectiveRepositoryBinding => ({
      status: 'blocked',
      reason: row.reason,
      orcaRepositoryIds: [...row.orcaRepositoryIds].sort(),
      ...(row.identity === undefined ? {} : { identity: { ...row.identity } }),
    })),
  ].sort((a, b) => {
    const ak = a.orcaRepositoryIds[0] ?? '';
    const bk = b.orcaRepositoryIds[0] ?? '';
    return compareText(ak, bk);
  });

  const effectiveProjects: EffectiveProject[] = [...projects.values()]
    .map((project) => ({
      key: project.key,
      name: project.name,
      origin: project.origin,
      repositories: [...project.repositories.values()].sort((a, b) =>
        compareText(a.canonicalKey, b.canonicalKey)),
      orcaRepositoryIds: [...project.orcaRepositoryIds].sort(),
    }))
    .sort((a, b) => compareText(a.key, b.key));

  // Configured repositories consume their explicit slots. A GitHub-confirmed spelling change in
  // the same explicit Project is not an extra repository, while every auto numeric identity is.
  const effectiveRepositoryCount = explicitByCanonical.size + new Set(
    snapshot.repositories
      .filter((repository) => repository.githubRepositoryId !== null &&
        repositoryProject.get(repository.canonicalKey)?.projectOrigin === 'auto')
      .map((repository) => repository.githubRepositoryId as number),
  ).size;
  const routingBlock = projectNamespaceConflict
    ? 'project_conflict'
    : options.routingBlock ?? (
      effectiveRepositoryCount > config.automation.capacity.repositories ? 'capacity_conflict' : undefined
    );
  const blockedBindingCount = bindings.filter((row) => row.status === 'blocked')
    .reduce((count, row) => count + row.orcaRepositoryIds.length, 0);
  const routing: EffectiveRoutingState = routingBlock !== undefined
    ? { status: 'blocked', reason: routingBlock }
    : blockedBindingCount === 0
      ? { status: 'ready' }
      : { status: 'partially_blocked', blockedBindingCount };
  const diagnostics = (options.diagnostics ?? []).map((row) => ({ ...row })).sort((a, b) =>
    a.rowIndex - b.rowIndex || compareText(a.code, b.code));
  // rowIndex is useful source provenance, not routing content. Orca may permute identical rows;
  // hashing that position would produce a new revision for the same semantic effective config.
  const semanticDiagnostics = diagnostics
    .map(({ rowIndex: _rowIndex, ...row }) => row)
    .sort((a, b) => compareText(canonicalJson(a), canonicalJson(b)));
  const revision = contentRevision({
    fingerprint, effectiveProjects, bindings, diagnostics: semanticDiagnostics, routing,
  });

  return deepFreeze({
    base: clonedConfig(config),
    configFingerprint: fingerprint,
    revision,
    projects: effectiveProjects,
    bindings,
    diagnostics,
    routing,
  });
}

export function isEffectiveBridgeConfig(value: unknown): value is EffectiveBridgeConfig {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<EffectiveBridgeConfig>;
  return typeof row.configFingerprint === 'string' && typeof row.revision === 'number' &&
    Array.isArray(row.bindings) && typeof row.routing === 'object' && row.routing !== null;
}
