# Tank Battle — bun-webtransport example

A multiplayer 4-team tank battle using WebTransport for real-time communication and [@colyseus/schema](https://github.com/colyseus/schema) for state synchronization.

> Inspired by [Tanx](http://playcanv.as/p/aP0oxhUr) from [PlayCanvas](https://playcanvas.com/), by [Max M](https://github.com/Maksims) — Original server sources: [cvan/tanx-1](https://github.com/cvan/tanx-1). See also [colyseus/realtime-tanks-demo](https://github.com/colyseus/realtime-tanks-demo) for WebSocket-based implementations across multiple game engines.

## Prerequisites

- [Bun](https://bun.sh) installed
- OpenSSL (for generating certificates)

## Setup

```bash
# Install dependencies
cd example
bun install

# Generate self-signed certificates (valid for 13 days)
bash generate-certs.sh

# Build the client
cd client
bun install
bun run build
cd ..
```

## Run

```bash
bun run server.ts
```

- WebTransport server: `https://0.0.0.0:4433`
- HTTP server (client + cert hash): `http://localhost:3000`

Open `http://localhost:3000` in Chrome/Edge to play.

> **Note:** Browsers require certificates valid for 14 days or less for WebTransport. Re-run `generate-certs.sh` when they expire.
