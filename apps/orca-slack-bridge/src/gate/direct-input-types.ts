import type { GateKey } from '../identity/keys.js';
import type { GateMetadata } from './types.js';
import type { GateClaimResult } from './resolution-types.js';

/** Durable sentinel used only for a free-form Gate resolution; it is never an Orca option id. */
export const GATE_DIRECT_OPTION_ID = 'orca:direct-input:v1';

export type GateDirectModalState = 'prepared' | 'opening' | 'opened' | 'failed' | 'accepted';

/** Server-owned modal correlation. Raw trigger ids and unaccepted submitted text are never stored. */
export type GateDirectModalSession = {
  readonly sessionId: string;
  readonly revision: number;
  readonly buttonEventKey: string;
  readonly gateKey: GateKey;
  readonly teamId: string;
  readonly ownerUserId: string;
  readonly apiAppId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly messageTs: string;
  readonly blockId: string;
  readonly actionId: string;
  readonly actionValue: string;
  readonly callbackId: string;
  readonly inputBlockId: string;
  readonly inputActionId: string;
  readonly state: GateDirectModalState;
  readonly viewId: string | null;
  readonly failureCode: string | null;
  readonly resolutionText: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly openedAt: string | null;
  readonly acceptedAt: string | null;
};

export type GateDirectPrepareInput = {
  readonly sessionId: string;
  /** SHA-256 of the one Slack button delivery, never the trigger id itself. */
  readonly buttonEventKey: string;
  readonly teamId: string;
  readonly ownerUserId: string;
  readonly apiAppId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly messageTs: string;
  readonly blockId: string;
  readonly actionId: string;
  readonly actionValue: string;
  readonly at: string;
};

export type GateDirectPrepareResult =
  | { readonly kind: 'prepared'; readonly session: GateDirectModalSession; readonly metadata: GateMetadata }
  | { readonly kind: 'duplicate'; readonly session: GateDirectModalSession; readonly metadata: GateMetadata }
  | { readonly kind: 'rejected'; readonly reason: string };

export type GateDirectOpenResult =
  | {
      readonly kind: 'opened';
      readonly viewId: string;
      readonly teamId: string;
      readonly apiAppId: string;
      readonly callbackId: string;
      readonly privateMetadata: string;
    }
  | { readonly kind: 'failed'; readonly code: string };

export type GateDirectClaimInput = {
  readonly sessionId: string;
  readonly teamId: string;
  readonly ownerUserId: string;
  readonly apiAppId: string;
  readonly viewId: string;
  readonly callbackId: string;
  readonly privateMetadata: string;
  readonly inputBlockId: string;
  readonly inputActionId: string;
  readonly resolutionText: string;
  readonly retryRequestId: string;
  readonly at: string;
};

export interface GateDirectInputStore {
  prepareGateDirectModal(input: GateDirectPrepareInput): GateDirectPrepareResult;
  findGateDirectModal(sessionId: string): GateDirectModalSession | null;
  /** Atomically records the non-replayable remote-call edge before views.open starts. */
  beginGateDirectModalOpen(
    sessionId: string,
    expectedRevision: number,
    at: string,
  ): GateDirectModalSession | null;
  finishGateDirectModalOpen(
    sessionId: string,
    expectedRevision: number,
    result: GateDirectOpenResult,
    at: string,
  ): GateDirectModalSession | null;
  /** Shares gate_resolution's Gate-local primary key with fixed-option claims. */
  claimGateDirectResolution(input: GateDirectClaimInput): GateClaimResult;
}
