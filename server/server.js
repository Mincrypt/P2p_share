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

// Serve client
const clientPath = path.join(__dirname, "..", "client");
app.use(express.static(clientPath));

// Simple in-memory rooms map: roomId -> Set(ws)
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

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // create room
    if (msg.type === "create") {
      const roomId = nanoid(10);
      joinRoom(ws, roomId);
      ws.send(JSON.stringify({ type: "created", roomId }));
      return;
    }

    // join existing room
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

    // relay signaling payload to other peers in the same room
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
    const roomId = ws.roomId;
    leaveRoom(ws);
    if (roomId && rooms.has(roomId)) {
      for (const peer of rooms.get(roomId)) {
        try { peer.send(JSON.stringify({ type: "peer-left" })); } catch {}
      }
    }
  });

  ws.on("error", () => leaveRoom(ws));
});

// fallback to index.html
app.get("*", (_, res) => {
  res.sendFile(path.join(clientPath, "index.html"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`P2P Share running at http://localhost:${PORT}`);
});
