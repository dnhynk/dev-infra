import { randomUUID } from 'node:crypto';
import { entityIdentity, type OperationalTelemetrySink } from '../operational/logger.js';
import type {
  OperationalStore,
  SlackRootClaim,
  SlackRootEntity,
  SlackRootIntentRecord,
  SlackRootPostedMapping,
} from '../store/operational-types.js';
import {
  SlackApiError,
  type PostedMessage,
  type PostMessageInput,
  type SlackPoster,
} from './post.js';

export const DEFAULT_ROOT_POST_TIMEOUT_MS = 20_000;

export type SlackRootIntentStore = Pick<
  OperationalStore,
  'prepareSlackRootIntent' | 'claimSlackRootIntent' | 'markSlackRootIntentSafeRetry' |
  'markSlackRootIntentUncertain' | 'markSlackRootIntentPosted' | 'findSlackRootIntent'
>;

export type SlackRootIntentHooks = {
  readonly afterPrepare?: (intent: SlackRootIntentRecord) => void | Promise<void>;
  readonly afterClaim?: (claim: SlackRootClaim) => void | Promise<void>;
  readonly beforePost?: (claim: SlackRootClaim) => void | Promise<void>;
  readonly afterPostResponse?: (message: PostedMessage) => void | Promise<void>;
  readonly beforeCommit?: (message: PostedMessage) => void | Promise<void>;
  readonly afterCommit?: (message: PostedMessage) => void | Promise<void>;
};

export type SlackRootIntentRuntime = {
  readonly instanceId: string;
  readonly telemetry?: OperationalTelemetrySink;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly hooks?: SlackRootIntentHooks;
};

export type SlackRootCreateResult =
  | { readonly kind: 'posted'; readonly message: PostedMessage }
  | {
      readonly kind: 'blocked';
      readonly state: 'pending' | 'sending' | 'posted' | 'uncertain';
      readonly messageTs: string | null;
    };

/** Test seam that represents process death: the sending row must be left for startup recovery. */
export class SlackRootSimulatedCrash extends Error {
  constructor(readonly stage: string) {
    super(`simulated root crash at ${stage}`);
    this.name = 'SlackRootSimulatedCrash';
  }
}

/** Cancellation observed before the injected transport boundary was invoked. */
export class SlackRootPreInvocationAbortError extends Error {
  constructor() {
    super('root post aborted before transport invocation');
    this.name = 'SlackRootPreInvocationAbortError';
  }
}

const PROCESS_ROOT_INSTANCE_ID = `root-${process.pid}-${randomUUID()}`;

export function processRootIntentRuntime(): SlackRootIntentRuntime {
  return { instanceId: PROCESS_ROOT_INSTANCE_ID };
}

function rootStore(value: unknown): SlackRootIntentStore {
  const candidate = value as Partial<SlackRootIntentStore>;
  for (const name of [
    'prepareSlackRootIntent', 'claimSlackRootIntent', 'markSlackRootIntentSafeRetry',
    'markSlackRootIntentUncertain', 'markSlackRootIntentPosted', 'findSlackRootIntent',
  ] as const) {
    if (typeof candidate[name] !== 'function') {
      throw new TypeError('live Slack root publication requires the O1-2 root-intent store');
    }
  }
  return candidate as SlackRootIntentStore;
}

async function rootEvent(
  runtime: SlackRootIntentRuntime,
  entity: SlackRootEntity,
  outcome: 'running' | 'succeeded' | 'deferred' | 'uncertain',
): Promise<void> {
  await runtime.telemetry?.log({
    level: outcome === 'uncertain' ? 'warn' : 'info',
    event: 'root_intent.changed',
    outcome,
    counts: outcome === 'uncertain' ? { uncertain: 1 } : undefined,
    entityIdentity: entityIdentity(`${entity.kind}:${entity.key}`),
  });
}

function safeRetry(error: unknown, postInvoked: boolean): boolean {
  if (!postInvoked) return true;
  return error instanceof SlackApiError &&
    (error.code === 'rate_limited' || error.code === 'ratelimited');
}

function rootPostAborted(runtime: SlackRootIntentRuntime): boolean {
  return runtime.signal?.aborted === true;
}

async function boundedRootPost(
  slack: SlackPoster,
  input: PostMessageInput,
  runtime: SlackRootIntentRuntime,
  onInvoke: () => void,
): Promise<PostedMessage> {
  const timeoutMs = runtime.timeoutMs ?? DEFAULT_ROOT_POST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 10 || timeoutMs > 60_000) {
    throw new TypeError('root post timeout must be a finite number between 10 and 60000');
  }
  if (rootPostAborted(runtime)) throw new SlackRootPreInvocationAbortError();
  const controller = new AbortController();
  const signal = runtime.signal === undefined
    ? controller.signal
    : AbortSignal.any([runtime.signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = (): void => {
    controller.abort();
    rejectAbort(new Error('root post aborted'));
  };
  runtime.signal?.addEventListener('abort', onAbort, { once: true });
  const operation = Promise.resolve().then(() => {
    if (rootPostAborted(runtime)) throw new SlackRootPreInvocationAbortError();
    onInvoke();
    return slack.post({ ...input, signal });
  });
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('root post deadline exceeded'));
    }, Math.trunc(timeoutMs));
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout, aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    runtime.signal?.removeEventListener('abort', onAbort);
    void operation.catch(() => undefined);
  }
}

/**
 * The only create-root boundary. A durable sending claim precedes the transport attempt, and every
 * possible-effect outcome is terminally uncertain so a later poll performs zero more posts.
 */
export async function postSlackRootAtMostOnce(input: {
  readonly store: unknown;
  readonly entity: SlackRootEntity;
  readonly channel: string;
  readonly renderFingerprint: string;
  readonly message: Omit<PostMessageInput, 'channel' | 'signal'>;
  readonly mapping: SlackRootPostedMapping;
  readonly slack: SlackPoster;
  readonly now: () => Date;
  readonly runtime?: SlackRootIntentRuntime;
}): Promise<SlackRootCreateResult> {
  const store = rootStore(input.store);
  const runtime = input.runtime ?? processRootIntentRuntime();
  const prepared = store.prepareSlackRootIntent({
    ...input.entity,
    channelId: input.channel,
    renderFingerprint: input.renderFingerprint,
    at: input.now().toISOString(),
  });
  await rootEvent(runtime, input.entity, 'running');
  await runtime.hooks?.afterPrepare?.(prepared);
  if (prepared.state !== 'pending') {
    await rootEvent(runtime, input.entity,
      prepared.state === 'uncertain' ? 'uncertain' : 'deferred');
    return { kind: 'blocked', state: prepared.state, messageTs: prepared.messageTs };
  }

  const claimed = store.claimSlackRootIntent(
    input.entity,
    runtime.instanceId,
    input.now().toISOString(),
  );
  if (claimed === null || claimed.kind !== 'claimed') {
    const intent = claimed?.intent ?? store.findSlackRootIntent(input.entity);
    return {
      kind: 'blocked',
      state: intent?.state ?? 'uncertain',
      messageTs: intent?.messageTs ?? null,
    };
  }

  const { claim } = claimed;
  let postInvoked = false;
  try {
    await runtime.hooks?.afterClaim?.(claim);
    await runtime.hooks?.beforePost?.(claim);
    const posted = await boundedRootPost(input.slack, {
      channel: input.channel,
      text: input.message.text,
      blocks: input.message.blocks,
    }, runtime, () => { postInvoked = true; });
    if (rootPostAborted(runtime)) throw new Error('root post aborted after response');
    await runtime.hooks?.afterPostResponse?.(posted);
    if (rootPostAborted(runtime)) throw new Error('root post aborted after response');
    if (posted.channel !== input.channel) {
      store.markSlackRootIntentUncertain(
        claim, 'slack.commit_unknown', input.now().toISOString(),
      );
      await rootEvent(runtime, input.entity, 'uncertain');
      return { kind: 'blocked', state: 'uncertain', messageTs: null };
    }
    await runtime.hooks?.beforeCommit?.(posted);
    if (rootPostAborted(runtime)) throw new Error('root post aborted before commit');
    let committed: SlackRootIntentRecord | null;
    try {
      committed = store.markSlackRootIntentPosted({
        claim,
        messageTs: posted.ts,
        mapping: input.mapping,
        at: input.now().toISOString(),
      });
    } catch {
      committed = null;
    }
    if (committed === null || committed.state !== 'posted') {
      const durable = store.findSlackRootIntent(input.entity);
      if (durable?.state !== 'posted' || durable.messageTs !== posted.ts) {
        store.markSlackRootIntentUncertain(
          claim, 'slack.commit_unknown', input.now().toISOString(),
        );
        await rootEvent(runtime, input.entity, 'uncertain');
        return { kind: 'blocked', state: 'uncertain', messageTs: null };
      }
    }
    await runtime.hooks?.afterCommit?.(posted);
    await rootEvent(runtime, input.entity, 'succeeded');
    return { kind: 'posted', message: posted };
  } catch (error) {
    if (error instanceof SlackRootSimulatedCrash) throw error;
    const at = input.now().toISOString();
    if (safeRetry(error, postInvoked)) {
      store.markSlackRootIntentSafeRetry(claim, 'slack.validation_failed', at);
      await rootEvent(runtime, input.entity, 'deferred');
      return { kind: 'blocked', state: 'pending', messageTs: null };
    }
    store.markSlackRootIntentUncertain(claim, 'slack.transport_unknown', at);
    await rootEvent(runtime, input.entity, 'uncertain');
    return { kind: 'blocked', state: 'uncertain', messageTs: null };
  }
}
