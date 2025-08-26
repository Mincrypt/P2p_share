// client/app.js — updated with verbose logging and explicit WSS fallback
const RENDER_WS_URL = "wss://YOUR_RENDER_APP.onrender.com/ws"; // <- REPLACE with your Render service URL

const els = {
  fileInput: document.getElementById("fileInput"),
  dropzone: document.getElementById("dropzone"),
  password: document.getElementById("password"),
  createLink: document.getElementById("createLink"),
  shareBox: document.getElementById("shareBox"),
  shareLink: document.getElementById("shareLink"),
  copyBtn: document.getElementById("copyBtn"),
  roomInput: document.getElementById("roomInput"),
  joinBtn: document.getElementById("joinBtn"),
  passwordPrompt: document.getElementById("passwordPrompt"),
  passwordInput: document.getElementById("passwordInput"),
  unlockBtn: document.getElementById("unlockBtn"),
  senderStatus: document.getElementById("senderStatus"),
  receiverStatus: document.getElementById("receiverStatus"),
  sendBar: document.getElementById("sendBar"),
  recvBar: document.getElementById("recvBar"),
};

let ws;
let pc;
let dc;
let isSender = false;
let fileToSend = null;
let fileMeta = null;
let expectedPasswordHash = null;
let unlocked = false;

const CHUNK_SIZE = 64 * 1024; // 64KB
let receivedSize = 0;
let receivedBuffers = [];

// sha256 helper
async function sha256(str) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Choose WS URL: same origin first, fallback to Render explicit URL
function getWsUrl() {
  try {
    // If client + server share same origin (host), this will work
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const candidate = `${proto}//${location.host}/ws`;
    // If page and WS are served from same Render service, candidate is correct.
    // But when in doubt, use explicit Render URL defined above.
    return candidate;
  } catch (e) {
    return RENDER_WS_URL;
  }
}

// Connect (with verbose logs)
function connectWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const chosen = getWsUrl();
  console.log("[WS] connecting to", chosen);
  ws = new WebSocket(chosen);

  ws.onopen = () => {
    console.log("[WS] open");
    // optional ping to confirm connectivity
    try { ws.send(JSON.stringify({ type: "ping", ts: Date.now() })); } catch(e){}
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { console.warn("[WS] non-json", ev.data); return; }
    console.log("[WS] recv", msg);

    if (msg.type === "created") {
      const url = new URL(location.href);
      url.searchParams.set("room", msg.roomId);
      els.shareLink.value = url.toString();
      els.shareBox.classList.remove("hidden");
      els.senderStatus.textContent = "Room created. Waiting for peer...";
    } else if (msg.type === "joined") {
      els.receiverStatus.textContent = "Joined room. Establishing connection...";
    } else if (msg.type === "peer-joined") {
      // remote joined -> sender should create offer
      if (isSender) {
        console.log("[WS] peer-joined -> makeOffer()");
        makeOffer();
      }
    } else if (msg.type === "peer-left") {
      els.receiverStatus.textContent = "Peer left. You can close this page.";
      els.senderStatus.textContent = "Peer left.";
    } else if (msg.type === "signal") {
      handleSignal(msg.payload);
    } else if (msg.type === "error") {
      console.error("[WS] server error:", msg.error);
      alert(msg.error || "Signaling error");
    }
  };

  ws.onclose = (e) => { console.log("[WS] closed", e); };
  ws.onerror = (e) => { console.error("[WS] error", e); };
}

// send signal wrapper with logging
function sendSignal(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn("[WS] cannot send, ws not open", payload);
    return;
  }
  const msg = { type: "signal", payload, roomId: currentRoom() };
  console.log("[WS] send", msg);
  ws.send(JSON.stringify(msg));
}

function currentRoom() {
  const u = new URL(location.href);
  return u.searchParams.get("room") || els.roomInput.value.trim();
}

function createOrJoinRoom({ create = false } = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    // wait for open then retry
    connectWS();
    ws.onopen = () => createOrJoinRoom({ create });
    return;
  }
  if (create) ws.send(JSON.stringify({ type: "create" }));
  else {
    const room = currentRoom();
    if (!room) return alert("Enter Room ID");
    ws.send(JSON.stringify({ type: "join", roomId: room }));
  }
}

// RTCPeerConnection + ICE logging
function setupPeer() {
  pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" }
      // add TURN here if you have one
    ]
  });

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      console.log("[PC] local ICE candidate", ev.candidate);
      sendSignal({ candidate: ev.candidate });
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log("[PC] iceConnectionState", pc.iceConnectionState);
    els.senderStatus.textContent = `ICE: ${pc.iceConnectionState}`;
    els.receiverStatus.textContent = `ICE: ${pc.iceConnectionState}`;
  };

  pc.onconnectionstatechange = () => {
    console.log("[PC] connectionState", pc.connectionState);
    if (pc.connectionState === "connected") {
      console.log("[PC] connected — datachannel should open soon");
    }
  };

  pc.ondatachannel = (ev) => {
    console.log("[PC] ondatachannel", ev.channel.label);
    dc = ev.channel;
    wireDataChannel();
  };
}

function wireDataChannel() {
  dc.binaryType = "arraybuffer";
  dc.onopen = () => {
    console.log("[DC] open");
    if (isSender) {
      els.senderStatus.textContent = "Connected. Sending file...";
      dc.send(JSON.stringify({ kind: "meta", name: fileToSend.name, size: fileToSend.size, type: fileToSend.type, pw: expectedPasswordHash }));
      sendFile();
    } else {
      els.receiverStatus.textContent = "Connected. Waiting for file metadata...";
    }
  };

  dc.onmessage = async (ev) => {
    // same logic as before — we'll keep simple
    if (typeof ev.data === "string") {
      try {
        const obj = JSON.parse(ev.data);
        console.log("[DC] meta/msg", obj);
        // handle meta/unlock/done as before...
        if (obj.kind === "meta") {
          fileMeta = obj;
          receivedSize = 0;
          receivedBuffers = [];
          if (obj.pw) {
            els.passwordPrompt.classList.remove("hidden");
            els.receiverStatus.textContent = "Password required to start the download.";
          } else {
            unlocked = true;
            dc.send(JSON.stringify({ kind: "unlock", ok: true }));
            els.receiverStatus.textContent = "Receiving file...";
          }
        } else if (obj.kind === "unlock") {
          if (!obj.ok) els.senderStatus.textContent = "Receiver provided wrong password.";
          else els.senderStatus.textContent = "Receiver unlocked. Sending data...";
        } else if (obj.kind === "done") {
          const blob = new Blob(receivedBuffers, { type: fileMeta?.type || "application/octet-stream" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = fileMeta?.name || "download";
          a.click();
          URL.revokeObjectURL(url);
          els.receiverStatus.textContent = "Download complete.";
        }
      } catch (e) { console.warn("[DC] parse failed", e); }
      return;
    }
    // binary chunk
    receivedBuffers.push(ev.data);
    receivedSize += ev.data.byteLength;
    const pct = Math.min(100, Math.floor((receivedSize / (fileMeta?.size || 1)) * 100));
    els.recvBar.style.width = pct + "%";
    els.receiverStatus.textContent = `Receiving: ${pct}%`;
  };

  dc.onclose = () => console.log("[DC] closed");
  dc.onerror = (e) => console.error("[DC] error", e);
}

async function makeOffer() {
  setupPeer();
  dc = pc.createDataChannel("file");
  wireDataChannel();

  console.log("[PC] creating offer");
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal({ sdp: pc.localDescription });
}

async function handleSignal(payload) {
  try {
    console.log("[signal] incoming payload", payload?.type || payload);
    if (payload.sdp) {
      if (!pc) setupPeer();
      await pc.setRemoteDescription(payload.sdp);
      console.log("[PC] set remote SDP:", payload.sdp.type);
      if (payload.sdp.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal({ sdp: pc.localDescription });
      }
    } else if (payload.candidate) {
      console.log("[PC] addIceCandidate (remote)", payload.candidate);
      try { await pc.addIceCandidate(payload.candidate); } catch (e) { console.warn("addIce failed", e); }
    }
  } catch (e) {
    console.error("handleSignal error", e);
  }
}

// sendFile() and UI handlers kept the same as your current code (unchanged)
... // (paste your existing sendFile and UI wiring code here, unchanged)

// Send file in chunks with backpressure control
async function sendFile() {
  const file = fileToSend;
  if (!file || !dc) return;

  // If password set, wait for unlock
  if (expectedPasswordHash) {
    els.senderStatus.textContent = "Waiting for receiver to enter password...";
    const unlockOK = await new Promise((resolve) => {
      function onMessage(ev) {
        try {
          const obj = JSON.parse(typeof ev.data === "string" ? ev.data : "");
          if (obj.kind === "unlock") {
            dc.removeEventListener("message", onMessage);
            resolve(!!obj.ok);
          }
        } catch (e) {}
      }
      dc.addEventListener("message", onMessage);
    });
    if (!unlockOK) {
      els.senderStatus.textContent = "Receiver failed to unlock.";
      return;
    }
  }

  const reader = file.stream().getReader();
  let sent = 0;
  function updateProgress() {
    const pct = Math.min(100, Math.floor((sent / file.size) * 100));
    els.sendBar.style.width = pct + "%";
    els.senderStatus.textContent = `Sending: ${pct}%`;
  }

  const sendChunk = (chunk) => {
    return new Promise((resolve) => {
      const trySend = () => {
        if (dc.bufferedAmount > 8 * 1024 * 1024) {
          setTimeout(trySend, 20);
          return;
        }
        dc.send(chunk);
        resolve();
      };
      trySend();
    });
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value.byteLength > CHUNK_SIZE) {
      for (let offset = 0; offset < value.byteLength; offset += CHUNK_SIZE) {
        await sendChunk(value.slice(offset, offset + CHUNK_SIZE));
        sent += Math.min(CHUNK_SIZE, value.byteLength - offset);
        updateProgress();
      }
    } else {
      await sendChunk(value);
      sent += value.byteLength;
      updateProgress();
    }
  }
  dc.send(JSON.stringify({ kind: "done" }));
  els.senderStatus.textContent = "File sent. You can close this tab.";
}

// UI wiring
els.dropzone.addEventListener("click", () => els.fileInput.click());
els.dropzone.addEventListener("dragover", (e) => { e.preventDefault(); });
els.dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer.files?.length) {
    fileToSend = e.dataTransfer.files[0];
    els.dropzone.querySelector("p").textContent = fileToSend.name;
  }
});
els.fileInput.addEventListener("change", () => {
  if (els.fileInput.files?.length) {
    fileToSend = els.fileInput.files[0];
    els.dropzone.querySelector("p").textContent = fileToSend.name;
  }
});

els.createLink.addEventListener("click", async () => {
  if (!fileToSend) return alert("Please choose a file first.");
  isSender = true;
  expectedPasswordHash = els.password.value ? await sha256(els.password.value) : null;
  connectWS();
  createOrJoinRoom({ create: true });
});

els.copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(els.shareLink.value);
    els.copyBtn.textContent = "Copied";
    setTimeout(() => (els.copyBtn.textContent = "Copy"), 1200);
  } catch (e) { alert("Copy failed"); }
});

els.joinBtn.addEventListener("click", () => {
  isSender = false;
  connectWS();
  createOrJoinRoom({ create: false });
});

els.unlockBtn.addEventListener("click", async () => {
  if (!fileMeta) return;
  const given = els.passwordInput.value;
  const hash = await sha256(given);
  if (hash === fileMeta.pw) {
    unlocked = true;
    dc.send(JSON.stringify({ kind: "unlock", ok: true }));
    els.passwordPrompt.classList.add("hidden");
    els.receiverStatus.textContent = "Receiving file...";
  } else {
    dc.send(JSON.stringify({ kind: "unlock", ok: false }));
    alert("Wrong password");
  }
});

// auto-fill room if ?room= in URL
const url = new URL(location.href);
if (url.searchParams.get("room")) {
  els.roomInput.value = url.searchParams.get("room");
}
