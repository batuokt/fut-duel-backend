// index.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

// ============= EXPRESS / HTTP =============
const app = express();

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 3001;
const server = http.createServer(app);

// ============= SOCKET.IO SETUP =============
const allowedOrigins = [
  'http://localhost:3000',
  'https://futduel.com',
  'https://www.futduel.com',
];

const vercelPattern = /^https:\/\/fut-duel-[^.]+\.vercel\.app$/;

const io = new Server(server, {
  path: '/api/socketio',
  cors: {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // SSR / tools
      if (allowedOrigins.includes(origin) || vercelPattern.test(origin)) {
        return cb(null, true);
      }
      return cb(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// ============= TYPES / STATE SHAPES =============

// Queue entries: waiting to be matched
// { socketId, odId, username }
const queue = [];

// Games map: gameId -> game
// game = {
//   id,
//   players: [
//     { odId, username, socketId, accepted, score, rp, connected },
//     { odId, username, socketId, accepted, score, rp, connected },
//   ],
//   scores: Record<odId, number>,
//   usedCards: number[],
//   currentRound: RoundInfo,
//   roundNumber: number,
//   maxRounds: number,
//   moves: Record<odId, MoveInfoWithCard>,
//   isStarted: boolean,
//   isFinished: boolean,
//   disconnectTimer: Timeout | null,
//   disconnectedPlayerOdId: string | null,
// }
const games = new Map();

// Helper maps
// socketId -> odId
const socketToUser = new Map();
// odId -> socketId
const userToSocket = new Map();
// socketId -> gameId
const socketToGameId = new Map();
// odId -> gameId
const userToGameId = new Map();

// Configs
const DISCONNECT_GRACE_MS = 30_000;
const MAX_ROUNDS = 5;

// Very simple RP values (tweak freely)
const RP_WIN = 20;
const RP_LOSS = -15;
const RP_FORFEIT_LOSS = -25;
const RP_OPP_DISCONNECT_WIN = 25;

// ============= GAME ROUND / LOGIC HELPERS =============

function getRoundInfo(roundNumber) {
  // You can tweak this order to match your exact game rules.
  // Round 4 is explicitly GK round per your requirement.
  const roundStats = [
    { round: 1, stat: 'pace', isGKRound: false },
    { round: 2, stat: 'shooting', isGKRound: false },
    { round: 3, stat: 'passing', isGKRound: false },
    { round: 4, stat: 'gk_diving', isGKRound: true }, // GK round
    { round: 5, stat: 'dribbling', isGKRound: false },
    { round: 6, stat: 'defending', isGKRound: false },
    { round: 7, stat: 'physical', isGKRound: false },
  ];

  const idx = (roundNumber - 1) % roundStats.length;
  return roundStats[idx];
}

function createInitialRound() {
  return getRoundInfo(1);
}

function getOpponentIndex(playerIndex) {
  return playerIndex === 0 ? 1 : 0;
}

function getPlayerIndex(game, odId) {
  return game.players.findIndex((p) => p.odId === odId);
}

function getOpponentOdId(game, odId) {
  const idx = getPlayerIndex(game, odId);
  if (idx === -1) return null;
  const oppIdx = getOpponentIndex(idx);
  return game.players[oppIdx]?.odId ?? null;
}

function calculateRpChange(winnerOdId, loserOdId, reason) {
  // Returns { [odId]: delta }
  const rpChange = {};

  if (!winnerOdId || !loserOdId) return rpChange;

  if (reason === 'forfeit') {
    rpChange[winnerOdId] = RP_WIN;
    rpChange[loserOdId] = RP_FORFEIT_LOSS;
  } else if (reason === 'opponent-disconnected') {
    rpChange[winnerOdId] = RP_OPP_DISCONNECT_WIN;
    rpChange[loserOdId] = RP_FORFEIT_LOSS;
  } else {
    // normal game end
    rpChange[winnerOdId] = RP_WIN;
    rpChange[loserOdId] = RP_LOSS;
  }

  return rpChange;
}

function computeScoresFromGame(game) {
  // scores: Record<string, number> - simple score integers
  const scores = {};
  game.players.forEach((p) => {
    scores[p.odId] = p.score;
  });
  return scores;
}

// ============= MATCHMAKING HELPERS =============

function removeFromQueueBySocket(socketId) {
  const idx = queue.findIndex((p) => p.socketId === socketId);
  if (idx !== -1) {
    queue.splice(idx, 1);
  }
}

function tryMatchPlayers() {
  while (queue.length >= 2) {
    const p1 = queue.shift();
    const p2 = queue.shift();
    if (!p1 || !p2) break;

    const gameId = uuidv4();
    const players = [
      {
        odId: p1.odId,
        username: p1.username,
        socketId: p1.socketId,
        accepted: false,
        score: 0,
        rp: 0,
        connected: true,
      },
      {
        odId: p2.odId,
        username: p2.username,
        socketId: p2.socketId,
        accepted: false,
        score: 0,
        rp: 0,
        connected: true,
      },
    ];

    const game = {
      id: gameId,
      players,
      scores: { [p1.odId]: 0, [p2.odId]: 0 },
      usedCards: [],
      currentRound: createInitialRound(),
      roundNumber: 1,
      maxRounds: MAX_ROUNDS,
      moves: {},
      isStarted: false,
      isFinished: false,
      disconnectTimer: null,
      disconnectedPlayerOdId: null,
    };

    games.set(gameId, game);

    // Map relationships
    socketToGameId.set(p1.socketId, gameId);
    socketToGameId.set(p2.socketId, gameId);
    userToGameId.set(p1.odId, gameId);
    userToGameId.set(p2.odId, gameId);

    // Notify both players of match-found
    const payloadFor = (me, opponent, isHost) => ({
      gameId,
      opponent: {
        id: opponent.odId,
        username: opponent.username,
      },
      isHost,
    });

    // p1 is host (isHost = true), p2 is guest
    io.to(p1.socketId).emit('match-found', payloadFor(p1, p2, true));
    io.to(p2.socketId).emit('match-found', payloadFor(p2, p1, false));
  }
}

// ============= GAME START / STATE EMIT =============

function maybeStartGame(game) {
  if (!game) return;
  if (game.isStarted || game.isFinished) return;

  // Start when both players accepted
  const allAccepted = game.players.every((p) => p.accepted);
  if (!allAccepted) return;

  game.isStarted = true;

  const gameStartedPayload = {
    gameId: game.id,
    players: game.players.map((p) => ({
      odId: p.odId,
      username: p.username,
    })),
    currentRound: game.currentRound,
  };

  game.players.forEach((p) => {
    if (p.socketId && io.sockets.sockets.get(p.socketId)) {
      io.to(p.socketId).emit('game-started', gameStartedPayload);
    }
  });

  // Initial game-state
  emitGameState(game);
}

function emitGameState(game) {
  const scores = computeScoresFromGame(game);

  const payload = {
    gameId: game.id,
    currentRound: game.currentRound,
    scores,
    usedCards: game.usedCards,
  };

  game.players.forEach((p) => {
    if (p.socketId && io.sockets.sockets.get(p.socketId)) {
      io.to(p.socketId).emit('game-state', payload);
    }
  });
}

// ============= ROUND RESOLUTION / END GAME =============

function resolveRoundIfReady(game) {
  if (!game || game.isFinished) return;
  const odIds = game.players.map((p) => p.odId);

  // Need both moves
  if (!game.moves[odIds[0]] || !game.moves[odIds[1]]) return;

  const moveA = game.moves[odIds[0]];
  const moveB = game.moves[odIds[1]];

  // Determine round winner - simple comparison
  let roundWinnerOdId = null;

  if (moveA.statValue === moveB.statValue) {
    roundWinnerOdId = null; // Draw
  } else if (moveA.statValue > moveB.statValue) {
    roundWinnerOdId = odIds[0];
  } else {
    roundWinnerOdId = odIds[1];
  }

  // Add +1 to winner's score (draw = 0 points)
  if (roundWinnerOdId) {
    const winnerIdx = getPlayerIndex(game, roundWinnerOdId);
    if (winnerIdx !== -1) {
      game.players[winnerIdx].score += 1;
      game.scores[roundWinnerOdId] = game.players[winnerIdx].score;
    }
  }

  // Update usedCards
  odIds.forEach((id) => {
    const mv = game.moves[id];
    if (mv && typeof mv.cardId === 'number') {
      if (!game.usedCards.includes(mv.cardId)) {
        game.usedCards.push(mv.cardId);
      }
    }
  });

  const scores = computeScoresFromGame(game);

  // Check if game is over (after max rounds or if someone has insurmountable lead)
  let isGameOver = false;
  let finalWinner = null;

  // Game ends after max rounds
  if (game.roundNumber >= game.maxRounds) {
    isGameOver = true;
    const p0 = game.players[0];
    const p1 = game.players[1];
    
    if (p0.score > p1.score) {
      finalWinner = p0.odId;
    } else if (p1.score > p0.score) {
      finalWinner = p1.odId;
    } else {
      finalWinner = null; // Draw
    }
  }

  // Prepare next round if not over
  let nextRound = null;
  if (!isGameOver) {
    game.roundNumber += 1;
    game.currentRound = getRoundInfo(game.roundNumber);
    nextRound = game.currentRound;
  }

  // Construct RoundCompletedPayload
  const roundPayload = {
    round: game.currentRound.round,
    stat: game.currentRound.stat,
    isGKRound: game.currentRound.isGKRound,
    moves: {
      [odIds[0]]: game.moves[odIds[0]],
      [odIds[1]]: game.moves[odIds[1]],
    },
    roundWinner: roundWinnerOdId,
    damage: 0, // No damage in score-based system
    scores,
    isGameOver,
    finalWinner,
    nextRound,
  };

  // Emit round-completed to both players
  game.players.forEach((p) => {
    if (p.socketId && io.sockets.sockets.get(p.socketId)) {
      io.to(p.socketId).emit('round-completed', roundPayload);
    }
  });

  // Clear moves
  game.moves = {};

  if (isGameOver) {
    finishGame(game, {
      reason: 'normal',
      winnerOdId: finalWinner,
    });
  } else {
    // Update game-state for next round
    emitGameState(game);
  }
}

function finishGame(game, { reason, winnerOdId, loserOdId, disconnectedPlayerOdId } = {}) {
  if (!game || game.isFinished) return;
  game.isFinished = true;

  const odIds = game.players.map((p) => p.odId);
  const scores = computeScoresFromGame(game);

  if (!winnerOdId && reason === 'normal') {
    // Determine winner from score if not given
    const p0 = game.players[0];
    const p1 = game.players[1];
    if (p0.score > p1.score) winnerOdId = p0.odId;
    else if (p1.score > p0.score) winnerOdId = p1.odId;
    else winnerOdId = null; // Draw
  }

  if (!loserOdId && winnerOdId) {
    loserOdId = odIds.find((id) => id !== winnerOdId) || null;
  }

  const rpChange = calculateRpChange(winnerOdId, loserOdId, reason);

  // Build GameEndedPayload
  let reasonTag;
  if (reason === 'opponent-disconnected') {
    reasonTag = 'opponent-disconnected';
  } else if (reason === 'forfeit') {
    reasonTag = 'forfeit';
  } else {
    // Fallback: treat as normal game resolution
    reasonTag = 'forfeit';
  }

  let disconnectedPlayer = null;
  if (disconnectedPlayerOdId) {
    const p = game.players.find((pl) => pl.odId === disconnectedPlayerOdId);
    if (p) {
      disconnectedPlayer = {
        odId: p.odId,
        username: p.username,
      };
    }
  }

  const payload = {
    gameId: game.id,
    reason: reasonTag,
    winner: winnerOdId || '',
    loser: loserOdId || '',
    scores,
    rpChange,
    disconnectedPlayer,
  };

  // Emit to all connected players
  game.players.forEach((p) => {
    if (p.socketId && io.sockets.sockets.get(p.socketId)) {
      io.to(p.socketId).emit('game-ended', payload);
    }
  });

  // Cleanup timers
  if (game.disconnectTimer) {
    clearTimeout(game.disconnectTimer);
    game.disconnectTimer = null;
  }

  // Clean helper maps
  game.players.forEach((p) => {
    if (!p) return;
    const sId = p.socketId;
    if (sId) {
      socketToGameId.delete(sId);
    }
    userToGameId.delete(p.odId);
  });
}

// ============= SOCKET.IO EVENTS =============

io.on('connection', (socket) => {
  console.log('[Socket] Connected:', socket.id);

  // Track mapping (updated on events with odId)
  socket.on('disconnect', (reason) => {
    console.log('[Socket] Disconnected:', socket.id, 'reason:', reason);

    removeFromQueueBySocket(socket.id);

    const odId = socketToUser.get(socket.id);
    const gameId = socketToGameId.get(socket.id);

    socketToUser.delete(socket.id);
    socketToGameId.delete(socket.id);
    if (odId) {
      userToSocket.delete(odId);
    }

    if (!gameId) return;
    const game = games.get(gameId);
    if (!game || game.isFinished) return;

    const idx = getPlayerIndex(game, odId);
    if (idx === -1) return;
    const player = game.players[idx];
    player.connected = false;

    const opponentIdx = getOpponentIndex(idx);
    const opponent = game.players[opponentIdx];

    // Notify opponent immediately
    if (opponent && opponent.socketId && io.sockets.sockets.get(opponent.socketId)) {
      io.to(opponent.socketId).emit('opponent-disconnected', {
        username: player.username,
      });
    }

    game.disconnectedPlayerOdId = player.odId;

    // Start grace timer
    if (game.disconnectTimer) {
      clearTimeout(game.disconnectTimer);
      game.disconnectTimer = null;
    }
    game.disconnectTimer = setTimeout(() => {
      const stillDisconnected = !game.players[idx].connected;
      if (stillDisconnected && !game.isFinished) {
        const winnerOdId = opponent ? opponent.odId : null;
        finishGame(game, {
          reason: 'opponent-disconnected',
          winnerOdId,
          loserOdId: player.odId,
          disconnectedPlayerOdId: player.odId,
        });
      }
    }, DISCONNECT_GRACE_MS);
  });

  // --------- MATCHMAKING: join-queue / leave-queue ---------

  // { odId, username }
  socket.on('join-queue', (data) => {
    const { odId, username } = data || {};
    if (!odId || !username) {
      socket.emit('game-error', {
        message: 'Missing odId or username',
        code: 'INVALID_QUEUE_PAYLOAD',
      });
      return;
    }

    socketToUser.set(socket.id, odId);
    userToSocket.set(odId, socket.id);

    // Avoid duplicate queue entries
    removeFromQueueBySocket(socket.id);
    queue.push({ socketId: socket.id, odId, username });

    const position = queue.findIndex((p) => p.socketId === socket.id) + 1;
    const queueSize = queue.length;

    socket.emit('queue-joined', { position, queueSize });

    tryMatchPlayers();
  });

  socket.on('leave-queue', () => {
    removeFromQueueBySocket(socket.id);
    socket.emit('queue-left');
  });

  // --------- MATCH ACCEPTANCE: player-accepted ---------

  // { gameId }
  socket.on('player-accepted', (data) => {
    const { gameId } = data || {};
    if (!gameId) return;

    const game = games.get(gameId);
    if (!game || game.isFinished) {
      socket.emit('game-error', {
        message: 'Game not found',
        code: 'GAME_NOT_FOUND',
        gameId,
      });
      return;
    }

    const odId = socketToUser.get(socket.id);
    if (!odId) return;

    const idx = getPlayerIndex(game, odId);
    if (idx === -1) return;

    game.players[idx].accepted = true;
    maybeStartGame(game);
  });

  // --------- JOIN GAME ROOM: join-game ---------

  // { gameId, odId, username }
  socket.on('join-game', (data) => {
    const { gameId, odId, username } = data || {};
    if (!gameId || !odId) {
      socket.emit('game-error', {
        message: 'Missing gameId or odId',
        code: 'INVALID_JOIN_GAME_PAYLOAD',
        gameId,
      });
      return;
    }

    const game = games.get(gameId);
    if (!game || game.isFinished) {
      socket.emit('game-error', {
        message: 'Game not found',
        code: 'GAME_NOT_FOUND',
        gameId,
      });
      return;
    }

    // Bind user <-> socket
    socketToUser.set(socket.id, odId);
    userToSocket.set(odId, socket.id);
    socketToGameId.set(socket.id, gameId);
    userToGameId.set(odId, gameId);

    let idx = getPlayerIndex(game, odId);
    if (idx === -1) {
      // If player not found in game, reject
      socket.emit('game-error', {
        message: 'Player not part of this game',
        code: 'NOT_IN_GAME',
        gameId,
      });
      return;
    }

    // Update username if provided (for safety)
    if (username) {
      game.players[idx].username = username;
    }

    game.players[idx].socketId = socket.id;
    game.players[idx].connected = true;

    socket.emit('game-joined', {
      gameId,
      odId,
      playerIndex: idx,
    });

    // If game already started, send current state
    if (game.isStarted && !game.isFinished) {
      emitGameState(game);
    }
  });

  // --------- LEAVE GAME (FORFEIT): leave-game ---------

  // { gameId }
  socket.on('leave-game', (data) => {
    const { gameId } = data || {};
    if (!gameId) return;

    const game = games.get(gameId);
    if (!game || game.isFinished) return;

    const odId = socketToUser.get(socket.id);
    if (!odId) return;

    const idx = getPlayerIndex(game, odId);
    if (idx === -1) return;

    const opponentOdId = getOpponentOdId(game, odId);

    finishGame(game, {
      reason: 'forfeit',
      winnerOdId: opponentOdId,
      loserOdId: odId,
    });
  });

  // --------- SUBMIT MOVE: submit-move ---------

  // { gameId, odId, cardId, statValue, cardData? }
  socket.on('submit-move', (data) => {
    const { gameId, odId, cardId, statValue, cardData } = data || {};

    if (!gameId || !odId || typeof cardId !== 'number' || typeof statValue !== 'number') {
      socket.emit('move-error', {
        message: 'Invalid move payload',
        code: 'INVALID_MOVE_PAYLOAD',
      });
      return;
    }

    const game = games.get(gameId);
    if (!game || game.isFinished || !game.isStarted) {
      socket.emit('move-error', {
        message: 'Game not available',
        code: 'GAME_NOT_AVAILABLE',
      });
      return;
    }

    const idx = getPlayerIndex(game, odId);
    if (idx === -1) {
      socket.emit('move-error', {
        message: 'Player not in game',
        code: 'PLAYER_NOT_IN_GAME',
      });
      return;
    }

    // Prevent multiple moves per round
    if (game.moves[odId]) {
      socket.emit('move-error', {
        message: 'Move already submitted for this round',
        code: 'MOVE_ALREADY_SUBMITTED',
      });
      return;
    }

    // Save move
    game.moves[odId] = {
      odId,
      cardId,
      statValue,
      cardData: cardData || null,
    };

    // Acknowledge move to player
    socket.emit('move-received', { cardId });

    // Notify opponent that a move was made
    const opponentOdId = getOpponentOdId(game, odId);
    if (opponentOdId) {
      const oppSocketId = userToSocket.get(opponentOdId);
      if (oppSocketId && io.sockets.sockets.get(oppSocketId)) {
        io.to(oppSocketId).emit('opponent-moved');
      }
    }

    // Attempt to resolve round if both moves present
    resolveRoundIfReady(game);
  });
});

// ============= START SERVER =============
server.listen(PORT, () => {
  console.log(`Socket.io server running on port ${PORT}`);
});
