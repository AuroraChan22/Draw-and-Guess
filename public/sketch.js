const socket = io();

let myId = null;
let room = null;

let isDrawer = false;
let lastX, lastY;

let roleEl, secretWordEl, scoresEl, logEl, formEl, inputEl, playersEl;
let btnDrawer, btnGuess, btnReady, btnReset;
let roomLabel;

let overlay, roomCodeInput, playerNameInput, btnJoin, joinError;

let canvas;

function setup() {
  roleEl = document.getElementById("role");
  secretWordEl = document.getElementById("secretWord");
  scoresEl = document.getElementById("scores");
  logEl = document.getElementById("chatLog");
  formEl = document.getElementById("chatForm");
  inputEl = document.getElementById("chatInput");
  playersEl = document.getElementById("players");
  roomLabel = document.getElementById("roomLabel");

  btnDrawer = document.getElementById("btnDrawer");
  btnGuess = document.getElementById("btnGuess");
  btnReady = document.getElementById("btnReady");
  btnReset = document.getElementById("btnReset");

  overlay = document.getElementById("overlay");
  roomCodeInput = document.getElementById("roomCode");
  playerNameInput = document.getElementById("playerName");
  btnJoin = document.getElementById("btnJoin");
  joinError = document.getElementById("joinError");

  const host = document.getElementById("canvasHost");
  canvas = createCanvas(host.offsetWidth, host.offsetHeight);
  canvas.parent("canvasHost");
  background(255);

  bindJoin();
  bindChat();
  bindButtons();
  bindSocket();
}

function draw() {
  if (!room || room.phase !== "playing") return;
  if (!isDrawer) return;

  if (mouseIsPressed && insideCanvas(mouseX, mouseY)) {
    if (lastX === undefined) { lastX = mouseX; lastY = mouseY; }

    stroke(0);
    strokeWeight(4);
    line(lastX, lastY, mouseX, mouseY);

    socket.emit("draw", {
      x0: lastX / width,
      y0: lastY / height,
      x1: mouseX / width,
      y1: mouseY / height,
      color: "#000000",
      weight: 4,
    });

    lastX = mouseX;
    lastY = mouseY;
  } else {
    lastX = undefined;
    lastY = undefined;
  }
}

function windowResized() {
  const host = document.getElementById("canvasHost");
  resizeCanvas(host.offsetWidth, host.offsetHeight);
  background(255);
  socket.emit("request-history");
}

function bindJoin() {
  btnJoin.onclick = () => {
    joinError.textContent = "";
    const roomCode = roomCodeInput.value.trim().toUpperCase();
    const name = playerNameInput.value.trim();
    socket.emit("join-room", { roomCode, name });
  };
}

function bindButtons() {
  btnReady.onclick = () => {
    if (!room) return;
    const me = room.players.find(p => p.id === myId);
    const next = !(me && me.ready);
    socket.emit("set-ready", { ready: next });
  };

  btnDrawer.onclick = () => appendSystem("The drawer role rotates automatically. Wait for your turn.");
  btnGuess.onclick = () => appendSystem("Guess by typing in chat.");

  btnReset.onclick = () => socket.emit("reset-canvas");
}

function bindChat() {
  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text) return;
    socket.emit("chat", { text });
    inputEl.value = "";
  });
}

function bindSocket() {
  socket.on("join-error", ({ message }) => {
    joinError.textContent = message || "Join failed.";
  });

  socket.on("join-success", ({ room: r, myId: id }) => {
    myId = id;
    room = r;

    overlay.style.display = "none";
    roomLabel.textContent = room.code;

    roleEl.textContent = "Lobby: click Ready";
    enableControls(true);
    renderRoom();
    renderScoresFromRoom();
    updateReadyButton();
    updateHostButton();
  });

  socket.on("room-update", (r) => {
    room = r;
    roomLabel.textContent = room.code;

    isDrawer = room.phase === "playing" && room.drawerId === myId;

    if (room.phase === "lobby") {
      roleEl.textContent = "Lobby: click Ready";
      secretWordEl.textContent = "—";
    } else {
      roleEl.textContent = isDrawer ? "Role: Drawer" : "Role: Guessing";
      if (!isDrawer) secretWordEl.textContent = "—";
    }

    renderRoom();
    renderScoresFromRoom();
    updateReadyButton();
    updateHostButton();
  });

  socket.on("secret-word", ({ word }) => {
    if (isDrawer) secretWordEl.textContent = word;
  });

  socket.on("draw", (d) => {
    stroke(d.color);
    strokeWeight(d.weight);
    line(d.x0 * width, d.y0 * height, d.x1 * width, d.y1 * height);
  });

  socket.on("clear-canvas", () => background(255));

  socket.on("init-canvas", (history) => {
    background(255);
    (history || []).forEach(d => {
      stroke(d.color);
      strokeWeight(d.weight);
      line(d.x0 * width, d.y0 * height, d.x1 * width, d.y1 * height);
    });
  });

  socket.on("chat", (msg) => appendChat(msg.name || "Anon", msg.text || ""));
}

function enableControls(on) {
  btnDrawer.disabled = !on;
  btnGuess.disabled = !on;
  btnReady.disabled = !on;
  btnReset.disabled = !on;
}

function updateHostButton() {
  const isHost = room && room.hostId === myId;
  btnReset.disabled = !isHost;
}

function updateReadyButton() {
  if (!room) return;
  const me = room.players.find(p => p.id === myId);
  const ready = !!me?.ready;
  btnReady.textContent = ready ? "Unready" : "Ready";
}

function renderRoom() {
  if (!room) return;
  playersEl.innerHTML = "";

  room.players.forEach((p) => {
    const row = document.createElement("div");
    row.className = "playerRow";

    const left = document.createElement("div");
    left.textContent = p.name;

    const right = document.createElement("div");

    if (p.id === room.hostId) right.appendChild(badge("HOST", "host"));
    if (room.phase === "playing" && p.id === room.drawerId) right.appendChild(badge("DRAWER", "drawer"));
    right.appendChild(badge(p.ready ? "READY" : "NOT READY", p.ready ? "ready" : ""));

    row.appendChild(left);
    row.appendChild(right);
    playersEl.appendChild(row);
  });

  for (let i = room.players.length; i < 3; i++) {
    const row = document.createElement("div");
    row.className = "playerRow";
    row.style.opacity = "0.6";
    row.textContent = "— empty slot —";
    playersEl.appendChild(row);
  }
}

function renderScoresFromRoom() {
  if (!room) return;

  const entries = room.players
    .map(p => [p.name, p.score || 0])
    .sort((a,b) => b[1] - a[1]);

  if (entries.length === 0) {
    scoresEl.textContent = "No scores yet";
    return;
  }

  scoresEl.innerHTML = entries.map(([name, score]) => {
    const div = document.createElement("div");
    div.textContent = `${name}: ${score}`;
    return div.outerHTML;
  }).join("");
}

function badge(text, cls) {
  const s = document.createElement("span");
  s.className = "badge " + (cls || "");
  s.textContent = text;
  return s;
}

function insideCanvas(x, y) {
  return x >= 0 && y >= 0 && x <= width && y <= height;
}

function appendChat(name, text) {
  const p = document.createElement("p");
  p.className = "msg";

  const b = document.createElement("b");
  b.textContent = `${name}: `;
  p.appendChild(b);

  p.appendChild(document.createTextNode(text));
  logEl.appendChild(p);
  logEl.scrollTop = logEl.scrollHeight;
}

function appendSystem(text) {
  appendChat("SYSTEM", text);
}