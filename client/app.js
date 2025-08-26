// P2P file share client
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

// SHA-256 helper
async function sha256(str) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Connect to signaling server
function connectWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // old
  // ws = new WebSocket(`${proto}//${location.host}/ws`);
  const socket = new WebSocket("wss://https://p2p-share-wlm8.onrender.com/ws");

  ws.onopen = () => console.log("WS open");
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "created") {
      const url = new URL(location.href);
      url.searchParams.set("room", msg.roomId);
      els.shareLink.value = url.toString();
      els.shareBox.classList.remove("hidden");
      els.senderStatus.textContent = "Room created. Waiting for peer...";
    }
    if (msg.type === "joined") {
      els.receiverStatus.textContent = "Joined room. Establishing connection...";
    }
    if (msg.type === "peer-joined") {
      if (isSender) makeOffer();
    }
    if (msg.type === "peer-left") {
      els.receiverStatus.textContent = "Peer left. You can close this page.";
      els.senderStatus.textContent = "Peer left.";
    }
    if (msg.type === "signal") {
      handleSignal(msg.payload);
    }
    if (msg.type === "error") {
      alert(msg.error || "Signaling error");
    }
  };

  ws.onclose = () => console.log("WS closed");
  ws.onerror = (e) => console.error("WS error", e);
}

function sendSignal(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn("WebSocket not open - cannot send signal");
    return;
  }
  ws.send(JSON.stringify({ type: "signal", payload, roomId: currentRoom() }));
}

function currentRoom() {
  const url = new URL(location.href);
  return url.searchParams.get("room") || els.roomInput.value.trim();
}

function createOrJoinRoom({ create = false } = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    ws.onopen = () => createOrJoinRoom({ create });
    connectWS();
    return;
  }
  if (create) {
    ws.send(JSON.stringify({ type: "create" }));
  } else {
    const roomId = currentRoom();
    if (!roomId) return alert("Enter Room ID");
    ws.send(JSON.stringify({ type: "join", roomId }));
  }
}

// Create RTCPeerConnection with STUN servers
function setupPeer() {
  pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" }
    ]
  });

  pc.onicecandidate = (ev) => {
    if (ev.candidate) sendSignal({ candidate: ev.candidate });
  };

  pc.onconnectionstatechange = () => {
    console.log("Connection state:", pc.connectionState);
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      els.receiverStatus.textContent = "Connection failed or disconnected";
      els.senderStatus.textContent = "Connection failed or disconnected";
    }
  };

  pc.ondatachannel = (ev) => {
    dc = ev.channel;
    wireDataChannel();
  };
}

function wireDataChannel() {
  dc.binaryType = "arraybuffer";

  dc.onopen = () => {
    if (isSender) {
      els.senderStatus.textContent = "Connected. Sending file...";
      dc.send(JSON.stringify({ kind: "meta", name: fileToSend.name, size: fileToSend.size, type: fileToSend.type, pw: expectedPasswordHash }));
      sendFile();
    } else {
      els.receiverStatus.textContent = "Connected. Waiting for file metadata...";
    }
  };

  dc.onmessage = async (ev) => {
    if (typeof ev.data === "string") {
      try {
        const obj = JSON.parse(ev.data);
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
          return;
        }
        if (obj.kind === "unlock") {
          if (!obj.ok) {
            els.senderStatus.textContent = "Receiver provided wrong password.";
            return;
          } else {
            els.senderStatus.textContent = "Receiver unlocked. Sending data...";
          }
          return;
        }
        if (obj.kind === "done") {
          const blob = new Blob(receivedBuffers, { type: fileMeta?.type || "application/octet-stream" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = fileMeta?.name || "download";
          a.click();
          URL.revokeObjectURL(url);
          els.receiverStatus.textContent = "Download complete.";
          return;
        }
      } catch (e) { console.warn(e); }
      return;
    }

    // Binary chunk
    receivedBuffers.push(ev.data);
    receivedSize += ev.data.byteLength;
    const pct = Math.min(100, Math.floor((receivedSize / (fileMeta?.size || 1)) * 100));
    els.recvBar.style.width = pct + "%";
    els.receiverStatus.textContent = `Receiving: ${pct}%`;
  };

  dc.onclose = () => {
    if (!isSender) {
      if (receivedSize < (fileMeta?.size || Infinity)) {
        els.receiverStatus.textContent = "Connection closed early.";
      }
    }
  };
}

async function makeOffer() {
  setupPeer();
  dc = pc.createDataChannel("file");
  wireDataChannel();

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal({ sdp: pc.localDescription });
}

async function handleSignal(payload) {
  try {
    if (payload.sdp) {
      if (!pc) setupPeer();
      await pc.setRemoteDescription(payload.sdp);
      if (payload.sdp.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal({ sdp: pc.localDescription });
      }
    } else if (payload.candidate) {
      try { await pc.addIceCandidate(payload.candidate); } catch (e) { console.warn("Add ICE failed", e); }
    }
  } catch (e) {
    console.error(e);
  }
}

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
