import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encodePacket, decodePackets, stripFormatting, RconError } from './rcon.ts';

describe('encodePacket', () => {
  test('writes the documented header layout', () => {
    const buf = encodePacket(7, 2, 'list');
    // size covers everything after the size field: id + type + body + 2 terminators
    assert.equal(buf.readInt32LE(0), 10 + 4);
    assert.equal(buf.readInt32LE(4), 7);
    assert.equal(buf.readInt32LE(8), 2);
    assert.equal(buf.toString('utf8', 12, 16), 'list');
  });

  test('null-terminates the body twice', () => {
    const buf = encodePacket(1, 2, 'x');
    assert.equal(buf[buf.length - 1], 0);
    assert.equal(buf[buf.length - 2], 0);
  });

  test('handles an empty body', () => {
    const buf = encodePacket(1, 2, '');
    assert.equal(buf.readInt32LE(0), 10);
    assert.equal(buf.length, 14);
  });
});

describe('decodePackets', () => {
  test('round-trips a single packet', () => {
    const { packets, rest } = decodePackets(encodePacket(5, 0, 'hello'));
    assert.equal(packets.length, 1);
    assert.deepEqual(packets[0], { id: 5, type: 0, body: 'hello' });
    assert.equal(rest.length, 0);
  });

  test('decodes several packets from one read', () => {
    // TCP coalesces writes; a single data event can carry multiple replies.
    const buf = Buffer.concat([
      encodePacket(1, 0, 'one'),
      encodePacket(2, 0, 'two'),
      encodePacket(3, 0, 'three'),
    ]);
    const { packets } = decodePackets(buf);
    assert.equal(packets.length, 3);
    assert.deepEqual(packets.map((p) => p.body), ['one', 'two', 'three']);
  });

  test('retains a trailing partial packet instead of misreading it', () => {
    // The core framing hazard: a read that ends mid-packet must not be decoded.
    const full = Buffer.concat([encodePacket(1, 0, 'complete'), encodePacket(2, 0, 'partial')]);
    const truncated = full.subarray(0, full.length - 5);

    const { packets, rest } = decodePackets(truncated);
    assert.equal(packets.length, 1);
    assert.equal(packets[0].body, 'complete');
    assert.ok(rest.length > 0, 'remaining bytes should be kept for the next read');
  });

  test('a resumed partial packet decodes once the rest arrives', () => {
    const full = Buffer.concat([encodePacket(1, 0, 'complete'), encodePacket(2, 0, 'partial')]);
    const first = decodePackets(full.subarray(0, full.length - 5));
    const second = decodePackets(Buffer.concat([first.rest, full.subarray(full.length - 5)]));

    assert.equal(second.packets.length, 1);
    assert.equal(second.packets[0].body, 'partial');
    assert.equal(second.rest.length, 0);
  });

  test('returns nothing for a buffer too short to hold a size field', () => {
    const { packets, rest } = decodePackets(Buffer.from([1, 2]));
    assert.equal(packets.length, 0);
    assert.equal(rest.length, 2);
  });

  test('rejects a nonsensical size rather than reading out of bounds', () => {
    const bad = Buffer.alloc(16);
    bad.writeInt32LE(-99, 0);
    assert.throws(() => decodePackets(bad), RconError);
  });

  test('preserves the auth-failure sentinel id', () => {
    // id === -1 is how the server signals a bad password; it must survive decoding.
    const { packets } = decodePackets(encodePacket(-1, 2, ''));
    assert.equal(packets[0].id, -1);
  });

  test('handles multi-byte utf8 bodies', () => {
    const { packets } = decodePackets(encodePacket(1, 0, 'joined: Ünicode—player'));
    assert.equal(packets[0].body, 'joined: Ünicode—player');
  });
});

describe('stripFormatting', () => {
  test('removes colour and style codes', () => {
    assert.equal(stripFormatting('§aOnline: §f3'), 'Online: 3');
  });

  test('leaves a plain string alone', () => {
    assert.equal(stripFormatting('There are 3 of a max of 10 players online'),
      'There are 3 of a max of 10 players online');
  });

  test('handles a real /list reply', () => {
    assert.equal(
      stripFormatting('§7There are §a2§7 of a max of §a10§7 players online: §fmoss, jez'),
      'There are 2 of a max of 10 players online: moss, jez',
    );
  });
});
