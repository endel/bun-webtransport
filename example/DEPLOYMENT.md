# Tank Battle — Deployment on echo.web-transport.dev

The game server runs alongside the existing `wt-echo-server` (port 4433) on the same machine.

## Server details

- **Host**: `echo.web-transport.dev` (Debian 13, x86_64, DigitalOcean)
- **WebTransport port**: 4434 (UDP)
- **HTTP port**: 3001 (serves client static files + `/cert-hash`)
- **Install path**: `/opt/tank-battle/`
- **Systemd service**: `tank-battle.service`
- **TLS certs**: Let's Encrypt at `/etc/letsencrypt/live/echo.web-transport.dev/`

## Prerequisites on the server

```sh
apt-get install -y unzip rsync musl
curl -fsSL https://bun.sh/install | bash
```

`musl` is required because `libquic-zig.so` is built with zig targeting musl libc.

## Deploy / redeploy

From the repo root:

```sh
# 1. Build the client locally
cd example/client && bun run build && cd ../..

# 2. Upload code (excludes node_modules, certs, git)
rsync -avz --exclude node_modules --exclude certs --exclude .git --exclude bun.lock \
  example/ root@echo.web-transport.dev:/opt/tank-battle/

# 3. Install deps & restart on the server
ssh root@echo.web-transport.dev '\
  export PATH="/root/.bun/bin:$PATH" && \
  cd /opt/tank-battle && \
  bun install && \
  systemctl restart tank-battle'
```

## Systemd service

Located at `/etc/systemd/system/tank-battle.service`:

```ini
[Unit]
Description=Tank Battle WebTransport Game Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/tank-battle
Environment=PATH=/root/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=LD_LIBRARY_PATH=/usr/lib/x86_64-linux-musl
Environment=WT_PORT=4434
Environment=HTTP_PORT=3001
Environment=CERT_PATH=/etc/letsencrypt/live/echo.web-transport.dev/fullchain.pem
Environment=KEY_PATH=/etc/letsencrypt/live/echo.web-transport.dev/privkey.pem
ExecStart=/root/.bun/bin/bun run server.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Useful commands:

```sh
systemctl status tank-battle
systemctl restart tank-battle
journalctl -u tank-battle -f
```

## Environment variables (server.ts)

| Variable    | Default                     | Description               |
|-------------|-----------------------------|---------------------------|
| `WT_PORT`   | `4433`                      | WebTransport (QUIC) port  |
| `HTTP_PORT` | `3000`                      | HTTP server port          |
| `CERT_PATH` | `./certs/server.crt`        | TLS certificate path      |
| `KEY_PATH`  | `./certs/server.key`        | TLS private key path      |

## Client connection

The client auto-detects the environment:
- **Local dev** (localhost): connects to `127.0.0.1:4433` with self-signed cert hash pinning
- **Production** (any other host): connects to `echo.web-transport.dev:4434` using trusted CA certs

Override via URL params: `?host=...&port=...&certHash=...`
