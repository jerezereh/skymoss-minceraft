/**
 * Minimal Source RCON client.
 *
 * Implemented here rather than pulled in as a dependency: the protocol is small and
 * fully specified, and this way the packet handling is testable without a live server.
 *
 * Packet layout (all integers little-endian):
 *
 *   int32  size     byte count of everything after this field
 *   int32  id       caller-chosen; echoed back, or -1 on auth failure
 *   int32  type     see PacketType
 *   bytes  body     ASCII, null-terminated
 *   byte   0        second terminator
 *
 * https://developer.valvesoftware.com/wiki/Source_RCON_Protocol
 */

import { Socket } from 'node:net';

const AUTH = 3;
const AUTH_RESPONSE = 2;
const EXEC_COMMAND = 2;
const RESPONSE_VALUE = 0;

/** Body length beyond which the server splits a response across packets. */
const SPLIT_THRESHOLD = 4000;

const HEADER_BYTES = 10; // id(4) + type(4) + two null terminators

export class RconError extends Error {}
export class RconAuthError extends RconError {}

export interface RconPacket {
  id: number;
  type: number;
  body: string;
}

export function encodePacket(id: number, type: number, body: string): Buffer {
  const bodyBuf = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(4 + HEADER_BYTES + bodyBuf.length);
  buf.writeInt32LE(HEADER_BYTES + bodyBuf.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  // Final two bytes are already zero from alloc.
  return buf;
}

/**
 * Pull complete packets off a buffer, returning them plus whatever bytes remain.
 * TCP gives no framing guarantees, so a read can contain a partial packet, several
 * packets, or both.
 */
// Buffer.concat and Buffer.subarray return Buffer<ArrayBufferLike>, which is not
// assignable to the default Buffer<ArrayBuffer>. Naming the wider type keeps the
// accumulate-and-slice pattern below free of casts.
type Bytes = Buffer<ArrayBufferLike>;

export function decodePackets(buf: Bytes): { packets: RconPacket[]; rest: Bytes } {
  const packets: RconPacket[] = [];
  let offset = 0;

  while (buf.length - offset >= 4) {
    const size = buf.readInt32LE(offset);
    if (size < HEADER_BYTES - 2) {
      throw new RconError(`invalid packet size ${size}`);
    }
    if (buf.length - offset - 4 < size) break; // incomplete

    const id = buf.readInt32LE(offset + 4);
    const type = buf.readInt32LE(offset + 8);
    const body = buf.toString('utf8', offset + 12, offset + 4 + size - 2);
    packets.push({ id, type, body });
    offset += 4 + size;
  }

  return { packets, rest: buf.subarray(offset) };
}

export interface RconOptions {
  host: string;
  port: number;
  password: string;
  timeoutMs?: number;
}

export class RconClient {
  private opts: RconOptions;
  private socket: Socket | null = null;
  private buffer: Bytes = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void; chunks: string[] }>();

  constructor(opts: RconOptions) {
    this.opts = { timeoutMs: 5000, ...opts };
  }

  private get timeout(): number {
    return this.opts.timeoutMs ?? 5000;
  }

  async connect(): Promise<void> {
    if (this.socket) return;

    await new Promise<void>((resolve, reject) => {
      const sock = new Socket();
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new RconError(`connect timed out after ${this.timeout}ms`));
      }, this.timeout);

      sock.once('error', (err) => {
        clearTimeout(timer);
        sock.destroy();
        reject(new RconError(`connect failed: ${err.message}`));
      });

      sock.connect(this.opts.port, this.opts.host, () => {
        clearTimeout(timer);
        this.socket = sock;
        sock.on('data', (d) => this.onData(d));
        sock.on('close', () => this.onClose());
        sock.on('error', () => this.onClose());
        resolve();
      });
    });

    await this.authenticate();
  }

  private onData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    let decoded;
    try {
      decoded = decodePackets(this.buffer);
    } catch (err) {
      this.failAll(err as Error);
      return;
    }
    this.buffer = decoded.rest;

    for (const pkt of decoded.packets) {
      const waiter = this.pending.get(pkt.id);
      if (!waiter) continue;

      waiter.chunks.push(pkt.body);

      // A short body means this was the last (or only) packet for the command.
      // Longer bodies may continue into the next packet, so keep accumulating.
      if (pkt.body.length < SPLIT_THRESHOLD) {
        this.pending.delete(pkt.id);
        waiter.resolve(waiter.chunks.join(''));
      }
    }
  }

  private onClose(): void {
    this.socket = null;
    this.failAll(new RconError('connection closed'));
  }

  private failAll(err: Error): void {
    for (const [, waiter] of this.pending) waiter.reject(err);
    this.pending.clear();
  }

  private authenticate(): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const sock = this.socket;
      if (!sock) return reject(new RconError('not connected'));

      const timer = setTimeout(() => reject(new RconError('auth timed out')), this.timeout);

      const onAuthData = (data: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, data]);
        const { packets, rest } = decodePackets(this.buffer);
        this.buffer = rest;

        for (const pkt of packets) {
          if (pkt.type !== AUTH_RESPONSE && pkt.type !== RESPONSE_VALUE) continue;
          // The server sends an empty RESPONSE_VALUE before the real auth reply;
          // only the AUTH_RESPONSE carries the verdict.
          if (pkt.type !== AUTH_RESPONSE) continue;

          clearTimeout(timer);
          sock.removeListener('data', onAuthData);

          // id === -1 is the documented signal for a rejected password.
          if (pkt.id === -1) return reject(new RconAuthError('rcon authentication failed'));
          return resolve();
        }
      };

      sock.prependListener('data', onAuthData);
      sock.write(encodePacket(id, AUTH, this.opts.password));
    });
  }

  /** Run a command and return the server's reply. */
  async send(command: string): Promise<string> {
    if (!this.socket) await this.connect();
    const sock = this.socket;
    if (!sock) throw new RconError('not connected');

    const id = this.nextId++;

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RconError(`command timed out after ${this.timeout}ms`));
      }, this.timeout);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        chunks: [],
      });

      sock.write(encodePacket(id, EXEC_COMMAND, command));
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}

/**
 * Run a single command against the server, opening and closing the connection.
 *
 * Deliberately not a long-lived pooled connection: commands from Discord are
 * infrequent, and a persistent socket to a server that restarts often is more
 * failure modes than it is worth.
 */
export async function rconCommand(opts: RconOptions, command: string): Promise<string> {
  const client = new RconClient(opts);
  try {
    await client.connect();
    return await client.send(command);
  } finally {
    client.close();
  }
}

/** Strip Minecraft §-colour codes so replies read cleanly in Discord. */
export function stripFormatting(s: string): string {
  return s.replace(/§[0-9a-fk-orA-FK-OR]/g, '');
}
