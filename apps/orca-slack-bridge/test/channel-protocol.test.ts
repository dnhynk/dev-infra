import { describe, expect, it } from 'vitest';

import {
  CHANNEL_MAX_FRAME_BYTES,
  CHANNEL_PROTOCOL_VERSION,
  ChannelNdjsonDecoder,
  ChannelProtocolError,
  decodeAdapterMessage,
  decodeDaemonMessage,
  encodeChannelFrame,
  type AdapterHello,
} from '../src/channel/protocol.js';

const HELLO: AdapterHello = {
  version: CHANNEL_PROTOCOL_VERSION,
  type: 'hello',
  session_id: '11111111-1111-4111-8111-111111111111',
  terminal_handle: 'term_22222222-2222-4222-8222-222222222222',
  pane_key: '33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444',
  instance_id: 'adapter_55555555-5555-4555-8555-555555555555',
  connection_id: 'connection_66666666-6666-4666-8666-666666666666',
};

describe('Channel protocol v1 NDJSON codec', () => {
  it('decodes one frame fragmented at every byte boundary', () => {
    const frame = encodeChannelFrame(HELLO);
    for (let split = 1; split < frame.length; split += 1) {
      const decoder = new ChannelNdjsonDecoder(decodeAdapterMessage);
      expect(decoder.push(frame.subarray(0, split))).toEqual([]);
      expect(decoder.push(frame.subarray(split))).toEqual([HELLO]);
      decoder.finish();
    }
  });

  it('decodes coalesced frames without losing boundaries', () => {
    const attempted = {
      version: CHANNEL_PROTOCOL_VERSION,
      type: 'attempted' as const,
      connection_epoch: 'epoch_77777777-7777-4777-8777-777777777777',
      gate_id: 'gate_1234abcdef56',
    };
    const receipt = { ...attempted, type: 'receipt' as const };
    const decoder = new ChannelNdjsonDecoder(decodeAdapterMessage);
    expect(decoder.push(Buffer.concat([
      encodeChannelFrame(HELLO),
      encodeChannelFrame(attempted),
      encodeChannelFrame(receipt),
    ]))).toEqual([HELLO, attempted, receipt]);
  });

  it('accepts only exact versioned message shapes in each direction', () => {
    const decoder = new ChannelNdjsonDecoder(decodeDaemonMessage);
    expect(decoder.push(encodeChannelFrame({
      version: CHANNEL_PROTOCOL_VERSION,
      type: 'hello_ack',
      connection_epoch: 'epoch_77777777-7777-4777-8777-777777777777',
    }))).toHaveLength(1);
    expect(decoder.push(encodeChannelFrame({
      version: CHANNEL_PROTOCOL_VERSION,
      type: 'receipt_ack',
      connection_epoch: 'epoch_77777777-7777-4777-8777-777777777777',
      gate_id: 'gate_1234abcdef56',
    }))).toHaveLength(1);

    for (const value of [
      { ...HELLO, version: 2 },
      { ...HELLO, extra: true },
      { ...HELLO, session_id: undefined },
      { version: 1, type: 'surprise' },
      [],
      null,
    ]) {
      expect(() => decodeAdapterMessage(value)).toThrow(ChannelProtocolError);
    }
  });

  it('fails closed on missing, malformed, and oversized hello claims', () => {
    for (const value of [
      { ...HELLO, session_id: '' },
      { ...HELLO, session_id: 'x'.repeat(200) },
      { ...HELLO, terminal_handle: 'not-a-terminal' },
      { ...HELLO, pane_key: 'not-a-pane' },
      { ...HELLO, instance_id: 'adapter_not-a-uuid' },
      { ...HELLO, connection_id: 'connection_not-a-uuid' },
    ]) {
      expect(() => decodeAdapterMessage(value)).toThrowError('invalid_claim');
    }
  });

  it('enforces a hard 4 KiB complete-frame cap before retaining oversized input', () => {
    const decoder = new ChannelNdjsonDecoder(decodeAdapterMessage);
    expect(() => decoder.push(Buffer.alloc(CHANNEL_MAX_FRAME_BYTES, 0x61)))
      .toThrowError('frame_too_large');
    expect(() => decoder.finish()).not.toThrow();

    const split = new ChannelNdjsonDecoder(decodeAdapterMessage);
    expect(split.push(Buffer.alloc(CHANNEL_MAX_FRAME_BYTES - 2, 0x61))).toEqual([]);
    expect(() => split.push(Buffer.from('aa\n'))).toThrowError('frame_too_large');
  });

  it('rejects empty, invalid UTF-8, invalid JSON, and unterminated frames', () => {
    expect(() => new ChannelNdjsonDecoder(decodeAdapterMessage).push(Buffer.from('\n')))
      .toThrowError('empty_frame');
    expect(() => new ChannelNdjsonDecoder(decodeAdapterMessage).push(Buffer.from([0xff, 0x0a])))
      .toThrowError('invalid_utf8');
    expect(() => new ChannelNdjsonDecoder(decodeAdapterMessage).push(Buffer.from('{nope}\n')))
      .toThrowError('invalid_json');
    const decoder = new ChannelNdjsonDecoder(decodeAdapterMessage);
    decoder.push(Buffer.from('{"version":1'));
    expect(() => decoder.finish()).toThrowError('truncated_frame');
  });

  it('exposes code-only failures and never copies a rejected raw frame', () => {
    const rawSecret = 'DO_NOT_LEAK_THIS_RAW_VALUE';
    const decoder = new ChannelNdjsonDecoder(decodeAdapterMessage);
    let caught: unknown;
    try {
      decoder.push(Buffer.from(`{"version":1,"type":"hello","secret":"${rawSecret}"}\n`));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ChannelProtocolError);
    expect(String(caught)).toBe('ChannelProtocolError: invalid_shape');
    expect(String(caught)).not.toContain(rawSecret);
  });
});
