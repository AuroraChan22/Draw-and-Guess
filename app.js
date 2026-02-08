const express = require("express");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, "public")));

// English-only word bank
const WORDS = [
  "cat","pizza","umbrella","guitar","train","ghost","robot",
  "banana","volcano","butterfly","camera","castle","octopus",
  "cactus","snowman","toaster","bicycle","book","cookie","rocket"
];

const rooms = new Map();

function pickWord() {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      hostId: null,
      players: [],
      phase: "lobby", // "lobby" | "playing"
      drawerIndex: 0,
      currentWord: null,
      drawingHistory: []
    });
  }
  return rooms.get(code);
}

function roomState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      ready: p.ready,
      score: p.score
    })),
    drawerId: room.phase === "playing" ? (room.players[room.drawerIndex]?.id || null) : null
  };
}

function emitRoom(room) {
  io.to(room.code).emit("room-update", roomState(room));
}

function systemToRoom(room, text) {
  io.to(room.code).emit("chat", { name: "SYSTEM", text });
}

function maybeStart(room) {
  if (room.phase !== "lobby") return;
  if (room.players.length !== 3) return;
  if (!room.players.every(p => p.ready)) return;

  room.phase = "playing";
  room.drawerIndex = 0; // host first
  room.currentWord = pickWord();
  room.drawingHistory = [];

  const drawer = room.players[room.drawerIndex];
  systemToRoom(room, `All ready! Game starts. Drawer: ${drawer.name}`);
  io.to(room.code).emit("clear-canvas");
  emitRoom(room);

  // ✅ private word delivery: ONLY to the drawer socket
  io.to(drawer.id).emit("secret-word", { word: room.currentWord });
}

function nextRound(room, reasonText) {
  if (room.phase !== "playing") return;

  room.drawerIndex = (room.drawerIndex + 1) % room.players.length;
  room.currentWord = pickWord();
  room.drawingHistory = [];

  const drawer = room.players[room.drawerIndex];
  io.to(room.code).emit("clear-canvas");
  systemToRoom(room, reasonText || `Next round! Drawer: ${drawer.name}`);
  emitRoom(room);

  io.to(drawer.id).emit("secret-word", { word: room.currentWord });
}

function removePlayer(room, socketId) {
  room.players = room.players.filter(p => p.id !== socketId);

  if (room.hostId === socketId) {
    room.hostId = room.players[0]?.id || null;
    if (room.hostId) systemToRoom(room, "Host left. A new host has been assigned.");
  }

  // safest: if someone leaves during a match, return to lobby
  if (room.phase === "playing") {
    room.phase = "lobby";
    room.currentWord = null;
    room.drawingHistory = [];
    room.drawerIndex = 0;
    room.players.forEach(p => (p.ready = false));
    systemToRoom(room, "A player left. Back to lobby — please ready up again.");
    io.to(room.code).emit("clear-canvas");
  }

  if (room.players.length === 0) {
    rooms.delete(room.code);
    return;
  }

  emitRoom(room);
}

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomCode, name }) => {
    const code = String(roomCode || "").trim().toUpperCase();
    const playerName = String(name || "").trim().slice(0, 18);

    if (!code || !playerName) {
      socket.emit("join-error", { message: "Room code and name are required." });
      return;
    }

    const room = getRoom(code);

    if (room.players.length >= 3) {
      socket.emit("join-error", { message: "Room is full (max 3 players)." });
      return;
    }

    socket.join(code);
    socket.data.roomCode = code;

    if (!room.hostId) room.hostId = socket.id;

    room.players.push({
      id: socket.id,
      name: playerName,
      ready: false,
      score: 0
    });

    socket.emit("join-success", { room: roomState(room), myId: socket.id });
    systemToRoom(room, `${playerName} joined (${room.players.length}/3).`);
    emitRoom(room);
  });

  socket.on("set-ready", ({ ready }) => {
    const code = socket.data.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    const me = room.players.find(p => p.id === socket.id);
    if (!me) return;

    me.ready = !!ready;
    emitRoom(room);

    systemToRoom(room, `${me.name} is ${me.ready ? "READY" : "NOT ready"}.`);
    maybeStart(room);
  });

  socket.on("draw", (data) => {
    const code = socket.data.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room || room.phase !== "playing") return;

    const drawerId = room.players[room.drawerIndex]?.id;
    if (socket.id !== drawerId) return;

    room.drawingHistory.push(data);
    socket.to(code).emit("draw", data);
  });

  socket.on("request-history", () => {
    const code = socket.data.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    socket.emit("init-canvas", room.drawingHistory);
  });

  socket.on("chat", (msg) => {
    const code = socket.data.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    const me = room.players.find(p => p.id === socket.id);
    if (!me) return;

    const text = String(msg?.text || "").trim().slice(0, 120);
    if (!text) return;

    io.to(code).emit("chat", { name: me.name, text });

    if (room.phase !== "playing") return;

    const drawerId = room.players[room.drawerIndex]?.id;
    if (socket.id === drawerId) return;

    const isCorrect = text.toLowerCase() === String(room.currentWord || "").toLowerCase();
    if (isCorrect) {
      me.score += 1;
      systemToRoom(room, `${me.name} guessed it! The word was "${room.currentWord}".`);
      emitRoom(room);

      // ✅ FIX: don't pass an old drawer name; let nextRound announce the NEW drawer
      nextRound(room);
    }
  });

  socket.on("reset-canvas", () => {
    const code = socket.data.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    if (room.hostId !== socket.id) return;

    room.drawingHistory = [];
    io.to(room.code).emit("clear-canvas");
    systemToRoom(room, "Canvas was reset by the host.");
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    removePlayer(room, socket.id);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running: http://localhost:${PORT}`);
});