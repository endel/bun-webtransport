# bun-webtransport

WebTransport server for Bun, powered by [quic-zig](https://github.com/endel/quic-zig) via FFI.

Bun handles HTTP/1.1 + WebSocket. This package adds HTTP/3 + WebTransport by calling into quic-zig's QUIC implementation through a thin C ABI shared library.

## Status

**Working proof-of-concept.** End-to-end tested with quic-zig's own WebTransport client — streams, datagrams, session lifecycle, and clean disconnection all verified.

### What works

- Server creation with TLS cert/key
- Tick-based event loop (single-threaded, no mutexes)
- Accepting/rejecting WebTransport sessions
- Bidirectional and unidirectional streams (open, send, close, reset)
- Datagrams (send/receive, queue-full and max-size checks)
- Connection lifecycle events (connect, ready, closed, draining, disconnected)
- Client ID mapping (stable IDs across multiple sessions per QUIC connection)
- Echo server tested end-to-end with quic-zig native client

### Not yet done

- No backpressure signaling for streams
- No connection migration support exposed

## Prerequisites

- [Bun](https://bun.sh) >= 1.0
- [Zig](https://ziglang.org) >= 0.15.2

## Setup

```bash
git clone --recursive <repo-url>
cd bun-webtransport
bun run build
```

quic-zig is included as a git submodule. The `build` script compiles it into a shared library (`quic-zig/zig-out/lib/libquic-zig.dylib` on macOS, `.so` on Linux).

## Usage

```typescript
import { WebTransportServer } from "bun-webtransport";

const server = new WebTransportServer({
  port: 4433,
  certPath: "./certs/server.crt",
  keyPath: "./certs/server.key",
  handler: {
    onConnectRequest(clientId, sessionId, path) {
      console.log(`connect: client=${clientId} path=${path}`);
      server.acceptSession(clientId, sessionId);
    },

    onStreamData(clientId, streamId, sessionId, data, fin) {
      console.log(`stream data: ${new TextDecoder().decode(data)}`);
      server.sendStream(clientId, streamId, data); // echo
    },

    onDatagram(clientId, sessionId, data) {
      server.sendDatagram(clientId, sessionId, data); // echo
    },

    onDisconnected(clientId) {
      console.log(`client ${clientId} disconnected`);
    },
  },
});
```

## Testing

```bash
# Build the shared library
bun run build

# Terminal 1: start the echo server
bun run dev

# Terminal 2: connect with quic-zig's client
cd quic-zig && zig build wt-client && zig-out/bin/wt-client --port 4433
```

## Architecture

```
JS setInterval(1ms) → qz_server_tick() → qz_server_poll() loop → dispatch events
                     ↓                    ↓
              recv packets,          CApiHandler queues
              process QUIC,          events during tick
              send responses
```

quic-zig's `Server.tick()` runs the event loop in non-blocking mode. The C API handler collects all events into a queue during the tick. JS drains the queue via `qz_server_poll()`, which serializes one event at a time into a shared buffer using a compact binary protocol (24-byte header + extended fields + variable data, little-endian).

Actions like `acceptSession`, `sendStream`, and `sendDatagram` execute synchronously — no thread handoff, no locks.

## API

### `WebTransportServer`

| Method | Description |
|--------|-------------|
| `acceptSession(clientId, sessionId)` | Accept a pending session |
| `closeSession(clientId, sessionId)` | Close a session gracefully |
| `closeSessionWithError(clientId, sessionId, errorCode, reason)` | Close with an error code |
| `openBidiStream(clientId, sessionId): bigint` | Open a bidirectional stream |
| `openUniStream(clientId, sessionId): bigint` | Open a unidirectional stream |
| `sendStream(clientId, streamId, data)` | Send data on a stream |
| `closeStream(clientId, streamId)` | Close a stream |
| `resetStream(clientId, streamId, errorCode)` | Reset a stream with an error |
| `sendDatagram(clientId, sessionId, data)` | Send an unreliable datagram |
| `maxDatagramSize(clientId, sessionId): number` | Max datagram payload size |
| `connectionCount: number` | Number of active QUIC connections |
| `stop()` | Graceful shutdown |

All IDs (`clientId`, `sessionId`, `streamId`) are `bigint`.

### `WebTransportHandler`

| Callback | When |
|----------|------|
| `onConnectRequest(clientId, sessionId, path)` | Client requests a session |
| `onSessionReady(clientId, sessionId)` | Session is established |
| `onStreamData(clientId, streamId, sessionId, data, fin)` | Data received on a stream |
| `onDatagram(clientId, sessionId, data)` | Datagram received |
| `onSessionClosed(clientId, sessionId, errorCode, reason)` | Session closed |
| `onSessionDraining(clientId, sessionId)` | Session is draining |
| `onBidiStream(clientId, sessionId, streamId)` | Remote opened a bidi stream |
| `onUniStream(clientId, sessionId, streamId)` | Remote opened a uni stream |
| `onDisconnected(clientId)` | QUIC connection closed |

## Project structure

```
bun-webtransport/
├── src/wt.ts          # Bun FFI bindings + WebTransportServer class
├── test-wt.ts         # Echo server test script
├── package.json
└── quic-zig/          # git submodule
    ├── src/c_api.zig  # C ABI wrapper (CApiHandler + exported functions)
    ├── build.zig      # Build target: `zig build lib`
    └── zig-out/lib/   # Built shared library (after `bun run build`)
```

## License

MIT
