import { dlopen, suffix, ptr } from "bun:ffi";
import { existsSync } from "fs";
import { resolve, dirname } from "path";

// ---------------------------------------------------------------------------
// Load the quic-zig shared library
// ---------------------------------------------------------------------------

function findLibrary(): string {
  const libName = `libquic-zig.${suffix}`;

  // Try platform-specific npm package first
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const pkgName = `bun-webtransport-build-${platform}-${arch}`;
  try {
    const pkgPath = require.resolve(`${pkgName}/package.json`);
    const candidate = resolve(dirname(pkgPath), libName);
    if (existsSync(candidate)) return candidate;
  } catch {}

  // Fallback: local build (development)
  const local = new URL(
    `../quic-zig/zig-out/lib/${libName}`,
    import.meta.url,
  ).pathname;
  if (existsSync(local)) return local;

  throw new Error(
    `Could not find ${libName}. Install the platform package (${pkgName}) or run: bun run build`,
  );
}

const LIB_PATH = findLibrary();

const lib = dlopen(LIB_PATH, {
  // Server lifecycle
  qz_server_create: {
    args: ["cstring", "u16", "cstring", "cstring"],
    returns: "ptr",
  },
  qz_server_tick: { args: ["ptr"], returns: "i32" },
  qz_server_poll: { args: ["ptr", "ptr", "u32"], returns: "u32" },
  qz_server_flush: { args: ["ptr"], returns: "void" },
  qz_server_stop: { args: ["ptr"], returns: "void" },
  qz_server_destroy: { args: ["ptr"], returns: "void" },
  qz_server_connection_count: { args: ["ptr"], returns: "u32" },
  qz_is_client_connected: { args: ["ptr", "u64"], returns: "i32" },

  // Session management
  qz_session_accept: { args: ["ptr", "u64", "u64"], returns: "i32" },
  qz_session_close: { args: ["ptr", "u64", "u64"], returns: "void" },
  qz_session_close_error: {
    args: ["ptr", "u64", "u64", "u32", "ptr", "u32"],
    returns: "i32",
  },

  // Streams
  qz_stream_open_bidi: { args: ["ptr", "u64", "u64"], returns: "u64" },
  qz_stream_open_uni: { args: ["ptr", "u64", "u64"], returns: "u64" },
  qz_stream_send: {
    args: ["ptr", "u64", "u64", "ptr", "u32"],
    returns: "i32",
  },
  qz_stream_close: { args: ["ptr", "u64", "u64"], returns: "void" },
  qz_stream_reset: { args: ["ptr", "u64", "u64", "u32"], returns: "void" },

  // Datagrams
  qz_datagram_send: {
    args: ["ptr", "u64", "u64", "ptr", "u32"],
    returns: "i32",
  },
  qz_datagram_max_size: { args: ["ptr", "u64", "u64"], returns: "u32" },
});

const ffi = lib.symbols;

// ---------------------------------------------------------------------------
// Event types (must match c_api.zig EventType enum)
// ---------------------------------------------------------------------------

const EVENT = {
  NONE: 0,
  CONNECT_REQUEST: 1,
  SESSION_READY: 2,
  SESSION_CLOSED: 3,
  SESSION_DRAINING: 4,
  BIDI_STREAM: 5,
  UNI_STREAM: 6,
  STREAM_DATA: 7,
  DATAGRAM: 8,
  CLIENT_DISCONNECTED: 9,
} as const;

// ---------------------------------------------------------------------------
// Handler interface
// ---------------------------------------------------------------------------

export interface WebTransportHandler {
  onConnectRequest?(
    clientId: bigint,
    sessionId: bigint,
    path: string,
  ): void;
  onSessionReady?(clientId: bigint, sessionId: bigint): void;
  onStreamData?(
    clientId: bigint,
    streamId: bigint,
    sessionId: bigint,
    data: Uint8Array,
    fin: boolean,
  ): void;
  onDatagram?(clientId: bigint, sessionId: bigint, data: Uint8Array): void;
  onSessionClosed?(
    clientId: bigint,
    sessionId: bigint,
    errorCode: number,
    reason: string,
  ): void;
  onSessionDraining?(clientId: bigint, sessionId: bigint): void;
  onBidiStream?(
    clientId: bigint,
    sessionId: bigint,
    streamId: bigint,
  ): void;
  onUniStream?(
    clientId: bigint,
    sessionId: bigint,
    streamId: bigint,
  ): void;
  onDisconnected?(clientId: bigint): void;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WebTransportServerOptions {
  address?: string;
  port: number;
  certPath: string;
  keyPath: string;
  handler: WebTransportHandler;
  tickInterval?: number; // ms, default 1
}

// ---------------------------------------------------------------------------
// WebTransportServer
// ---------------------------------------------------------------------------

const POLL_BUF_SIZE = 65536;
const decoder = new TextDecoder();
const U64_MAX = 0xffffffffffffffffn;

export class WebTransportServer {
  private server: number; // opaque ptr stored as number
  private buf = new Uint8Array(POLL_BUF_SIZE);
  private view = new DataView(this.buf.buffer);
  private bufPtr = ptr(this.buf);
  private handler: WebTransportHandler;
  private interval: ReturnType<typeof setInterval>;

  constructor(opts: WebTransportServerOptions) {
    const address = opts.address ?? "127.0.0.1";
    const serverPtr = ffi.qz_server_create(
      Buffer.from(address + "\0"),
      opts.port,
      Buffer.from(opts.certPath + "\0"),
      Buffer.from(opts.keyPath + "\0"),
    );
    if (!serverPtr) {
      throw new Error(
        `Failed to create WebTransport server on ${address}:${opts.port}`,
      );
    }
    this.server = serverPtr as unknown as number;
    this.handler = opts.handler;
    this.interval = setInterval(() => this.tick(), opts.tickInterval ?? 1);
  }

  // -------------------------------------------------------------------------
  // Tick loop
  // -------------------------------------------------------------------------

  private tick() {
    ffi.qz_server_tick(this.server);
    while (true) {
      const n = ffi.qz_server_poll(
        this.server,
        this.bufPtr,
        POLL_BUF_SIZE,
      );
      if (n === 0) break;
      this.dispatch(n as number);
    }
    // Flush data queued by handlers or application code (acceptSession,
    // sendStream, sendDatagram, etc.) so outgoing QUIC packets are built
    // and sent immediately rather than waiting for the next I/O event.
    ffi.qz_server_flush(this.server);
  }

  private dispatch(_n: number) {
    const v = this.view;
    const type = v.getUint8(0);
    const flags = v.getUint8(1);
    const dataLen = v.getUint32(4, true);
    const clientId = v.getBigUint64(8, true);
    const id1 = v.getBigUint64(16, true);

    let offset = 24;

    switch (type) {
      case EVENT.CONNECT_REQUEST: {
        const path = decoder.decode(this.buf.subarray(offset, offset + dataLen));
        this.handler.onConnectRequest?.(clientId, id1, path);
        break;
      }

      case EVENT.SESSION_READY:
        this.handler.onSessionReady?.(clientId, id1);
        break;

      case EVENT.SESSION_CLOSED: {
        const errorCode = v.getUint32(24, true);
        offset = 28;
        const reason =
          dataLen > 0
            ? decoder.decode(this.buf.subarray(offset, offset + dataLen))
            : "";
        this.handler.onSessionClosed?.(clientId, id1, errorCode, reason);
        break;
      }

      case EVENT.SESSION_DRAINING:
        this.handler.onSessionDraining?.(clientId, id1);
        break;

      case EVENT.BIDI_STREAM: {
        const streamId = v.getBigUint64(24, true);
        this.handler.onBidiStream?.(clientId, id1, streamId);
        break;
      }

      case EVENT.UNI_STREAM: {
        const streamId = v.getBigUint64(24, true);
        this.handler.onUniStream?.(clientId, id1, streamId);
        break;
      }

      case EVENT.STREAM_DATA: {
        const sessionId = v.getBigUint64(24, true);
        offset = 32;
        const data = this.buf.slice(offset, offset + dataLen); // copy
        const fin = (flags & 1) !== 0;
        this.handler.onStreamData?.(clientId, id1, sessionId, data, fin);
        break;
      }

      case EVENT.DATAGRAM: {
        const data = this.buf.slice(offset, offset + dataLen); // copy
        this.handler.onDatagram?.(clientId, id1, data);
        break;
      }

      case EVENT.CLIENT_DISCONNECTED:
        this.handler.onDisconnected?.(clientId);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  acceptSession(clientId: bigint, sessionId: bigint): void {
    const rc = ffi.qz_session_accept(this.server, clientId, sessionId);
    if (rc !== 0) throw new Error(`acceptSession failed (code ${rc})`);
  }

  closeSession(clientId: bigint, sessionId: bigint): void {
    ffi.qz_session_close(this.server, clientId, sessionId);
  }

  closeSessionWithError(
    clientId: bigint,
    sessionId: bigint,
    errorCode: number,
    reason: string,
  ): void {
    const encoded = Buffer.from(reason);
    ffi.qz_session_close_error(
      this.server,
      clientId,
      sessionId,
      errorCode,
      ptr(encoded),
      encoded.length,
    );
  }

  openBidiStream(clientId: bigint, sessionId: bigint): bigint {
    const id = ffi.qz_stream_open_bidi(this.server, clientId, sessionId);
    if (id === U64_MAX) throw new Error("openBidiStream failed");
    return id as bigint;
  }

  openUniStream(clientId: bigint, sessionId: bigint): bigint {
    const id = ffi.qz_stream_open_uni(this.server, clientId, sessionId);
    if (id === U64_MAX) throw new Error("openUniStream failed");
    return id as bigint;
  }

  sendStream(clientId: bigint, streamId: bigint, data: Uint8Array): void {
    if (data.length === 0) return;
    const rc = ffi.qz_stream_send(
      this.server,
      clientId,
      streamId,
      ptr(data),
      data.length,
    );
    if (rc !== 0) throw new Error(`sendStream failed (code ${rc})`);
  }

  closeStream(clientId: bigint, streamId: bigint): void {
    ffi.qz_stream_close(this.server, clientId, streamId);
  }

  resetStream(clientId: bigint, streamId: bigint, errorCode: number): void {
    ffi.qz_stream_reset(this.server, clientId, streamId, errorCode);
  }

  sendDatagram(clientId: bigint, sessionId: bigint, data: Uint8Array): void {
    if (data.length === 0) return;
    const rc = ffi.qz_datagram_send(
      this.server,
      clientId,
      sessionId,
      ptr(data),
      data.length,
    );
    if (rc !== 0) throw new Error(`sendDatagram failed (code ${rc})`);
  }

  maxDatagramSize(clientId: bigint, sessionId: bigint): number {
    return ffi.qz_datagram_max_size(
      this.server,
      clientId,
      sessionId,
    ) as number;
  }

  get connectionCount(): number {
    return ffi.qz_server_connection_count(this.server) as number;
  }

  isClientConnected(clientId: bigint): boolean {
    return ffi.qz_is_client_connected(this.server, clientId) !== 0;
  }

  stop(): void {
    clearInterval(this.interval);
    ffi.qz_server_stop(this.server);
    ffi.qz_server_destroy(this.server);
  }
}
