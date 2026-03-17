/**
 * Minimal WebTransport server instrumented with high-resolution timestamps
 * at every connection lifecycle stage. Used by timing-test.ts (Puppeteer)
 * to diagnose where the 5+ second first-message delay occurs.
 */
import { WebTransportServer } from "../src/wt";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const certPath = resolve(__dirname, "../example/certs/server.crt");
const keyPath = resolve(__dirname, "../example/certs/server.key");

// Compute cert hash for the browser test
const pem = readFileSync(certPath, "utf8");
const der = Buffer.from(
  pem.replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\n/g, ""),
  "base64"
);
const certHashHex = createHash("sha256").update(der).digest("hex");

// Timing log
interface TimingEntry {
  event: string;
  ts: number;   // hrtime ms
  delta: number; // ms since last event for this client
}
const clientTimings = new Map<bigint, TimingEntry[]>();

function hrMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

function logTiming(clientId: bigint, event: string) {
  const now = hrMs();
  let entries = clientTimings.get(clientId);
  if (!entries) {
    entries = [];
    clientTimings.set(clientId, entries);
  }
  const last = entries.length > 0 ? entries[entries.length - 1].ts : now;
  const entry = { event, ts: now, delta: now - last };
  entries.push(entry);
  console.log(`[timing] client=${clientId} event=${event} delta=${entry.delta.toFixed(2)}ms total=${(now - entries[0].ts).toFixed(2)}ms`);
}

// Session→client mapping for stream events
const sessionToClient = new Map<bigint, bigint>();
const clientSessions = new Map<bigint, bigint>();
const clientStreams = new Map<bigint, bigint>();

let tickCount = 0;
const ECHO_PAYLOAD = new Uint8Array(64);
for (let i = 0; i < 64; i++) ECHO_PAYLOAD[i] = i;

const server = new WebTransportServer({
  address: "0.0.0.0",
  port: 4434,
  certPath,
  keyPath,
  tickInterval: 1,
  handler: {
    onConnectRequest(clientId, sessionId, path) {
      logTiming(clientId, `connect_request(path=${path})`);
      sessionToClient.set(sessionId, clientId);
      clientSessions.set(clientId, sessionId);
      server.acceptSession(clientId, sessionId);
      logTiming(clientId, "session_accepted");
    },

    onSessionReady(clientId, sessionId) {
      logTiming(clientId, "session_ready");
    },

    onBidiStream(clientId, sessionId, streamId) {
      logTiming(clientId, `bidi_stream(stream=${streamId})`);
      clientStreams.set(clientId, streamId);

      // Send a small framed message immediately
      const msg = new TextEncoder().encode(JSON.stringify({
        type: "hello",
        serverTs: hrMs(),
        tickCount,
      }));
      const frame = new Uint8Array(4 + msg.length);
      const view = new DataView(frame.buffer);
      view.setUint32(0, msg.length, true);
      frame.set(msg, 4);
      server.sendStream(clientId, streamId, frame);
      logTiming(clientId, "hello_sent");

      // Send a second message after a short delay to verify ongoing delivery
      setTimeout(() => {
        try {
          const msg2 = new TextEncoder().encode(JSON.stringify({
            type: "ping",
            serverTs: hrMs(),
            tickCount,
          }));
          const frame2 = new Uint8Array(4 + msg2.length);
          const view2 = new DataView(frame2.buffer);
          view2.setUint32(0, msg2.length, true);
          frame2.set(msg2, 4);
          server.sendStream(clientId, streamId, frame2);
          logTiming(clientId, "ping_sent");
        } catch {}
      }, 50);
    },

    onUniStream(clientId, sessionId, streamId) {
      logTiming(clientId, `uni_stream(stream=${streamId})`);
    },

    onStreamData(clientId, streamId, sessionId, data, fin) {
      logTiming(clientId, `stream_data(len=${data.length},fin=${fin})`);
      // Echo back as framed message
      try {
        const frame = new Uint8Array(4 + data.length);
        const view = new DataView(frame.buffer);
        view.setUint32(0, data.length, true);
        frame.set(data, 4);
        const sid = clientStreams.get(clientId);
        if (sid !== undefined) {
          server.sendStream(clientId, sid, frame);
          logTiming(clientId, "echo_sent");
        }
      } catch {}
    },

    onDatagram(clientId, sessionId, data) {
      logTiming(clientId, `datagram(len=${data.length})`);
      // Echo back
      try {
        server.sendDatagram(clientId, sessionId, data);
        logTiming(clientId, "datagram_echo_sent");
      } catch {}
    },

    onSessionClosed(clientId, sessionId, errorCode, reason) {
      logTiming(clientId, `session_closed(code=${errorCode})`);
      printTimingSummary(clientId);
    },

    onSessionDraining(clientId, sessionId) {
      logTiming(clientId, "session_draining");
    },

    onDisconnected(clientId) {
      logTiming(clientId, "disconnected");
      printTimingSummary(clientId);
    },
  },
});

function printTimingSummary(clientId: bigint) {
  const entries = clientTimings.get(clientId);
  if (!entries || entries.length === 0) return;
  console.log(`\n=== Timing Summary for client ${clientId} ===`);
  const t0 = entries[0].ts;
  for (const e of entries) {
    console.log(`  +${(e.ts - t0).toFixed(2)}ms (delta ${e.delta.toFixed(2)}ms) ${e.event}`);
  }
  console.log(`  TOTAL: ${(entries[entries.length - 1].ts - t0).toFixed(2)}ms`);
  console.log("");
}

// Track tick count for debugging
const origTick = (server as any).tick?.bind(server);
setInterval(() => { tickCount++; }, 1);

// HTTP server for cert hash + minimal test page
Bun.serve({
  port: 3001,
  fetch(req: Request) {
    const url = new URL(req.url);
    const headers = {
      "Access-Control-Allow-Origin": "*",
    };
    if (url.pathname === "/cert-hash") {
      return new Response(certHashHex, {
        headers: { "Content-Type": "text/plain", ...headers },
      });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response("<html><head><title>WT Test</title></head><body>ready</body></html>", {
        headers: { "Content-Type": "text/html", ...headers },
      });
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Timing test server started:`);
console.log(`  WebTransport: https://0.0.0.0:4434`);
console.log(`  HTTP (cert-hash): http://localhost:3001`);
console.log(`  Cert SHA-256: ${certHashHex}\n`);
