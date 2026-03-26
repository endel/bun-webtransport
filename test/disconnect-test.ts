/**
 * Disconnect detection test: verifies the server detects when a
 * WebTransport client closes its connection.
 *
 * Tests both graceful close (wt.close()) and abrupt close (page navigation).
 */
import puppeteer from "puppeteer-core";
import { WebTransportServer } from "../src/wt";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const certPath = resolve(__dirname, "../example/certs/server.crt");
const keyPath = resolve(__dirname, "../example/certs/server.key");

const pem = readFileSync(certPath, "utf8");
const der = Buffer.from(
  pem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\n/g, ""),
  "base64",
);
const certHashHex = createHash("sha256").update(der).digest("hex");

// ── Track server events ──
const events: { ts: number; type: string; clientId: bigint }[] = [];
const connectedClients = new Set<bigint>();
const t0 = Date.now();

function log(msg: string) {
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
}

const server = new WebTransportServer({
  address: "0.0.0.0",
  port: 4435,
  certPath,
  keyPath,
  handler: {
    onConnectRequest(clientId, sessionId, path) {
      log(`EVENT connect_request client=${clientId}`);
      events.push({ ts: Date.now(), type: "connect", clientId });
      connectedClients.add(clientId);
      server.acceptSession(clientId, sessionId);
    },
    onSessionReady(clientId) {
      log(`EVENT session_ready client=${clientId}`);
    },
    onBidiStream(clientId, sessionId, streamId) {
      log(`EVENT bidi_stream client=${clientId}`);
      // Send a hello so browser knows it's connected
      const msg = new TextEncoder().encode("hello");
      const frame = new Uint8Array(4 + msg.length);
      new DataView(frame.buffer).setUint32(0, msg.length, true);
      frame.set(msg, 4);
      server.sendStream(clientId, streamId, frame);
    },
    onDatagram(clientId) {
      // Ignore — just input
    },
    onSessionClosed(clientId, sessionId, errorCode, reason) {
      log(`EVENT session_closed client=${clientId} code=${errorCode} reason="${reason}"`);
      events.push({ ts: Date.now(), type: "session_closed", clientId });
      connectedClients.delete(clientId);
    },
    onSessionDraining(clientId) {
      log(`EVENT session_draining client=${clientId}`);
      events.push({ ts: Date.now(), type: "draining", clientId });
    },
    onDisconnected(clientId) {
      log(`EVENT disconnected client=${clientId}`);
      events.push({ ts: Date.now(), type: "disconnected", clientId });
      connectedClients.delete(clientId);
    },
  },
});

// Also poll isClientConnected every second for diagnosis
let pollClientId: bigint | null = null;
const pollInterval = setInterval(() => {
  if (pollClientId !== null) {
    const connected = server.isClientConnected(pollClientId);
    const inSet = connectedClients.has(pollClientId);
    log(`POLL isClientConnected(${pollClientId})=${connected} inSet=${inSet} connectionCount=${server.connectionCount}`);
  }
}, 1000);

// HTTP server for cert hash + test page
const httpServer = Bun.serve({
  port: 3002,
  fetch(req: Request) {
    const url = new URL(req.url);
    if (url.pathname === "/cert-hash") {
      return new Response(certHashHex, {
        headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" },
      });
    }
    return new Response(
      "<html><head><title>WT Disconnect Test</title></head><body>ready</body></html>",
      { headers: { "Content-Type": "text/html" } },
    );
  },
});

log("Server started on wt://0.0.0.0:4435, http://localhost:3002");

async function runTest() {
  const browser = await puppeteer.launch({
    headless: "shell",
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: [
      "--enable-experimental-web-platform-features",
      "--origin-to-force-quic-on=127.0.0.1:4435",
      "--ignore-certificate-errors",
      "--no-sandbox",
    ],
  });

  const page = await browser.newPage();
  page.on("console", (msg) => log(`[browser] ${msg.text()}`));

  await page.goto("http://localhost:3002/index.html");

  // ── Test 1: Graceful close (wt.close()) ──
  log("\n=== TEST 1: Graceful close via wt.close() ===");

  const clientConnected = await page.evaluate(
    async (certHashHex: string) => {
      const hashBytes = new Uint8Array(certHashHex.length / 2);
      for (let i = 0; i < certHashHex.length; i += 2)
        hashBytes[i / 2] = parseInt(certHashHex.substring(i, i + 2), 16);

      const wt = new WebTransport("https://127.0.0.1:4435/test", {
        serverCertificateHashes: [
          { algorithm: "sha-256", value: hashBytes.buffer },
        ],
      });
      await wt.ready;
      console.log("Connected, opening bidi stream...");

      const stream = await wt.createBidirectionalStream();
      console.log("Stream opened, reading hello...");

      const reader = stream.readable.getReader();
      const { value } = await reader.read();
      console.log(`Got ${value?.length} bytes`);
      reader.releaseLock();

      // Store wt on window for later close
      (window as any).__wt = wt;
      return true;
    },
    certHashHex,
  );

  if (!clientConnected) {
    log("FAIL: Could not connect");
    await browser.close();
    process.exit(1);
  }

  // Record which client connected
  pollClientId = [...connectedClients][0] ?? null;
  log(`Client connected: ${pollClientId}`);

  // Wait a moment, then gracefully close
  await Bun.sleep(1000);
  log("Calling wt.close() in browser...");

  await page.evaluate(() => {
    (window as any).__wt.close();
    console.log("wt.close() called");
  });

  // Wait up to 40 seconds for server to detect disconnect
  log("Waiting for server to detect graceful disconnect...");
  const gracefulStart = Date.now();
  let gracefulDetected = false;

  while (Date.now() - gracefulStart < 40_000) {
    if (pollClientId !== null && !server.isClientConnected(pollClientId)) {
      gracefulDetected = true;
      break;
    }
    await Bun.sleep(500);
  }

  const gracefulTime = ((Date.now() - gracefulStart) / 1000).toFixed(1);
  if (gracefulDetected) {
    log(`PASS: Graceful disconnect detected in ${gracefulTime}s`);
  } else {
    log(`FAIL: Graceful disconnect NOT detected after ${gracefulTime}s`);
  }

  // ── Test 2: Abrupt close (navigate away / close page) ──
  log("\n=== TEST 2: Abrupt close via page navigation ===");
  connectedClients.clear();
  pollClientId = null;

  // Open a new page and connect
  const page2 = await browser.newPage();
  page2.on("console", (msg) => log(`[browser2] ${msg.text()}`));
  await page2.goto("http://localhost:3002/index.html");

  await page2.evaluate(async (certHashHex: string) => {
    const hashBytes = new Uint8Array(certHashHex.length / 2);
    for (let i = 0; i < certHashHex.length; i += 2)
      hashBytes[i / 2] = parseInt(certHashHex.substring(i, i + 2), 16);

    const wt = new WebTransport("https://127.0.0.1:4435/test2", {
      serverCertificateHashes: [
        { algorithm: "sha-256", value: hashBytes.buffer },
      ],
    });
    await wt.ready;
    const stream = await wt.createBidirectionalStream();
    const reader = stream.readable.getReader();
    await reader.read();
    reader.releaseLock();
    console.log("Connected for abrupt close test");
  }, certHashHex);

  await Bun.sleep(500);
  pollClientId = [...connectedClients][0] ?? null;
  log(`Client connected: ${pollClientId}`);

  // Abruptly close the page (simulates closing a tab)
  log("Closing browser page (abrupt disconnect)...");
  await page2.close();

  // Wait up to 40 seconds
  log("Waiting for server to detect abrupt disconnect...");
  const abruptStart = Date.now();
  let abruptDetected = false;

  while (Date.now() - abruptStart < 40_000) {
    if (pollClientId !== null && !server.isClientConnected(pollClientId)) {
      abruptDetected = true;
      break;
    }
    await Bun.sleep(500);
  }

  const abruptTime = ((Date.now() - abruptStart) / 1000).toFixed(1);
  if (abruptDetected) {
    log(`PASS: Abrupt disconnect detected in ${abruptTime}s`);
  } else {
    log(`FAIL: Abrupt disconnect NOT detected after ${abruptTime}s`);
  }

  // ── Summary ──
  log("\n=== RESULTS ===");
  log(`Graceful close: ${gracefulDetected ? "PASS" : "FAIL"} (${gracefulTime}s)`);
  log(`Abrupt close:   ${abruptDetected ? "PASS" : "FAIL"} (${abruptTime}s)`);

  log("\nAll events received:");
  for (const e of events) {
    log(`  +${((e.ts - t0) / 1000).toFixed(1)}s ${e.type} client=${e.clientId}`);
  }

  await browser.close();
  clearInterval(pollInterval);
  server.stop();
  httpServer.stop();

  process.exit(gracefulDetected && abruptDetected ? 0 : 1);
}

runTest().catch((err) => {
  console.error(err);
  clearInterval(pollInterval);
  server.stop();
  httpServer.stop();
  process.exit(1);
});
