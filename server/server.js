import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

// Serve client files
const clientPath = path.join(__dirname, "..", "client");
app.use(express.static(clientPath));

const rooms = new Map();

const wss = new WebSocketServer({ server, path: "/ws" });

function joinRoom(ws, roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId).add(ws);
  ws.roomId = roomId;
}

function leaveRoom(ws) {
  const roomId = ws.roomId;
  if (!roomId) return;
  const set = rooms.get(roomId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) rooms.delete(roomId);
  }
  ws.roomId = undefined;
}

// --- Updated connection handler with logs ---
wss.on("connection", (ws, req) => {
  console.log("[WS-server] new connection from", req?.socket?.remoteAddress || "unknown");

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      console.log("[WS-server] non-json", raw.toString());
      return;
    }

    console.log("[WS-server] recv:", msg?.type || msg, "room:", msg?.roomId || "none");

    if (msg.type === "create") {
      const roomId = nanoid(10);
      joinRoom(ws, roomId);
      ws.send(JSON.stringify({ type: "created", roomId }));
      return;
    }

    if (msg.type === "join") {
      const roomId = msg.roomId;
      if (!roomId) {
        ws.send(JSON.stringify({ type: "error", error: "Missing roomId" }));
        return;
      }
      joinRoom(ws, roomId);
      for (const peer of rooms.get(roomId)) {
        if (peer !== ws) {
          try { peer.send(JSON.stringify({ type: "peer-joined" })); } catch {}
        }
      }
      ws.send(JSON.stringify({ type: "joined", roomId }));
      return;
    }

    if (msg.type === "signal") {
      const roomId = msg.roomId;
      const payload = msg.payload;
      const set = rooms.get(roomId);
      if (!set) return;
      for (const peer of set) {
        if (peer !== ws) {
          try { peer.send(JSON.stringify({ type: "signal", payload })); } catch {}
        }
      }
      return;
    }
  });

  ws.on("close", () => {
    console.log("[WS-server] connection closed");
    const roomId = ws.roomId;
    leaveRoom(ws);
    if (roomId && rooms.has(roomId)) {
      for (const peer of rooms.get(roomId)) {
        try { peer.send(JSON.stringify({ type: "peer-left" })); } catch {}
      }
    }
  });

  ws.on("error", (err) => console.log("[WS-server] ws error", err));
});

app.get("*", (_, res) => {
  res.sendFile(path.join(clientPath, "index.html"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`P2P Share running at http://localhost:${PORT}`);
});
