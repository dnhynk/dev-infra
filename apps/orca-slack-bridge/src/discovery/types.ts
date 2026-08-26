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
  | 'unsupported_remote'
  | 'invalid_remote'
  | 'canonical_conflict'
  | 'duplicate_orca_id'
  | 'manual_remote_conflict'
  | 'capacity_conflict'
  | 'project_conflict'
  | 'github_identity_unverified'
  | 'capacity_deferred'
  | 'remote_unverified';

/** A safe row/group diagnostic. rowIndex locates source evidence without copying a private ID. */
export type RepositoryDiscoveryDiagnostic = {
  readonly rowIndex: number;
  readonly code: RepositoryDiscoveryDiagnosticCode;
  /** The exact scope of the fail-closed decision; unrelated groups remain routable. */
  readonly effect:
    | 'row_blocked'
    | 'group_blocked'
    | 'group_deferred'
    | 'remote_unverified'
    | 'lkg_carried'
    | 'coalesced';
  /** Redacted correlation only. Raw Orca IDs and remotes never cross this boundary. */
  readonly entityRef?: string;
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
      /** Null only for the explicit manual-ID fallback whose live remote cannot be verified. */
      readonly identity: CanonicalGithubRepository | null;
      readonly githubRepositoryId: number | null;
      readonly projectKey: string;
      readonly projectOrigin: EffectiveProjectOrigin;
      readonly verification: 'github_verified' | 'remote_unverified';
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
        | 'capacity_conflict'
        | 'project_conflict'
        | 'github_identity_unverified'
        | 'capacity_deferred';
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
      readonly reason: 'schema_drift' | 'project_conflict' | 'capacity_conflict' | 'config_drift';
    };

/** Immutable, content-revisioned input to Run routing. */
export type EffectiveBridgeConfig = {
  readonly base: ParsedBridgeConfig;
  readonly configFingerprint: string;
  readonly revision: number;
  readonly projects: readonly EffectiveProject[];
  readonly bindings: readonly EffectiveRepositoryBinding[];
  readonly diagnostics: readonly RepositoryDiscoveryDiagnostic[];
  readonly routing: EffectiveRoutingState;
};
