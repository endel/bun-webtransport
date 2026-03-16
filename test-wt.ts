import { WebTransportServer } from "./src/wt";

const server = new WebTransportServer({
  address: "127.0.0.1",
  port: 4433,
  certPath: "./quic-zig/interop/certs/server.crt",
  keyPath: "./quic-zig/interop/certs/server.key",
  handler: {
    onConnectRequest(clientId, sessionId, path) {
      console.log(`[connect] client=${clientId} session=${sessionId} path=${path}`);
      server.acceptSession(clientId, sessionId);
    },

    onSessionReady(clientId, sessionId) {
      console.log(`[ready] client=${clientId} session=${sessionId}`);
    },

    onStreamData(clientId, streamId, sessionId, data, fin) {
      const text = new TextDecoder().decode(data);
      console.log(`[stream] client=${clientId} stream=${streamId} session=${sessionId} fin=${fin} data="${text}"`);
      // Echo back
      server.sendStream(clientId, streamId, data);
    },

    onDatagram(clientId, sessionId, data) {
      const text = new TextDecoder().decode(data);
      console.log(`[datagram] client=${clientId} session=${sessionId} data="${text}"`);
      // Echo back
      server.sendDatagram(clientId, sessionId, data);
    },

    onSessionClosed(clientId, sessionId, errorCode, reason) {
      console.log(`[closed] client=${clientId} session=${sessionId} code=${errorCode} reason="${reason}"`);
    },

    onDisconnected(clientId) {
      console.log(`[disconnected] client=${clientId}`);
    },
  },
});

console.log(`WebTransport echo server running on 127.0.0.1:4433`);
console.log(`Connect with: cd quic-zig && zig-out/bin/wt-client --port 4433`);
console.log(`Press Ctrl+C to stop`);

process.on("SIGINT", () => {
  console.log("\nStopping...");
  server.stop();
  process.exit(0);
});
