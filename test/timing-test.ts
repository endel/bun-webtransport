/**
 * Puppeteer-based connectivity timing test for bun-webtransport.
 *
 * Launches Chrome, connects via WebTransport, and reports high-resolution
 * timings for every connection phase:
 *   1. Cert hash fetch
 *   2. WebTransport constructor → .ready
 *   3. createBidirectionalStream()
 *   4. First message received on stream
 *   5. Datagram round-trip
 *
 * Usage: bun run test/timing-test.ts
 * (Requires timing-server.ts running on port 4433 + 3000)
 */
import puppeteer from "puppeteer-core";
import { spawn, type Subprocess } from "bun";

const SERVER_HTTP = "http://127.0.0.1:3001";
const SERVER_WT = "https://127.0.0.1:4434";

// ── Launch timing-server ──────────────────────────────────────
let serverProc: Subprocess | null = null;

async function startServer(): Promise<void> {
  console.log("[test] Starting timing server...");
  serverProc = spawn({
    cmd: ["bun", "run", "test/timing-server.ts"],
    cwd: import.meta.dir + "/..",
    stdout: "inherit",
    stderr: "inherit",
  });

  // Wait until HTTP endpoint is up
  for (let i = 0; i < 50; i++) {
    try {
      const resp = await fetch(`${SERVER_HTTP}/cert-hash`);
      if (resp.ok) {
        console.log("[test] Server is ready.\n");
        return;
      }
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("Server did not start within 5 seconds");
}

async function stopServer() {
  if (serverProc) {
    serverProc.kill();
    serverProc = null;
  }
}

// ── Browser test ──────────────────────────────────────────────
async function runBrowserTest() {
  // Fetch cert hash from Node/Bun side first (avoids CORS issues in about:blank)
  const certResp = await fetch(`${SERVER_HTTP}/cert-hash`);
  const certHashHex = (await certResp.text()).trim();
  console.log(`[test] Cert hash: ${certHashHex}`);

  const browser = await puppeteer.launch({
    headless: "shell",
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: [
      "--enable-experimental-web-platform-features",
      "--origin-to-force-quic-on=127.0.0.1:4434",
      "--ignore-certificate-errors",
      "--no-sandbox",
    ],
  });

  const page = await browser.newPage();

  // Collect all console.log output from the page
  page.on("console", (msg) => {
    const text = msg.text();
    console.log(`[browser] ${text}`);
  });

  page.on("pageerror", (err) => {
    console.error(`[browser error] ${err.message}`);
  });

  // Navigate to the test page (needs a real page for secure context / WebTransport)
  await page.goto(`${SERVER_HTTP}/index.html`);

  // Run the WebTransport timing test inside the browser
  const result = await page.evaluate(async (certHashHex: string, serverWt: string) => {
    const timings: { label: string; ts: number; delta: number }[] = [];
    let lastTs = performance.now();

    function mark(label: string) {
      const now = performance.now();
      timings.push({ label, ts: now, delta: now - lastTs });
      lastTs = now;
    }

    try {
      mark("test_start");

      // Convert hex to ArrayBuffer
      const hashBytes = new Uint8Array(certHashHex.length / 2);
      for (let i = 0; i < certHashHex.length; i += 2) {
        hashBytes[i / 2] = parseInt(certHashHex.substring(i, i + 2), 16);
      }

      // Step 1: Create WebTransport connection
      const wt = new WebTransport(`${serverWt}/test`, {
        serverCertificateHashes: [{
          algorithm: "sha-256",
          value: hashBytes.buffer,
        }],
      });
      mark("wt_constructor_called");

      await wt.ready;
      mark("wt_ready");

      // Step 2: Open bidirectional stream
      const stream = await wt.createBidirectionalStream();
      mark("bidi_stream_created");

      // Step 3: Read messages from server using a background reader loop
      // (avoids the dangling reader.read() issue with Promise.race timeouts)
      const reader = stream.readable.getReader();
      let buffer = new Uint8Array(0);
      let messages: any[] = [];
      let readResolve: (() => void) | null = null;

      // Background read pump — continuously reads and notifies waiters
      let readDone = false;
      (async () => {
        try {
          while (!readDone) {
            const { value, done } = await reader.read();
            if (done) { readDone = true; break; }

            // Append to buffer
            const newBuf = new Uint8Array(buffer.length + value.length);
            newBuf.set(buffer);
            newBuf.set(value, buffer.length);
            buffer = newBuf;

            // Extract framed messages
            while (buffer.length >= 4) {
              const len = buffer[0] | (buffer[1] << 8) | (buffer[2] << 16) | (buffer[3] << 24);
              if (buffer.length < 4 + len) break;
              const payload = buffer.slice(4, 4 + len);
              buffer = buffer.slice(4 + len);

              const msgText = new TextDecoder().decode(payload);
              try {
                const msg = JSON.parse(msgText);
                messages.push(msg);
                mark(`msg_received_${messages.length}(type=${msg.type})`);
              } catch {
                messages.push({ raw: msgText });
                mark(`msg_received_${messages.length}(raw)`);
              }
            }

            // Wake up any waiter
            if (readResolve) { readResolve(); readResolve = null; }
          }
        } catch { readDone = true; }
        if (readResolve) { readResolve(); readResolve = null; }
      })();

      async function waitForMessages(count: number, timeout: number): Promise<void> {
        const deadline = performance.now() + timeout;
        while (messages.length < count && !readDone && performance.now() < deadline) {
          await new Promise<void>((resolve) => {
            readResolve = resolve;
            setTimeout(resolve, Math.max(1, deadline - performance.now()));
          });
        }
      }

      // Wait for the 2 server messages (hello + ping) — should arrive within 200ms
      await waitForMessages(2, 2000);
      mark("initial_msgs_received");

      // Step 4: Send data on stream and wait for echo
      const testData = new TextEncoder().encode("echo_test_data");
      const writer = stream.writable.getWriter();
      await writer.write(testData);
      mark("stream_data_sent");
      writer.releaseLock();

      // Wait for echo (message 3)
      const echoMsgCount = messages.length + 1;
      await waitForMessages(echoMsgCount, 2000);
      mark("stream_echo_received");

      // Step 5: Test datagram round-trip
      let dgReceived = false;
      const dgTimings: { sent: number; received: number } = { sent: 0, received: 0 };

      try {
        const dgWriter = wt.datagrams.writable.getWriter();
        const dgReader = wt.datagrams.readable.getReader();

        dgTimings.sent = performance.now();
        await dgWriter.write(new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]));
        mark("datagram_sent");

        // Read datagram with timeout
        const dgReadPromise = dgReader.read();
        const dgTimeout = new Promise<{value: undefined, done: true}>((resolve) =>
          setTimeout(() => resolve({value: undefined, done: true}), 2000)
        );
        const dgResult = await Promise.race([dgReadPromise, dgTimeout]);
        if (dgResult.value) {
          dgTimings.received = performance.now();
          dgReceived = true;
          mark("datagram_received");
        } else {
          mark("datagram_timeout");
        }
        dgReader.releaseLock();
        dgWriter.releaseLock();
      } catch (e: any) {
        mark(`datagram_error(${e.message})`);
      }

      // Step 6: Close
      readDone = true;
      wt.close();
      mark("connection_closed");

      return {
        success: true,
        timings,
        messages,
        datagramRoundTrip: dgReceived ? dgTimings.received - dgTimings.sent : null,
        totalTime: timings[timings.length - 1].ts - timings[0].ts,
      };

    } catch (e: any) {
      mark(`error(${e.message})`);
      return {
        success: false,
        error: e.message,
        timings,
        messages: [],
        datagramRoundTrip: null,
        totalTime: timings.length > 1 ? timings[timings.length - 1].ts - timings[0].ts : 0,
      };
    }
  }, certHashHex, SERVER_WT);

  await browser.close();
  return result;
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  try {
    await startServer();

    console.log("=== Running Browser Timing Test ===\n");
    const result = await runBrowserTest();

    console.log("\n=== Browser Timing Results ===\n");

    if (result.timings) {
      const t0 = result.timings[0].ts;
      for (const t of result.timings) {
        const total = (t.ts - t0).toFixed(1);
        const delta = t.delta.toFixed(1);
        console.log(`  +${total.padStart(8)}ms (delta ${delta.padStart(7)}ms) ${t.label}`);
      }
    }

    console.log(`\n  Success: ${result.success}`);
    if (result.datagramRoundTrip !== null) {
      console.log(`  Datagram RTT: ${result.datagramRoundTrip.toFixed(1)}ms`);
    }
    console.log(`  Total test time: ${result.totalTime.toFixed(1)}ms`);
    console.log(`  Messages received: ${result.messages?.length || 0}`);

    if (!result.success) {
      console.error(`\n  ERROR: ${result.error}`);
    }

    // Analyze for bottleneck
    if (result.timings && result.timings.length > 1) {
      console.log("\n=== Bottleneck Analysis ===\n");
      const sorted = [...result.timings].sort((a, b) => b.delta - a.delta);
      for (const t of sorted.slice(0, 5)) {
        if (t.delta > 10) {
          console.log(`  SLOW: ${t.label} took ${t.delta.toFixed(1)}ms`);
        }
      }

      // Check specific phases
      const find = (label: string) => result.timings.find((t: any) => t.label.startsWith(label));
      const wtReady = find("wt_ready");
      const firstMsg = find("msg_received_1");
      const bidiCreated = find("bidi_stream_created");

      if (wtReady && wtReady.delta > 100) {
        console.log(`\n  ** WebTransport .ready took ${wtReady.delta.toFixed(0)}ms — possible QUIC handshake delay`);
      }
      if (bidiCreated && bidiCreated.delta > 100) {
        console.log(`\n  ** createBidirectionalStream() took ${bidiCreated.delta.toFixed(0)}ms — possible stream creation delay`);
      }
      if (firstMsg && firstMsg.delta > 100) {
        console.log(`\n  ** First message took ${firstMsg.delta.toFixed(0)}ms after stream creation — possible send/flush delay`);
      }
    }

  } finally {
    await stopServer();
  }
}

main().catch((err) => {
  console.error(err);
  stopServer();
  process.exit(1);
});
