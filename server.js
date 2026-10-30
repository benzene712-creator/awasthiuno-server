
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const rooms = new Map();

app.get("/", (req, res) => {
  res.send("AwasthiUNO multiplayer server is running!");
});

app.get("/health", (req, res) => {
  res.json({ status: "online", rooms: rooms.size });
});
app.get("/test", (req, res) => {
  res.sendFile(__dirname + "/test.html");
});

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;

  do {
    code = "";
    for (let i = 0; i < 6; i++) {
      code += chars[crypto.randomInt(chars.length)];
    }
  } while (rooms.has(code));

  return code;
}

function getRoomInfo(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    players: room.players.map(player => ({
      id: player.id,
      name: player.name,
      isHost: player.id === room.hostId
    }))
  };
}

function updateRoom(room) {
  io.to(room.code).emit("room_update", getRoomInfo(room));
}

function removePlayer(socket) {
  const code = socket.data.roomCode;
  if (!code) return;

  const room = rooms.get(code);
  socket.data.roomCode = null;

  if (!room) return;

  room.players = room.players.filter(
    player => player.id !== socket.id
  );

  if (room.players.length === 0) {
    rooms.delete(code);
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = room.players[0].id;
  }

  updateRoom(room);
}

function cleanName(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, 16);
}

io.on("connection", socket => {
  console.log("Player connected:", socket.id);

  socket.on("create_room", (data, callback) => {
    const name = cleanName(data?.name);

    if (!name) {
      return callback?.({
        ok: false,
        error: "Enter a player name."
      });
    }

    if (socket.data.roomCode) {
      return callback?.({
        ok: false,
        error: "Leave your current room first."
      });
    }

    const code = makeRoomCode();

    const room = {
      code,
      hostId: socket.id,
      started: false,
      players: [{
        id: socket.id,
        name
      }]
    };

    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;

    callback?.({
      ok: true,
      room: getRoomInfo(room)
    });

    updateRoom(room);
    console.log("Room created:", code);
  });

  socket.on("join_room", (data, callback) => {
    const name = cleanName(data?.name);
    const code = String(data?.code || "")
      .trim()
      .toUpperCase();

    if (!name) {
      return callback?.({
        ok: false,
        error: "Enter a player name."
      });
    }

    if (socket.data.roomCode) {
      return callback?.({
        ok: false,
        error: "Leave your current room first."
      });
    }

    const room = rooms.get(code);

    if (!room) {
      return callback?.({
        ok: false,
        error: "Room not found. Check the code."
      });
    }

    if (room.started) {
      return callback?.({
        ok: false,
        error: "This game has already started."
      });
    }

    if (room.players.length >= 4) {
      return callback?.({
        ok: false,
        error: "This room is full."
      });
    }

    room.players.push({
      id: socket.id,
      name
    });

    socket.join(code);
    socket.data.roomCode = code;

    callback?.({
      ok: true,
      room: getRoomInfo(room)
    });

    updateRoom(room);
    console.log(name, "joined room:", code);
  });

  socket.on("start_game", callback => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);

    if (!room) {
      return callback?.({
        ok: false,
        error: "Room not found."
      });
    }

    if (room.hostId !== socket.id) {
      return callback?.({
        ok: false,
        error: "Only the host can start the game."
      });
    }

    if (room.players.length < 2) {
      return callback?.({
        ok: false,
        error: "At least 2 players are required."
      });
    }

    room.started = true;

    io.to(code).emit("game_started", getRoomInfo(room));
    callback?.({ ok: true });

    console.log("Game started in room:", code);
  });

  socket.on("leave_room", callback => {
    const code = socket.data.roomCode;

    removePlayer(socket);

    if (code) socket.leave(code);

    callback?.({ ok: true });
  });

  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
    removePlayer(socket);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AwasthiUNO server running on port ${PORT}`);
});
