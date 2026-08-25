/**
 * Local daemon/Channel-Adapter protocol v1.
 *
 * NDJSON is intentional: every message is one small JSON object, JSON escapes embedded newlines,
 * and one LF-delimited decoder handles fragmented and coalesced pipe reads without a binary header.
 * The complete encoded frame, including LF, is capped at 4 KiB.
 */

export const CHANNEL_PROTOCOL_VERSION = 1 as const;
export const CHANNEL_MAX_FRAME_BYTES = 4 * 1024;

export const CHANNEL_PROTOCOL_ERROR_CODES = [
  'empty_frame',
  'frame_too_large',
  'invalid_utf8',
  'invalid_json',
  'invalid_shape',
  'unsupported_version',
  'unknown_type',
  'invalid_claim',
  'invalid_epoch',
  'invalid_gate_id',
  'truncated_frame',
] as const;

export type ChannelProtocolErrorCode = (typeof CHANNEL_PROTOCOL_ERROR_CODES)[number];

/** A code-only error: raw frames and rejected claim values never enter the error message. */
export class ChannelProtocolError extends Error {
  readonly code: ChannelProtocolErrorCode;

  constructor(code: ChannelProtocolErrorCode) {
    super(code);
    this.name = 'ChannelProtocolError';
    this.code = code;
  }
}

export type AdapterHello = {
  readonly version: typeof CHANNEL_PROTOCOL_VERSION;
  readonly type: 'hello';
  readonly session_id: string;
  readonly terminal_handle: string;
  readonly pane_key: string;
  readonly instance_id: string;
  readonly connection_id: string;
};

export type AdapterAttempted = {
  readonly version: typeof CHANNEL_PROTOCOL_VERSION;
  readonly type: 'attempted';
  readonly connection_epoch: string;
  readonly gate_id: string;
};

export type AdapterReceipt = {
  readonly version: typeof CHANNEL_PROTOCOL_VERSION;
  readonly type: 'receipt';
  readonly connection_epoch: string;
  readonly gate_id: string;
};

export type AdapterToDaemonMessage = AdapterHello | AdapterAttempted | AdapterReceipt;

export type DaemonHelloAck = {
  readonly version: typeof CHANNEL_PROTOCOL_VERSION;
  readonly type: 'hello_ack';
  readonly connection_epoch: string;
};

export type DaemonNotify = {
  readonly version: typeof CHANNEL_PROTOCOL_VERSION;
  readonly type: 'notify';
  readonly connection_epoch: string;
  readonly gate_id: string;
};

export type DaemonReceiptAck = {
  readonly version: typeof CHANNEL_PROTOCOL_VERSION;
  readonly type: 'receipt_ack';
  readonly connection_epoch: string;
  readonly gate_id: string;
};

export type DaemonToAdapterMessage = DaemonHelloAck | DaemonNotify | DaemonReceiptAck;
export type ChannelWireMessage = AdapterToDaemonMessage | DaemonToAdapterMessage;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_RE = /^term_[A-Za-z0-9-]{1,128}$/;
const PANE_RE = /^[A-Za-z0-9-]{1,128}:[A-Za-z0-9-]{1,128}$/;
const GATE_RE = /^gate_[a-z0-9]{12}$/;

export function isGateId(value: unknown): value is string {
  return typeof value === 'string' && GATE_RE.test(value);
}

export function validateAdapterClaims(claims: {
  readonly sessionId: unknown;
  readonly terminalHandle: unknown;
  readonly paneKey: unknown;
  readonly instanceId: unknown;
  readonly connectionId: unknown;
}): asserts claims is {
  readonly sessionId: string;
  readonly terminalHandle: string;
  readonly paneKey: string;
  readonly instanceId: string;
  readonly connectionId: string;
} {
  if (
    typeof claims.sessionId !== 'string' ||
    !UUID_RE.test(claims.sessionId) ||
    typeof claims.terminalHandle !== 'string' ||
    !TERMINAL_RE.test(claims.terminalHandle) ||
    typeof claims.paneKey !== 'string' ||
    !PANE_RE.test(claims.paneKey) ||
    typeof claims.instanceId !== 'string' ||
    !claims.instanceId.startsWith('adapter_') ||
    !UUID_RE.test(claims.instanceId.slice('adapter_'.length)) ||
    typeof claims.connectionId !== 'string' ||
    !claims.connectionId.startsWith('connection_') ||
    !UUID_RE.test(claims.connectionId.slice('connection_'.length))
  ) {
    throw new ChannelProtocolError('invalid_claim');
  }
}

function isEpoch(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('epoch_') &&
    UUID_RE.test(value.slice('epoch_'.length))
  );
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChannelProtocolError('invalid_shape');
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, i) => key !== wanted[i])) {
    throw new ChannelProtocolError('invalid_shape');
  }
}

function versionAndType(value: Record<string, unknown>): string {
  if (value['version'] !== CHANNEL_PROTOCOL_VERSION) {
    throw new ChannelProtocolError('unsupported_version');
  }
  if (typeof value['type'] !== 'string') {
    throw new ChannelProtocolError('invalid_shape');
  }
  return value['type'];
}

function decodeHello(value: Record<string, unknown>): AdapterHello {
  exactKeys(value, [
    'version',
    'type',
    'session_id',
    'terminal_handle',
    'pane_key',
    'instance_id',
    'connection_id',
  ]);
  const claims = {
    sessionId: value['session_id'],
    terminalHandle: value['terminal_handle'],
    paneKey: value['pane_key'],
    instanceId: value['instance_id'],
    connectionId: value['connection_id'],
  };
  validateAdapterClaims(claims);
  return {
    version: CHANNEL_PROTOCOL_VERSION,
    type: 'hello',
    session_id: claims.sessionId,
    terminal_handle: claims.terminalHandle,
    pane_key: claims.paneKey,
    instance_id: claims.instanceId,
    connection_id: claims.connectionId,
  };
}

function decodeEpochGate<T extends 'attempted' | 'receipt'>(
  value: Record<string, unknown>,
  type: T,
): T extends 'attempted' ? AdapterAttempted : AdapterReceipt {
  exactKeys(value, ['version', 'type', 'connection_epoch', 'gate_id']);
  if (!isEpoch(value['connection_epoch'])) {
    throw new ChannelProtocolError('invalid_epoch');
  }
  if (!isGateId(value['gate_id'])) {
    throw new ChannelProtocolError('invalid_gate_id');
  }
  return {
    version: CHANNEL_PROTOCOL_VERSION,
    type,
    connection_epoch: value['connection_epoch'],
    gate_id: value['gate_id'],
  } as T extends 'attempted' ? AdapterAttempted : AdapterReceipt;
}

export function decodeAdapterMessage(value: unknown): AdapterToDaemonMessage {
  const decoded = object(value);
  const type = versionAndType(decoded);
  if (type === 'hello') return decodeHello(decoded);
  if (type === 'attempted') return decodeEpochGate(decoded, type);
  if (type === 'receipt') return decodeEpochGate(decoded, type);
  throw new ChannelProtocolError('unknown_type');
}

export function decodeDaemonMessage(value: unknown): DaemonToAdapterMessage {
  const decoded = object(value);
  const type = versionAndType(decoded);
  if (type === 'hello_ack') {
    exactKeys(decoded, ['version', 'type', 'connection_epoch']);
    if (!isEpoch(decoded['connection_epoch'])) {
      throw new ChannelProtocolError('invalid_epoch');
    }
    return {
      version: CHANNEL_PROTOCOL_VERSION,
      type,
      connection_epoch: decoded['connection_epoch'],
    };
  }
  if (type === 'notify' || type === 'receipt_ack') {
    exactKeys(decoded, ['version', 'type', 'connection_epoch', 'gate_id']);
    if (!isEpoch(decoded['connection_epoch'])) {
      throw new ChannelProtocolError('invalid_epoch');
    }
    if (!isGateId(decoded['gate_id'])) {
      throw new ChannelProtocolError('invalid_gate_id');
    }
    return {
      version: CHANNEL_PROTOCOL_VERSION,
      type,
      connection_epoch: decoded['connection_epoch'],
      gate_id: decoded['gate_id'],
    };
  }
  throw new ChannelProtocolError('unknown_type');
}

function decodeAnyMessage(value: unknown): ChannelWireMessage {
  const decoded = object(value);
  const type = versionAndType(decoded);
  return type === 'hello' || type === 'attempted' || type === 'receipt'
    ? decodeAdapterMessage(decoded)
    : decodeDaemonMessage(decoded);
}

export function encodeChannelFrame(message: ChannelWireMessage): Buffer {
  const validated = decodeAnyMessage(message);
  const frame = Buffer.from(`${JSON.stringify(validated)}\n`, 'utf8');
  if (frame.byteLength > CHANNEL_MAX_FRAME_BYTES) {
    throw new ChannelProtocolError('frame_too_large');
  }
  return frame;
}

/** Incremental, bounded decoder for fragmented and coalesced named-pipe reads. */
export class ChannelNdjsonDecoder<T> {
  readonly #decode: (value: unknown) => T;
  #buffer = Buffer.alloc(0);

  constructor(decode: (value: unknown) => T) {
    this.#decode = decode;
  }

  push(chunk: Uint8Array): readonly T[] {
    const input = Buffer.from(chunk);
    const result: T[] = [];
    let offset = 0;

    while (offset < input.length) {
      const newline = input.indexOf(0x0a, offset);
      const end = newline === -1 ? input.length : newline;
      const segment = input.subarray(offset, end);
      if (this.#buffer.length + segment.length > CHANNEL_MAX_FRAME_BYTES - 1) {
        this.#buffer = Buffer.alloc(0);
        throw new ChannelProtocolError('frame_too_large');
      }
      if (segment.length > 0) {
        this.#buffer = Buffer.concat([this.#buffer, segment]);
      }
      if (newline === -1) break;

      if (this.#buffer.length === 0) {
        throw new ChannelProtocolError('empty_frame');
      }
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(this.#buffer);
      } catch {
        this.#buffer = Buffer.alloc(0);
        throw new ChannelProtocolError('invalid_utf8');
      }
      this.#buffer = Buffer.alloc(0);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new ChannelProtocolError('invalid_json');
      }
      result.push(this.#decode(parsed));
      offset = newline + 1;
    }

    return result;
  }

  finish(): void {
    if (this.#buffer.length !== 0) {
      this.#buffer = Buffer.alloc(0);
      throw new ChannelProtocolError('truncated_frame');
    }
  }
}
