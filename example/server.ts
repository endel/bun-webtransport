import { WebTransportServer } from "bun-webtransport";
import { World, type SpatialItem } from "./game/World";
import { Block } from "./game/Block";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { Encoder, Reflection } from "@colyseus/schema";
import { BattleState, TankState, BulletState, PickableState, TeamState, } from "./schema/BattleState";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Protocol constants ───────────────────────────────────────
const MSG_INPUT = 0x01;

// ── Level data ───────────────────────────────────────────────
const LEVEL = [
  [13.5, 2, 1, 4], [13.5, 12, 1, 2], [12.5, 13.5, 3, 1], [2, 13.5, 4, 1],
  [11.5, 15, 1, 2], [11.5, 23.5, 1, 5],
  [10, 26.5, 4, 1], [6, 26.5, 4, 1],
  [2, 34.5, 4, 1], [12.5, 34.5, 3, 1], [13.5, 36, 1, 2], [15, 36.5, 2, 1],
  [13.5, 46, 1, 4],
  [23.5, 36.5, 5, 1], [26.5, 38, 1, 4], [26.5, 42, 1, 4],
  [34.5, 46, 1, 4], [34.5, 36, 1, 2], [35.5, 34.5, 3, 1], [36.5, 33, 1, 2],
  [46, 34.5, 4, 1],
  [36.5, 24.5, 1, 5], [38, 21.5, 4, 1], [42, 21.5, 4, 1],
  [46, 13.5, 4, 1], [35.5, 13.5, 3, 1], [34.5, 12, 1, 2], [33, 11.5, 2, 1],
  [34.5, 2, 1, 4],
  [24.5, 11.5, 5, 1], [21.5, 10, 1, 4], [21.5, 6, 1, 4],
  // center
  [18.5, 22, 1, 6], [19, 18.5, 2, 1], [26, 18.5, 6, 1], [29.5, 19, 1, 2],
  [29.5, 26, 1, 6], [29, 29.5, 2, 1], [22, 29.5, 6, 1], [18.5, 29, 1, 2],
];

const PICKABLE_SPAWNS = [
  { x: 23.5, y: 9.5, type: "repair", delay: 5000 },
  { x: 38.5, y: 23.5, type: "repair", delay: 5000 },
  { x: 24.5, y: 38.5, type: "repair", delay: 5000 },
  { x: 9.5, y: 24.5, type: "repair", delay: 5000 },
  { x: 13.5, y: 15.5, type: "damage", delay: 10000 },
  { x: 32.5, y: 13.5, type: "damage", delay: 10000 },
  { x: 34.5, y: 32.5, type: "damage", delay: 10000 },
  { x: 15.5, y: 34.5, type: "damage", delay: 10000 },
  { x: 24, y: 24, type: "shield", delay: 30000 },
];

// ── Game constants ───────────────────────────────────────────
const TANK_SPEED = 0.3;
const TANK_RANGE = 16;
const TANK_RADIUS = 0.75;
const BULLET_SPEED = 0.7;
const BULLET_RADIUS = 0.25;
const BULLET_DAMAGE = 3;
const PICKABLE_RADIUS = 0.3;
const RESPAWN_TIME = 5000;
const INVULN_TIME = 2000;
const RELOAD_TIME = 400;
const RECOVERY_DELAY = 3000;
const RECOVERY_INTERVAL = 1000;
const WIN_SCORE = 10;

// ── Internal data types (game simulation, not synced) ────────
interface TankData extends SpatialItem {
  sessionId: string;
  teamId: number;
  angle: number;
  dirX: number;
  dirY: number;
  shooting: boolean;
  reloading: boolean;
  lastShot: number;
  tHit: number;
  tRecover: number;
  ammo: number;
  hp: number;
  shield: number;
  score: number;
  dead: boolean;
  died: number;
  respawned: number;
  deleted: boolean;
  killer: string;
}

interface BulletData extends SpatialItem {
  id: string;
  ownerSid: string;
  owner: TankData;
  tx: number;
  ty: number;
  speed: number;
  damage: number;
  special: boolean;
  hit: boolean;
}

interface PickData extends SpatialItem {
  id: string;
  type: string;
  ind: number;
}

interface PickSpawn {
  x: number;
  y: number;
  type: string;
  delay: number;
  picked: number;
  activeId: string | null;
}

interface Player {
  sessionId: string;
  clientId: bigint;
  wtSessionId: bigint;
  streamId: bigint;
  tank: TankData;
}

// ── Schema state + Encoder ───────────────────────────────────
const state = new BattleState();
const encoder = new Encoder(state);

// 4 teams
for (let i = 0; i < 4; i++) {
  state.teams.push(new TeamState());
}

// ── Game state ───────────────────────────────────────────────
const players = new Map<bigint, Player>();
const tankData = new Map<string, TankData>();
const bulletData = new Map<string, BulletData>();
const pickItems = new Map<string, PickData>();
const blocks: Block[] = [];
let bulletCounter = 0;
let pickCounter = 0;
let nextPlayerId = 0;

// Spatial world
const world = new World(48, 48, 4, ["tank", "bullet", "pickable", "block"]);

// Initialize blocks
for (const [bx, by, bw, bh] of LEVEL) {
  const block = new Block(bx, by, bw, bh);
  blocks.push(block);
  world.add("block", block);
}

// Initialize pickable spawn points
const pickSpawns: PickSpawn[] = PICKABLE_SPAWNS.map((s) => ({
  ...s,
  picked: 0,
  activeId: null,
}));

// ── Helpers ──────────────────────────────────────────────────
function pickWeakestTeam(): number {
  let candidates = state.teams
    .map((t, i) => ({ id: i, tanks: t.tanks, score: t.score }))
    .filter((t) => t.tanks < 4);

  if (candidates.length === 0) {
    candidates = state.teams.map((t, i) => ({
      id: i, tanks: t.tanks, score: t.score,
    }));
  }

  candidates.sort((a, b) => a.tanks - b.tanks || a.score - b.score);
  const best = candidates.filter(
    (c) => c.tanks === candidates[0].tanks && c.score === candidates[0].score
  );
  return best[Math.floor(Math.random() * best.length)].id;
}

function spawnPosition(tank: TankData) {
  tank.x = 2.5 + (tank.teamId % 2) * 35 + Math.floor(Math.random() * 9);
  tank.y = 2.5 + Math.floor(tank.teamId / 2) * 35 + Math.floor(Math.random() * 9);
}

function syncTank(tank: TankData) {
  const s = state.tanks.get(tank.sessionId);
  if (!s) return;
  s.x = parseFloat(tank.x.toFixed(3));
  s.y = parseFloat(tank.y.toFixed(3));
  s.angle = Math.floor(tank.angle);
  s.hp = tank.hp;
  s.shield = tank.shield;
  s.dead = tank.dead;
  s.score = tank.score;
  s.killer = tank.killer;
}

// ── Stream framing helpers ───────────────────────────────────
function sendFramed(clientId: bigint, streamId: bigint, data: Uint8Array) {
  const frame = new Uint8Array(4 + data.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, data.length, true);
  frame.set(data, 4);
  server.sendStream(clientId, streamId, frame);
}

function addPlayer(clientId: bigint, wtSessionId: bigint) {
  const sessionId = `p${nextPlayerId++}`;
  const teamId = pickWeakestTeam();
  state.teams[teamId].tanks++;

  // Schema
  const schema = new TankState();
  schema.team = teamId;
  schema.dead = true;
  state.tanks.set(sessionId, schema);

  // Internal
  const tank: TankData = {
    sessionId,
    teamId,
    x: 0, y: 0,
    radius: TANK_RADIUS,
    angle: Math.random() * 360,
    dirX: 0, dirY: 0,
    shooting: false,
    reloading: false,
    lastShot: 0,
    tHit: 0,
    tRecover: 0,
    ammo: 0,
    hp: 10,
    shield: 0,
    score: 0,
    dead: true,
    died: Date.now(),
    respawned: Date.now(),
    deleted: false,
    killer: "",
    node: null,
  };
  spawnPosition(tank);
  tankData.set(sessionId, tank);
  world.add("tank", tank);
  syncTank(tank);

  // Player created without stream — stream assigned when client opens bidi stream
  const player: Player = { sessionId, clientId, wtSessionId, streamId: 0n, tank };
  players.set(clientId, player);

  console.log(`[join] ${sessionId} team=${teamId} (${players.size} connected)`);
}

function onPlayerStream(clientId: bigint, streamId: bigint) {
  const player = players.get(clientId);
  if (!player || player.streamId !== 0n) return; // already has stream
  player.streamId = streamId;

  try {
    const sidBytes = new TextEncoder().encode(player.sessionId);
    const reflection = new Uint8Array(Reflection.encode(encoder));
    const fullState = new Uint8Array(encoder.encodeAll());
    sendFramed(clientId, streamId, sidBytes);
    sendFramed(clientId, streamId, reflection);
    sendFramed(clientId, streamId, fullState);
    console.log(`[stream] ${player.sessionId} initial state sent (${sidBytes.length}+${reflection.length}+${fullState.length} bytes)`);
  } catch (e) {
    console.error(`[error] Failed to send initial state to ${player.sessionId}`, e);
  }
}

function removePlayer(clientId: bigint) {
  const player = players.get(clientId);
  if (!player) return;
  const tank = player.tank;
  state.teams[tank.teamId].tanks--;
  world.remove("tank", tank);
  tank.deleted = true;
  tankData.delete(player.sessionId);
  state.tanks.delete(player.sessionId);
  players.delete(clientId);
  console.log(`[leave] ${player.sessionId} (${players.size} connected)`);
}

function createBullet(tank: TankData) {
  tank.tHit = Date.now();
  tank.reloading = true;
  tank.lastShot = Date.now();

  const rad = (-tank.angle + 90) * (Math.PI / 180);
  const bx = parseFloat(tank.x.toFixed(3));
  const by = parseFloat(tank.y.toFixed(3));
  const tx = parseFloat((Math.cos(rad) * TANK_RANGE + bx).toFixed(3));
  const ty = parseFloat((Math.sin(rad) * TANK_RANGE + by).toFixed(3));

  let speed = BULLET_SPEED;
  let damage = BULLET_DAMAGE;
  let special = false;

  if (tank.ammo > 0) {
    tank.ammo--;
    special = true;
    damage += 2;
    speed += 0.2;
  }

  const id = `b${++bulletCounter}`;
  const bullet: BulletData = {
    id,
    ownerSid: tank.sessionId,
    owner: tank,
    x: bx, y: by,
    tx, ty,
    speed, damage,
    radius: BULLET_RADIUS,
    special,
    hit: false,
    node: null,
  };

  bulletData.set(id, bullet);
  world.add("bullet", bullet);

  const bs = new BulletState();
  bs.owner = tank.sessionId;
  bs.x = bx;
  bs.y = by;
  bs.tx = tx;
  bs.ty = ty;
  bs.speed = speed;
  bs.special = special;
  state.bullets.set(id, bs);
}

// ── Update loop ──────────────────────────────────────────────
function update() {
  const now = Date.now();
  let winner: number | null = null;

  // ── Tanks ──
  for (const [sid, tank] of tankData) {
    if (tank.deleted) continue;

    if (!tank.dead) {
      // Movement
      const len = Math.sqrt(tank.dirX * tank.dirX + tank.dirY * tank.dirY);
      if (len > 0) {
        tank.x += (tank.dirX / len) * TANK_SPEED;
        tank.y += (tank.dirY / len) * TANK_SPEED;
      }

      // Reloading
      if (tank.reloading && now - tank.lastShot > RELOAD_TIME) {
        tank.reloading = false;
      }

      // Auto recovery
      if (
        tank.hp < 10 &&
        now - tank.tHit > RECOVERY_DELAY &&
        now - tank.tRecover > RECOVERY_INTERVAL
      ) {
        tank.hp = Math.min(tank.hp + 1, 10);
        tank.tRecover = now;
      }

      // Tank-tank collision
      world.forEachAround("tank", tank, (other: TankData) => {
        if (other.dead) return;
        const dx = tank.x - other.x;
        const dy = tank.y - other.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 0 && dist < TANK_RADIUS * 2) {
          const nx = dx / dist;
          const ny = dy / dist;
          const overlap = TANK_RADIUS * 2 - dist;
          tank.x += nx * overlap;
          tank.y += ny * overlap;
          other.x -= nx * overlap;
          other.y -= ny * overlap;
        }
      });

      // Tank-block collision
      world.forEachAround("block", tank, (block: Block) => {
        const pt = block.collideCircle(tank.x, tank.y, TANK_RADIUS);
        if (pt) {
          tank.x += pt.x;
          tank.y += pt.y;
        }
      }, null);

      // Tank-pickable collision
      world.forEachAround("pickable", tank, (pick: PickData) => {
        const dx = tank.x - pick.x;
        const dy = tank.y - pick.y;
        if (Math.sqrt(dx * dx + dy * dy) > TANK_RADIUS + PICKABLE_RADIUS) return;

        switch (pick.type) {
          case "repair":
            if (tank.hp >= 10) return;
            tank.hp = Math.min(10, tank.hp + 3);
            break;
          case "damage":
            tank.ammo += 3;
            break;
          case "shield":
            if (tank.shield >= 10) return;
            tank.shield = 10;
            break;
        }

        world.remove("pickable", pick);
        pickSpawns[pick.ind].picked = now;
        pickSpawns[pick.ind].activeId = null;
        pickItems.delete(pick.id);
        state.pickables.delete(pick.id);
      }, null);
    } else {
      // Dead — respawn after delay
      if (now - tank.died > RESPAWN_TIME) {
        tank.dead = false;
        tank.hp = 10;
        tank.shield = 0;
        tank.ammo = 0;
        tank.respawned = now;
        spawnPosition(tank);
      }
    }

    // Update spatial index
    world.updateItem("tank", tank);

    // Shoot
    if (!tank.dead && tank.shooting && !tank.reloading) {
      createBullet(tank);
    }

    // Sync to schema
    syncTank(tank);
  }

  // ── Respawn pickables ──
  for (let i = 0; i < pickSpawns.length; i++) {
    const spawn = pickSpawns[i];
    if (!spawn.activeId && now - spawn.picked > spawn.delay) {
      const id = `p${++pickCounter}`;
      const pick: PickData = {
        id,
        type: spawn.type,
        x: spawn.x,
        y: spawn.y,
        radius: PICKABLE_RADIUS,
        ind: i,
        node: null,
      };
      pickItems.set(id, pick);
      world.add("pickable", pick);
      spawn.activeId = id;

      const ps = new PickableState();
      ps.type = spawn.type;
      ps.x = spawn.x;
      ps.y = spawn.y;
      state.pickables.set(id, ps);
    }
  }

  // ── Bullets ──
  const bulletsToRemove: string[] = [];

  for (const [bid, bullet] of bulletData) {
    // Move toward target
    const dx = bullet.tx - bullet.x;
    const dy = bullet.ty - bullet.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 0) {
      bullet.x += (dx / dist) * bullet.speed;
      bullet.y += (dy / dist) * bullet.speed;
    }

    let deleting = false;

    const distToTarget = Math.sqrt(
      (bullet.x - bullet.tx) ** 2 + (bullet.y - bullet.ty) ** 2
    );
    if (distToTarget < 1) {
      deleting = true;
    } else if (
      bullet.x <= 0 || bullet.y <= 0 ||
      bullet.x >= world.width || bullet.y >= world.height
    ) {
      deleting = true;
    } else {
      // Bullet-tank collision
      world.forEachAround("tank", bullet, (tank: TankData) => {
        if (
          deleting || tank.dead ||
          tank.sessionId === bullet.ownerSid ||
          tank.teamId === bullet.owner.teamId ||
          now - tank.respawned <= INVULN_TIME
        ) return;

        const tdx = tank.x - bullet.x;
        const tdy = tank.y - bullet.y;
        if (Math.sqrt(tdx * tdx + tdy * tdy) > TANK_RADIUS + BULLET_RADIUS) return;

        bullet.hit = true;

        if (!bullet.owner.deleted) {
          let damage = bullet.damage;
          tank.tHit = now;

          if (tank.shield > 0) {
            if (tank.shield >= damage) {
              tank.shield -= damage;
              damage = 0;
            } else {
              damage -= tank.shield;
              tank.shield = 0;
            }
          }

          if (damage > 0) {
            tank.hp -= damage;

            if (tank.hp <= 0) {
              bullet.owner.score++;
              state.teams[bullet.owner.teamId].score++;
              if (state.teams[bullet.owner.teamId].score >= WIN_SCORE) {
                winner = bullet.owner.teamId;
              }
              state.totalScore++;
              tank.killer = bullet.ownerSid;
              tank.dead = true;
              tank.died = now;
              tank.shooting = false;
            }
          }
        }

        deleting = true;
      }, null);

      // Bullet-block collision
      if (!deleting) {
        world.forEachAround("block", bullet, (block: Block) => {
          if (deleting) return;
          const pt = block.collideCircle(bullet.x, bullet.y, BULLET_RADIUS);
          if (pt) {
            bullet.x += pt.x;
            bullet.y += pt.y;
            deleting = true;
          }
        }, null);
      }
    }

    if (!deleting) {
      world.updateItem("bullet", bullet);
      // Sync bullet position to schema
      const bs = state.bullets.get(bid);
      if (bs) {
        bs.x = parseFloat(bullet.x.toFixed(2));
        bs.y = parseFloat(bullet.y.toFixed(2));
      }
    } else {
      bulletsToRemove.push(bid);
    }
  }

  for (const bid of bulletsToRemove) {
    const bullet = bulletData.get(bid);
    if (bullet) {
      world.remove("bullet", bullet);
      bulletData.delete(bid);
      state.bullets.delete(bid);
    }
  }

  // ── Winner? ──
  if (winner !== null) {
    state.winnerTeam = winner;

    for (let i = 0; i < 4; i++) state.teams[i].score = 0;
    for (const [, tank] of tankData) {
      tank.score = 0;
      tank.killer = "";
      if (!tank.dead) {
        tank.dead = true;
        tank.died = now;
        tank.shooting = false;
      }
    }
    state.totalScore = 0;

    setTimeout(() => { state.winnerTeam = -1; }, 3000);
  }

  // ── Broadcast state patches ──
  if (encoder.hasChanges && players.size > 0) {
    const patches = encoder.encode();
    if (patches.byteLength > 0) {
      for (const player of players.values()) {
        if (player.streamId === 0n) continue; // no stream yet
        try {
          sendFramed(player.clientId, player.streamId, patches);
        } catch {
          // Connection may have closed
        }
      }
    }
    encoder.discardChanges();
  }
}

// ── Parse client input ───────────────────────────────────────
function handleInput(player: Player, data: Uint8Array) {
  if (data.length < 6 || data[0] !== MSG_INPUT) return;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tank = player.tank;
  if (tank.deleted) return;

  const flags = view.getUint8(1);
  tank.shooting = !tank.dead && (flags & 1) !== 0;
  tank.dirX = view.getInt8(2);
  tank.dirY = view.getInt8(3);
  const angleDeg = view.getUint16(4, true) / 100;
  tank.angle = angleDeg;
  // Sync angle immediately to schema for other clients
  const s = state.tanks.get(player.sessionId);
  if (s) s.angle = angleDeg;
}

// ── Compute cert hash for browser ────────────────────────────
const certPath = process.env.CERT_PATH || resolve(__dirname, "certs/server.crt");
const keyPath = process.env.KEY_PATH || resolve(__dirname, "certs/server.key");

let certHashHex = "";
try {
  const pem = readFileSync(certPath, "utf8");
  const der = Buffer.from(
    pem.replace(/-----BEGIN CERTIFICATE-----/g, "")
      .replace(/-----END CERTIFICATE-----/g, "")
      .replace(/\n/g, ""),
    "base64"
  );
  certHashHex = createHash("sha256").update(der).digest("hex");
} catch {
  console.error("Certificate not found. Run: ./example/generate-certs.sh");
  process.exit(1);
}

// ── WebTransport server ──────────────────────────────────────
const WT_PORT = parseInt(process.env.WT_PORT || "4433", 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT || "3000", 10);

const server = new WebTransportServer({
  address: "0.0.0.0",
  port: WT_PORT,
  certPath,
  keyPath,
  handler: {
    onConnectRequest(clientId, sessionId, path) {
      console.log(`[connect] client=${clientId} session=${sessionId} path=${path}`);
      server.acceptSession(clientId, sessionId);
      addPlayer(clientId, sessionId);
    },

    onSessionReady() {},

    onBidiStream(clientId, _sessionId, streamId) {
      onPlayerStream(clientId, streamId);
    },

    onDatagram(clientId, _sessionId, data) {
      const player = players.get(clientId);
      if (player) handleInput(player, data);
    },

    onStreamData() {},

    onSessionClosed(clientId) {
      removePlayer(clientId);
    },

    onDisconnected(clientId) {
      removePlayer(clientId);
    },
  },
});

// ── HTTP server for cert hash + static files ─────────────────
Bun.serve({
  port: HTTP_PORT,
  async fetch(req: Request) {
    const url = new URL(req.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET",
    };

    if (url.pathname === "/cert-hash") {
      return new Response(certHashHex, {
        headers: { "Content-Type": "text/plain", ...corsHeaders },
      });
    }

    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(resolve(__dirname, `client/dist${filePath}`));
    if (await file.exists()) {
      return new Response(file, { headers: corsHeaders });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
});

// ── Game loop at 20 FPS ──────────────────────────────────────
setInterval(update, 1000 / 20);

console.log(`\nWebTransport server on https://0.0.0.0:${WT_PORT}`);
console.log(`HTTP server on http://localhost:${HTTP_PORT}`);
console.log(`Cert SHA-256: ${certHashHex}\n`);
console.log(`Players: 0 connected`);
