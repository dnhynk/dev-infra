import type { DispatchKey, GateKey, RunKey, TaskKey } from '../identity/keys.js';

/** `gate-register --input` document version. This is independent of the SQLite schema version. */
export const GATE_REGISTRATION_SCHEMA_VERSION = 1;

/** One fixed Gate option as supplied by the coordinator sidecar document. */
export type GateOptionMetadata = {
  /** Stable machine identity inside this Gate. */
  readonly id: string;
  /** Exact human-readable Orca Gate option. Registration compares this list without parsing it. */
  readonly label: string;
  readonly description: string;
  /** Exact text the D2-C resolver writes to Orca after the stable option ID wins locally. */
  readonly resolution: string;
};

export type GateRecommendation = {
  readonly optionId: string;
  readonly reason: string;
};

/** Strict, code-owned JSON transport contract for `gate-register --input <path>`. */
export type GateRegistrationDocument = {
  readonly schemaVersion: typeof GATE_REGISTRATION_SCHEMA_VERSION;
  readonly runId: string;
  readonly askMessageId: string;
  readonly questionThreadId: string;
  readonly dispatchId: string;
  readonly taskId: string;
  readonly gateId: string;
  readonly options: readonly GateOptionMetadata[];
  readonly recommendation: GateRecommendation;
  readonly impact: string;
};

/** Durable sidecar row after raw Orca IDs have been normalized through `identity/keys.ts`. */
export type GateMetadata = {
  readonly gateKey: GateKey;
  readonly runKey: RunKey;
  readonly taskKey: TaskKey;
  readonly dispatchKey: DispatchKey;
  readonly askMessageId: string;
  readonly questionThreadId: string;
  readonly options: readonly GateOptionMetadata[];
  readonly recommendation: GateRecommendation;
  readonly impact: string;
  /** ISO8601 written by the Bridge. */
  readonly registeredAt: string;
};

/** Exact ask/thread/Dispatch/Task/Gate mapping exposed only after Gate identity matches. */
export type GateCorrelation = {
  readonly askMessageId: string;
  readonly questionThreadId: string;
  readonly dispatchId: string;
  readonly taskId: string;
  readonly gateId: string;
};

export type GateTaskFacts = {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
};

/** Renderer-facing option. Degraded cards have no stable id/description/resolution. */
export type GateOptionFacts = {
  readonly id: string | null;
  readonly label: string;
  readonly description: string | null;
  readonly resolution: string | null;
};

export type GateRecommendationFacts = {
  readonly optionId: string;
  readonly label: string;
  readonly reason: string;
};

/** Deterministic projection of raw Gate/Task facts plus one exact sidecar row. */
export type GateDecisionFacts = {
  readonly key: GateKey;
  readonly gateId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly question: string;
  readonly status: string;
  readonly resolution: string | null;
  readonly resolvedAt: string | null;
  readonly metadataState: 'matched' | 'missing' | 'mismatched';
  /** Null unless every stored run/task/options identity check succeeded. */
  readonly correlation: GateCorrelation | null;
  readonly options: readonly GateOptionFacts[];
  readonly recommendation: GateRecommendationFacts | null;
  readonly impact: string | null;
  readonly waitingTasks: readonly GateTaskFacts[];
  readonly independentTasks: readonly GateTaskFacts[];
  /** Current nonterminal Tasks whose dependency relationship cannot be read safely. */
  readonly unclassifiedTasks: readonly GateTaskFacts[];
  /** Stable, human-readable reasons. Empty only when metadata and dependency facts are complete. */
  readonly degraded: readonly string[];
};
