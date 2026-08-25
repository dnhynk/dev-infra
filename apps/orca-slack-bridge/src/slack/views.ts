import {
  LogLevel,
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
  WebClient,
  type Logger,
  type ViewsOpenArguments,
  type ViewsOpenResponse,
} from '@slack/web-api';

/** Slack's three-second interactive deadline is the outer ceiling for this seam. */
export const MAX_SLACK_VIEW_OPEN_TIMEOUT_MS = 3_000;

/** Keep the public boundary on the SDK's installed Block Kit modal contract. */
export type SlackModalView = Extract<ViewsOpenArguments['view'], { readonly type: 'modal' }>;

export type OpenSlackViewInput = {
  /** Ephemeral Slack capability. It is used once and is never retained or copied into errors. */
  readonly triggerId: string;
  readonly view: SlackModalView;
  /** Remaining time in the ingress-wide three-second budget. */
  readonly timeoutMs: number;
};

/** The only response fields the caller may use to bind the opened modal to its server sidecar. */
export type OpenedSlackView = {
  readonly id: string;
  readonly teamId: string;
  readonly appId: string;
  readonly callbackId: string;
  readonly privateMetadata: string;
};

export interface SlackViewOpener {
  open(input: OpenSlackViewInput): Promise<OpenedSlackView>;
}

export type SlackViewOpenErrorCode =
  | 'invalid_configuration'
  | 'invalid_request'
  | 'deadline_exceeded'
  | 'rate_limited'
  | 'platform_rejected'
  | 'http_failure'
  | 'request_failure'
  | 'sdk_failure'
  | 'malformed_response';

const ERROR_MESSAGES: Readonly<Record<SlackViewOpenErrorCode, string>> = {
  invalid_configuration: 'Slack modal opener configuration is invalid',
  invalid_request: 'Slack modal open request is invalid',
  deadline_exceeded: 'Slack modal open deadline exceeded',
  rate_limited: 'Slack modal open was rate limited',
  platform_rejected: 'Slack rejected the modal open request',
  http_failure: 'Slack modal open HTTP request failed',
  request_failure: 'Slack modal open transport request failed',
  sdk_failure: 'Slack modal open SDK call failed',
  malformed_response: 'Slack modal open response was malformed',
};

/**
 * Redacted boundary error. It deliberately has no `cause`, SDK `data`, response body, or request fields.
 */
export class SlackViewOpenError extends Error {
  constructor(readonly code: SlackViewOpenErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'SlackViewOpenError';
  }
}

export type SlackWebApiViewOpenerOptions = {
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
};

/**
 * A logger is required to stop the SDK's platform diagnostics from copying private modal data to
 * stdout/stderr. All methods, including setters called by WebClient, are intentional no-ops.
 */
const SILENT_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  setLevel: () => undefined,
  getLevel: () => LogLevel.ERROR,
  setName: () => undefined,
};

/**
 * Production `views.open` seam.
 *
 * A fresh WebClient gives every trigger its own request queue and timeout. The SDK is configured
 * for zero retries and immediate rate-limit rejection because a trigger is a short-lived,
 * non-replayable capability. An outer timer also bounds injected transports that ignore abort.
 */
export class SlackWebApiViewOpener implements SlackViewOpener {
  constructor(private readonly options: SlackWebApiViewOpenerOptions) {
    if (options.token.length === 0) throw new SlackViewOpenError('invalid_configuration');
  }

  async open(input: OpenSlackViewInput): Promise<OpenedSlackView> {
    if (input.triggerId.length === 0 || !isObject(input.view)) {
      throw new SlackViewOpenError('invalid_request');
    }
    const timeoutMs = normalizeTimeout(input.timeoutMs);
    const client = new WebClient(this.options.token, {
      logger: SILENT_LOGGER,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      timeout: timeoutMs,
      allowAbsoluteUrls: false,
      maxRequestConcurrency: 1,
      ...(this.options.fetchImpl === undefined ? {} : { fetch: this.options.fetchImpl }),
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let operation: Promise<ViewsOpenResponse> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new SlackViewOpenError('deadline_exceeded')),
        timeoutMs,
      );
    });

    try {
      operation = client.views.open({ trigger_id: input.triggerId, view: input.view });
      const response = await Promise.race([operation, timeout]);
      return parseOpenedView(response);
    } catch (error) {
      throw redactError(error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // A test double may ignore AbortSignal. Drain a late SDK rejection without extending ingress.
      void operation?.catch(() => undefined);
    }
  }
}

function normalizeTimeout(value: number): number {
  if (!Number.isFinite(value) || value < 1 || value > MAX_SLACK_VIEW_OPEN_TIMEOUT_MS) {
    throw new SlackViewOpenError('invalid_request');
  }
  const timeout = Math.floor(value);
  if (timeout < 1) throw new SlackViewOpenError('invalid_request');
  return timeout;
}

function redactError(error: unknown): SlackViewOpenError {
  if (error instanceof SlackViewOpenError) return error;
  if (error instanceof WebAPIRateLimitedError) return new SlackViewOpenError('rate_limited');
  if (error instanceof WebAPIPlatformError) return new SlackViewOpenError('platform_rejected');
  if (error instanceof WebAPIHTTPError) return new SlackViewOpenError('http_failure');
  if (error instanceof WebAPIRequestError) return new SlackViewOpenError('request_failure');
  return new SlackViewOpenError('sdk_failure');
}

function parseOpenedView(response: unknown): OpenedSlackView {
  if (!isObject(response) || response['ok'] !== true || !isObject(response['view'])) {
    throw new SlackViewOpenError('malformed_response');
  }
  const view = response['view'];
  const id = nonEmptyString(view['id']);
  const teamId = nonEmptyString(view['team_id']);
  const appId = nonEmptyString(view['app_id']);
  const callbackId = nonEmptyString(view['callback_id']);
  const privateMetadata = nonEmptyString(view['private_metadata']);
  if (
    view['type'] !== 'modal'
    || id === undefined
    || teamId === undefined
    || appId === undefined
    || callbackId === undefined
    || privateMetadata === undefined
  ) {
    throw new SlackViewOpenError('malformed_response');
  }
  return { id, teamId, appId, callbackId, privateMetadata };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
