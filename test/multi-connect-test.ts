/**
 * Multi-connection test: opens N concurrent WebTransport sessions to verify
 * the flush fix works under concurrent load and repeated connections.
 */
import puppeteer from "puppeteer-core";
import { spawn, type Subprocess } from "bun";

const SERVER_HTTP = "http://127.0.0.1:3001";
const SERVER_WT = "https://127.0.0.1:4434";
const NUM_CONNECTIONS = 5;

let serverProc: Subprocess | null = null;

async function startServer(): Promise<void> {
  console.log("[test] Starting timing server...");
  serverProc = spawn({
    cmd: ["bun", "run", "test/timing-server.ts"],
    cwd: import.meta.dir + "/..",
    stdout: "inherit",
    stderr: "inherit",
  });
  for (let i = 0; i < 50; i++) {
    try {
      const resp = await fetch(`${SERVER_HTTP}/cert-hash`);
      if (resp.ok) { console.log("[test] Server is ready.\n"); return; }
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("Server did not start within 5 seconds");
}

async function stopServer() {
  if (serverProc) { serverProc.kill(); serverProc = null; }
}

async function main() {
  try {
    await startServer();

    const certResp = await fetch(`${SERVER_HTTP}/cert-hash`);
    const certHashHex = (await certResp.text()).trim();

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
    page.on("console", (msg) => console.log(`[browser] ${msg.text()}`));

    await page.goto(`${SERVER_HTTP}/index.html`);

    // Run N sequential connections (each opens, receives msg, sends echo, closes)
    const results = await page.evaluate(async (certHashHex: string, serverWt: string, numConns: number) => {
      const allResults: any[] = [];

      for (let c = 0; c < numConns; c++) {
        const t0 = performance.now();
        const result: any = { connection: c + 1 };

        try {
          const hashBytes = new Uint8Array(certHashHex.length / 2);
          for (let i = 0; i < certHashHex.length; i += 2)
            hashBytes[i / 2] = parseInt(certHashHex.substring(i, i + 2), 16);

          const wt = new WebTransport(`${serverWt}/test`, {
            serverCertificateHashes: [{ algorithm: "sha-256", value: hashBytes.buffer }],
          });
          await wt.ready;
          result.readyMs = performance.now() - t0;

          const stream = await wt.createBidirectionalStream();
          result.streamMs = performance.now() - t0;

          // Read first framed message
          const reader = stream.readable.getReader();
          let buffer = new Uint8Array(0);
          let gotMessage = false;
          const readDeadline = performance.now() + 2000;

          while (!gotMessage && performance.now() < readDeadline) {
            const { value, done } = await Promise.race([
              reader.read(),
              new Promise<{value: undefined, done: true}>(r =>
                setTimeout(() => r({value: undefined, done: true}), readDeadline - performance.now()))
            ]);
            if (done && !value) break;
            if (done) break;

            const newBuf = new Uint8Array(buffer.length + value.length);
            newBuf.set(buffer);
            newBuf.set(value, buffer.length);
            buffer = newBuf;

            if (buffer.length >= 4) {
              const len = buffer[0] | (buffer[1] << 8) | (buffer[2] << 16) | (buffer[3] << 24);
              if (buffer.length >= 4 + len) {
                gotMessage = true;
                result.firstMsgMs = performance.now() - t0;
              }
            }
          }

          // Datagram round-trip
          const dgWriter = wt.datagrams.writable.getWriter();
          const dgReader = wt.datagrams.readable.getReader();
          const dgStart = performance.now();
          await dgWriter.write(new Uint8Array([0xDE, 0xAD]));
          const dgResult = await Promise.race([
            dgReader.read(),
            new Promise<{value: undefined, done: true}>(r =>
              setTimeout(() => r({value: undefined, done: true}), 2000))
          ]);
          result.dgRttMs = dgResult.value ? performance.now() - dgStart : -1;
          dgReader.releaseLock();
          dgWriter.releaseLock();

          result.totalMs = performance.now() - t0;
          result.success = gotMessage;
          wt.close();

        } catch (e: any) {
          result.error = e.message;
          result.success = false;
          result.totalMs = performance.now() - t0;
        }

        allResults.push(result);
      }

      return allResults;
    }, certHashHex, SERVER_WT, NUM_CONNECTIONS);

    await browser.close();

    console.log("\n=== Multi-Connection Results ===\n");
    console.log("  #  | ready(ms) | stream(ms) | 1st msg(ms) | dg RTT(ms) | total(ms) | ok");
    console.log("  ---+-----------+------------+-------------+------------+-----------+---");
    for (const r of results) {
      const rdy = (r.readyMs ?? -1).toFixed(1).padStart(9);
      const str = (r.streamMs ?? -1).toFixed(1).padStart(10);
      const msg = (r.firstMsgMs ?? -1).toFixed(1).padStart(11);
      const dg = (r.dgRttMs ?? -1).toFixed(1).padStart(10);
      const tot = (r.totalMs ?? -1).toFixed(1).padStart(9);
      console.log(`  ${String(r.connection).padStart(2)} | ${rdy} | ${str} | ${msg} | ${dg} | ${tot} | ${r.success ? "OK" : "FAIL"}`);
    }

    const allOk = results.every((r: any) => r.success);
    const avgReady = results.reduce((s: number, r: any) => s + (r.readyMs || 0), 0) / results.length;
    const avgMsg = results.reduce((s: number, r: any) => s + (r.firstMsgMs || 0), 0) / results.length;
    console.log(`\n  All passed: ${allOk}`);
    console.log(`  Avg ready: ${avgReady.toFixed(1)}ms`);
    console.log(`  Avg first msg: ${avgMsg.toFixed(1)}ms`);

    if (!allOk) process.exit(1);

  } finally {
    await stopServer();
  }
}

main().catch((err) => { console.error(err); stopServer(); process.exit(1); });
