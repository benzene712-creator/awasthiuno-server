const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
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
    code = Array.from({ length: 6 }, () =>
      chars[crypto.randomInt(chars.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function cleanName(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, 16);
}

function getRoomInfo(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.id === room.hostId
    }))
  };
}

function updateRoom(room) {
  io.to(room.code).emit("room_update", getRoomInfo(room));
}

function createDeck() {
  const deck = [];
  let id = 0;

  for (const color of ["RED", "BLUE", "GREEN", "YELLOW"]) {
    deck.push({ id: String(id++), color, value: 0, type: "NUMBER" });

    for (let n = 1; n <= 9; n++) {
      for (let copy = 0; copy < 2; copy++) {
        deck.push({
          id: String(id++), color, value: n, type: "NUMBER"
        });
      }
    }

    for (let copy = 0; copy < 2; copy++) {
      for (const type of ["SKIP", "REVERSE", "DRAW_TWO"]) {
        deck.push({
          id: String(id++), color, value: -1, type
        });
      }
    }
  }

  for (let i = 0; i < 4; i++) {
    deck.push({
      id: String(id++), color: "WILD", value: -1, type: "WILD"
    });
    deck.push({
      id: String(id++), color: "WILD", value: -1,
      type: "WILD_DRAW_FOUR"
    });
  }

  return deck.sort(() => Math.random() - 0.5);
}

function drawOne(game) {
  if (game.drawPile.length === 0) {
    if (game.discardPile.length <= 1) return null;

    const top = game.discardPile.pop();
    game.drawPile = game.discardPile.splice(0)
      .sort(() => Math.random() - 0.5);
    game.discardPile = [top];
  }

  return game.drawPile.pop() || null;
}

function nextPlayer(game, steps = 1) {
  for (let i = 0; i < steps; i++) {
    game.turn = (game.turn + game.direction + game.players.length)
      % game.players.length;
  }
}

function publicGameState(room) {
  const game = room.game;

  return {
    code: room.code,
    players: game.players.map(id => {
      const player = room.players.find(p => p.id === id);
      return {
        id,
        name: player ? player.name : "Player",
        cardCount: game.hands[id].length
      };
    }),
    currentPlayerId: game.players[game.turn],
    topCard: game.discardPile[game.discardPile.length - 1],
    currentColor: game.currentColor,
    drawCount: game.drawPile.length,
    direction: game.direction,
    message: game.message,
    gameOver: game.gameOver,
    winnerId: game.winnerId
  };
}

function sendGameState(room) {
  if (!room.game) return;

  const state = publicGameState(room);

  for (const playerId of room.game.players) {
    io.to(playerId).emit("game_state", {
      ...state,
      yourId: playerId,
      yourHand: room.game.hands[playerId]
    });
  }
}

function startUnoGame(room) {
  const deck = createDeck();
  const players = room.players.map(p => p.id);
  const hands = {};

  players.forEach(id => {
    hands[id] = [];
    for (let i = 0; i < 7; i++) {
      hands[id].push(deck.pop());
    }
  });

  let first = deck.pop();
  while (first && first.type !== "NUMBER") {
    deck.unshift(first);
    first = deck.pop();
  }

  room.game = {
    players,
    hands,
    drawPile: deck,
    discardPile: [first],
    turn: 0,
    direction: 1,
    currentColor: first.color,
    message: "Game started!",
    gameOver: false,
    winnerId: null
  };

  room.started = true;
  sendGameState(room);
}

function removePlayer(socket) {
  const code = socket.data.roomCode;
  if (!code) return;

  socket.data.roomCode = null;
  const room = rooms.get(code);
  if (!room) return;

  room.players = room.players.filter(p => p.id !== socket.id);

  if (room.players.length === 0) {
    rooms.delete(code);
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = room.players[0].id;
  }

  // A disconnect during a match ends that room's current match.
  if (room.started) {
    room.started = false;
    room.game = null;
    io.to(code).emit("game_ended", {
      message: "A player left. The match has ended."
    });
  }

  updateRoom(room);
}

io.on("connection", socket => {
  console.log("Player connected:", socket.id);

  socket.on("create_room", (data, callback) => {
    const name = cleanName(data?.name);

    if (!name) {
      return callback?.({ ok: false, error: "Enter a player name." });
    }

    if (socket.data.roomCode) {
      return callback?.({ ok: false, error: "Leave your current room first." });
    }

    const code = makeRoomCode();
    const room = {
      code,
      hostId: socket.id,
      started: false,
      players: [{ id: socket.id, name }],
      game: null
    };

    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;

    callback?.({ ok: true, room: getRoomInfo(room) });
    updateRoom(room);
  });

  socket.on("join_room", (data, callback) => {
    const name = cleanName(data?.name);
    const code = String(data?.code || "").trim().toUpperCase();

    if (!name) {
      return callback?.({ ok: false, error: "Enter a player name." });
    }

    if (socket.data.roomCode) {
      return callback?.({ ok: false, error: "Leave your current room first." });
    }

    const room = rooms.get(code);

    if (!room) {
      return callback?.({ ok: false, error: "Room not found. Check the code." });
    }

    if (room.started) {
      return callback?.({ ok: false, error: "This game has already started." });
    }

    if (room.players.length >= 4) {
      return callback?.({ ok: false, error: "This room is full." });
    }

    room.players.push({ id: socket.id, name });
    socket.join(code);
    socket.data.roomCode = code;

    callback?.({ ok: true, room: getRoomInfo(room) });
    updateRoom(room);
  });

  socket.on("start_game", callback => {
    const room = rooms.get(socket.data.roomCode);

    if (!room) {
      return callback?.({ ok: false, error: "Room not found." });
    }

    if (room.hostId !== socket.id) {
      return callback?.({ ok: false, error: "Only the host can start." });
    }

    if (room.players.length < 2) {
      return callback?.({ ok: false, error: "At least 2 players are required." });
    }

    if (room.started) {
      return callback?.({ ok: false, error: "Game already started." });
    }

    startUnoGame(room);
    callback?.({ ok: true });
  });

  socket.on("play_card", (data, callback) => {
    const room = rooms.get(socket.data.roomCode);
    const game = room?.game;

    if (!game || game.gameOver) {
      return callback?.({ ok: false, error: "No active game." });
    }

    if (game.players[game.turn] !== socket.id) {
      return callback?.({ ok: false, error: "It's not your turn." });
    }

    const hand = game.hands[socket.id];
    const cardIndex = hand.findIndex(c => c.id === String(data?.cardId));

    if (cardIndex < 0) {
      return callback?.({ ok: false, error: "Card not found in your hand." });
    }

    const card = hand[cardIndex];
    const top = game.discardPile[game.discardPile.length - 1];

    const playable =
      card.color === "WILD" ||
      card.color === game.currentColor ||
      (card.type === top.type && card.type !== "NUMBER") ||
      (card.type === "NUMBER" && top.type === "NUMBER" &&
        card.value === top.value);

    if (!playable) {
      return callback?.({ ok: false, error: "You cannot play that card." });
    }

    if (card.color === "WILD" &&
        !["RED", "BLUE", "GREEN", "YELLOW"].includes(data?.chosenColor)) {
      return callback?.({ ok: false, error: "Choose a valid colour." });
    }

    hand.splice(cardIndex, 1);
    game.discardPile.push(card);
    game.currentColor = card.color === "WILD"
      ? data.chosenColor
      : card.color;

    if (hand.length === 0) {
      game.gameOver = true;
      game.winnerId = socket.id;
      game.message = "Game over!";
    } else {
      let steps = 1;

      if (card.type === "SKIP") steps = 2;

      if (card.type === "REVERSE") {
        game.direction *= -1;
        steps = game.players.length === 2 ? 2 : 1;
      }

      if (card.type === "DRAW_TWO" || card.type === "WILD_DRAW_FOUR") {
        const amount = card.type === "DRAW_TWO" ? 2 : 4;
        const next = (game.turn + game.direction + game.players.length)
          % game.players.length;
        const nextId = game.players[next];

        for (let i = 0; i < amount; i++) {
          const drawn = drawOne(game);
          if (drawn) game.hands[nextId].push(drawn);
        }
        steps = 2;
      }

      nextPlayer(game, steps);
      game.message = "Card played!";
    }

    callback?.({ ok: true });
    sendGameState(room);
  });

  socket.on("draw_card", callback => {
    const room = rooms.get(socket.data.roomCode);
    const game = room?.game;

    if (!game || game.gameOver) {
      return callback?.({ ok: false, error: "No active game." });
    }

    if (game.players[game.turn] !== socket.id) {
      return callback?.({ ok: false, error: "It's not your turn." });
    }

    const card = drawOne(game);
    if (card) game.hands[socket.id].push(card);

    nextPlayer(game);
    game.message = "A card was drawn.";

    callback?.({ ok: true });
    sendGameState(room);
  });

  socket.on("call_uno", callback => {
    const room = rooms.get(socket.data.roomCode);
    const game = room?.game;

    if (!game || game.gameOver || !game.hands[socket.id]) {
      return callback?.({ ok: false, error: "No active game." });
    }

    if (game.hands[socket.id].length !== 1) {
      return callback?.({ ok: false, error: "You can call UNO with one card left." });
    }

    game.message = "UNO! " +
      (room.players.find(p => p.id === socket.id)?.name || "A player") +
      " has one card left.";

    callback?.({ ok: true });
    sendGameState(room);
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
