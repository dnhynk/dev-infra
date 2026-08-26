import type { ParsedBridgeConfig } from '../project/config.js';

/** Canonical GitHub identity computed by the Bridge. Raw remotes never cross this boundary. */
export type CanonicalGithubRepository = {
  readonly canonicalKey: `github.com/${string}/${string}`;
  readonly nameWithOwner: `${string}/${string}`;
};

export type GithubRemoteErrorCode =
  | 'unsafe_character'
  | 'backslash'
  | 'percent_encoding'
  | 'query_or_fragment'
  | 'unsupported_scheme'
  | 'unsupported_host'
  | 'invalid_user'
  | 'credentials'
  | 'non_default_port'
  | 'invalid_path'
  | 'invalid_owner'
  | 'invalid_repository'
  | 'double_git_suffix'
  | 'invalid_syntax';

export type RepositoryDiscoveryDiagnosticCode =
  | GithubRemoteErrorCode
  | 'no_remote'
  | 'canonical_conflict'
  | 'duplicate_orca_id'
  | 'manual_remote_conflict'
  | 'capacity_conflict';

/** A safe row-local diagnostic. rowIndex locates the row without copying a private Orca ID. */
export type RepositoryDiscoveryDiagnostic = {
  readonly rowIndex: number;
  readonly code: RepositoryDiscoveryDiagnosticCode;
  /** Only this source row is unusable; unrelated valid rows remain routable. */
  readonly effect: 'row_blocked';
};

type RepositoryRowBase = {
  /** Exact Orca ID used by the existing D1 manual-ID fallback. */
  readonly orcaRepositoryId: string;
  readonly rowIndex: number;
};

export type RepositoryDiscoveryRow =
  | (RepositoryRowBase & {
      readonly status: 'valid';
      readonly identity: CanonicalGithubRepository;
    })
  | (RepositoryRowBase & {
      readonly status: 'no_remote' | 'unsupported_remote' | 'invalid_remote';
      readonly diagnostic: RepositoryDiscoveryDiagnostic;
    })
  | (RepositoryRowBase & {
      readonly status: 'canonical_conflict';
      readonly computedIdentity: CanonicalGithubRepository;
      readonly diagnostic: RepositoryDiscoveryDiagnostic;
    });

export type RepositoryDiscoverySnapshot = {
  /** Source order is preserved. Duplicate rows are data for later reconciliation, not discarded. */
  readonly rows: readonly RepositoryDiscoveryRow[];
  readonly diagnostics: readonly RepositoryDiscoveryDiagnostic[];
};

export type EffectiveProjectOrigin = 'explicit' | 'auto';

export type EffectiveProject = {
  readonly key: string;
  readonly name: string;
  readonly origin: EffectiveProjectOrigin;
  readonly repositories: readonly CanonicalGithubRepository[];
  /** Multiple exact Orca IDs may identify one canonical repository. */
  readonly orcaRepositoryIds: readonly string[];
};

export type EffectiveRepositoryBinding =
  | {
      readonly status: 'bound';
      readonly identity: CanonicalGithubRepository;
      readonly projectKey: string;
      readonly projectOrigin: EffectiveProjectOrigin;
      readonly orcaRepositoryIds: readonly string[];
    }
  | {
      readonly status: 'blocked';
      readonly reason:
        | 'no_remote'
        | 'unsupported_remote'
        | 'invalid_remote'
        | 'canonical_conflict'
        | 'duplicate_orca_id'
        | 'manual_remote_conflict'
        | 'capacity_conflict';
      readonly orcaRepositoryIds: readonly string[];
      readonly identity?: CanonicalGithubRepository;
    };

export type EffectiveRoutingState =
  | { readonly status: 'ready' }
  | {
      /** Some bindings are row/group-local blocked; unrelated bindings remain eligible. */
      readonly status: 'partially_blocked';
      readonly blockedBindingCount: number;
    }
  | {
      /** A whole-snapshot invariant failed, so no automatic route may be selected. */
      readonly status: 'blocked';
      readonly reason: 'schema_drift' | 'project_conflict' | 'capacity_conflict';
    };

/** Immutable input contract for later discovery/routing PRs. This PR does not reconcile it. */
export type EffectiveBridgeConfig = {
  readonly base: ParsedBridgeConfig;
  readonly revision: number;
  readonly projects: readonly EffectiveProject[];
  readonly bindings: readonly EffectiveRepositoryBinding[];
  readonly diagnostics: readonly RepositoryDiscoveryDiagnostic[];
  readonly routing: EffectiveRoutingState;
};
