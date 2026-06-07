// index.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

// ============= SUPABASE SETUP =============
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn('[Warning] Supabase credentials not found. User profile endpoints may not work.');
}

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// ============= EXPRESS / HTTP =============
const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS middleware (if needed for API endpoints)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = [
    'http://localhost:3000',
    'https://futduel.com',
    'https://www.futduel.com',
    'https://app.futduel.com'
  ];
  const vercelPattern = /^https:\/\/fut-duel-[^.]+\.vercel\.app$/;
  
  if (!origin || allowedOrigins.includes(origin) || vercelPattern.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ============= HELPER FUNCTIONS =============

/**
 * Counts unclaimed missions for a user
 * 
 * Database Schema Assumptions:
 * - Table name: 'user_missions' (adjust if your table is named differently, e.g., 'missions', 'UserMissions')
 * - Column names:
 *   - 'user_id' (adjust if using 'userId' or 'odId')
 *   - 'status' (should be 'COMPLETED' for completed missions)
 *   - 'is_claimed' (boolean, false for unclaimed missions)
 * 
 * If your schema differs, update the table/column names in the query below.
 * 
 * @param {string} userId - The user's ID (odId)
 * @returns {Promise<number>} Count of unclaimed missions
 */
async function getUnclaimedMissionsCount(userId) {
  if (!supabase || !userId) {
    return 0;
  }

  try {
    const { count, error } = await supabase
      .from('user_missions') // Adjust table name if needed
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId) // Adjust column name if needed (e.g., 'userId', 'odId')
      .eq('status', 'COMPLETED') // Adjust status value if needed
      .eq('is_claimed', false); // Adjust column name if needed (e.g., 'claimed', 'isClaimed')

    if (error) {
      console.error('[getUnclaimedMissionsCount] Error:', error);
      return 0;
    }

    return count || 0;
  } catch (error) {
    console.error('[getUnclaimedMissionsCount] Exception:', error);
    return 0;
  }
}

/**
 * Fetches user data with unclaimed missions count
 * @param {string} userId - The user's ID (odId)
 * @returns {Promise<Object|null>} User object with unclaimedMissionsCount
 */
async function getUserWithMissionsCount(userId) {
  if (!supabase || !userId) {
    return null;
  }

  try {
    // Fetch user data from users table
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    if (userError) {
      console.error('[getUserWithMissionsCount] User fetch error:', userError);
      return null;
    }

    // Get unclaimed missions count
    const unclaimedMissionsCount = await getUnclaimedMissionsCount(userId);

    // Return user object with unclaimedMissionsCount
    return {
      ...user,
      unclaimedMissionsCount,
    };
  } catch (error) {
    console.error('[getUserWithMissionsCount] Exception:', error);
    return null;
  }
}

// ============= API ENDPOINTS =============

/**
 * GET /api/user/profile
 * Returns user profile with unclaimed missions count
 * Query params: userId (required)
 */
app.get('/api/user/profile', async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({
        error: 'Missing userId parameter',
        code: 'MISSING_USER_ID',
      });
    }

    const user = await getUserWithMissionsCount(userId);

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND',
      });
    }

    res.status(200).json(user);
  } catch (error) {
    console.error('[GET /api/user/profile] Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /api/user/profile
 * Returns user profile with unclaimed missions count
 * Body: { userId: string }
 */
app.post('/api/user/profile', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        error: 'Missing userId in request body',
        code: 'MISSING_USER_ID',
      });
    }

    const user = await getUserWithMissionsCount(userId);

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND',
      });
    }

    res.status(200).json(user);
  } catch (error) {
    console.error('[POST /api/user/profile] Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
});

const PORT = process.env.PORT || 3001;
const server = http.createServer(app);

// ============= SOCKET.IO SETUP =============
const allowedOrigins = [
  'http://localhost:3000',
  'https://futduel.com',
  'https://www.futduel.com',
  'https://app.futduel.com'
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
const DRAFT_ROUNDS = [1, 2, 3, 4];
const draftQueueByRound = new Map(DRAFT_ROUNDS.map((round) => [round, []]));

// Games map: gameId -> game
// game = {
//   id,
//   players: [
//     { odId, username, socketId, accepted, score, rp, connected },
//     { odId, username, socketId, accepted, score, rp, connected },
//   ],
//   scores: Record<odId, number>,
//   usedCards: Record<odId, number[]>, // Independent decks per player
//   currentRound: RoundInfo,
//   roundNumber: number,
//   maxRounds: number,
//   moves: Record<odId, MoveInfoWithCard>,
//   isStarted: boolean,
//   isFinished: boolean,
//   ended: boolean,
//   phase: 'lobby' | 'playing' | 'reveal' | 'ended',
//   roundTimer: Timeout | null,
//   lastRoundCompletedPayload: object | null,
//   lastGameEndedPayload: object | null,
//   players[].disconnectGraceTimer: Timeout | null,
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

// Configs — keep in sync with mobile client
const DISCONNECT_GRACE_MS = 25_000; // slightly above client OPPONENT_INACTIVITY_MS (23000)
const ROUND_TIME_MS = 15_000; // client ROUND_TIME
const ROUND_REVEAL_MS = 3_000;
const MAX_ROUNDS = 7;

// Very simple RP values (tweak freely)
const RP_WIN = 20;
const RP_LOSS = -15;
const RP_FORFEIT_LOSS = -25;
const RP_OPP_DISCONNECT_WIN = 25;

// ============= GAME ROUND / LOGIC HELPERS =============

// Stats configuration for dynamic question generation
const GK_STATS = ['DIV', 'HAN', 'KIC', 'REF', 'SPE', 'POS'];
const FIELD_STATS = ['PAC', 'SHO', 'PAS', 'DRI', 'DEF', 'PHY'];

// Maps server round stat codes to player object keys (matches mobile game.tsx)
const SERVER_STAT_TO_LOCAL = {
  PAC: 'pace',
  SHO: 'shooting',
  PAS: 'passing',
  DRI: 'dribbling',
  DEF: 'defense',
  PHY: 'physical',
  DIV: 'gk_diving',
  HAN: 'gk_handling',
  KIC: 'gk_kicking',
  REF: 'gk_reflexes',
  SPE: 'gk_speed',
  POS: 'gk_positioning',
};

function mapDbPlayer(p) {
  return {
    id: p.id,
    overall: p.overall,
    position: p.position,
    name: p.name,
    nationality: p.nationality ?? p.nation,
    pace: p.pace,
    shooting: p.shooting,
    passing: p.passing,
    dribbling: p.dribbling,
    defense: p.defending ?? p.defense,
    physical: p.physical,
    gk_diving: p.gk_diving,
    gk_handling: p.gk_handling,
    gk_kicking: p.gk_kicking,
    gk_reflexes: p.gk_reflexes,
    gk_speed: p.gk_speed,
    gk_positioning: p.gk_positioning,
    image_url: p.image_url,
    flag_url: p.flag_url,
  };
}

async function fetchPlayerSquad(odId) {
  if (!supabase || !odId) return null;

  const { data: squadRows, error: squadError } = await supabase
    .from('user_squads')
    .select('player_id')
    .eq('user_id', odId);

  if (squadError || !squadRows?.length) {
    return null;
  }

  const playerIds = squadRows.map((r) => r.player_id);
  const { data: players, error: playersError } = await supabase
    .from('players')
    .select('*')
    .in('id', playerIds);

  if (playersError || !players?.length) {
    return null;
  }

  return players.map(mapDbPlayer);
}

function getPlayerSquad(game, odId) {
  const player = getPlayer(game, odId);
  if (player?.squad?.length) return player.squad;
  return game.playerSquads?.[odId] || null;
}

function setPlayerSquad(game, odId, squad) {
  const player = getPlayer(game, odId);
  if (!game.playerSquads) {
    game.playerSquads = {};
  }

  if (Array.isArray(squad) && squad.length > 0) {
    if (player) player.squad = squad;
    game.playerSquads[odId] = squad;
    return;
  }

  if (getPlayerSquad(game, odId)?.length) {
    return;
  }

  fetchPlayerSquad(odId)
    .then((loaded) => {
      if (!loaded?.length) return;
      if (player) player.squad = loaded;
      game.playerSquads[odId] = loaded;
    })
    .catch((err) => {
      console.error('[setPlayerSquad]', odId, err);
    });
}

function getStatValueForRound(card, roundStat) {
  const statKey = SERVER_STAT_TO_LOCAL[roundStat] || String(roundStat).toLowerCase();
  return card?.[statKey] ?? 0;
}

function buildAutoPickMove(game, odId, squad) {
  const gkRound = !!game.currentRound?.isGKRound;
  const used = game.usedCards[odId] || [];

  const available = squad.filter((c) => {
    if (used.includes(c.id)) return false;
    const cardIsGK = String(c.position || '').toUpperCase() === 'GK';
    return gkRound ? cardIsGK : !cardIsGK;
  });
  const fallback = squad.filter((c) => !used.includes(c.id));
  const pool = available.length > 0 ? available : fallback;
  if (pool.length === 0) return null;

  const roundStat = game.currentRound.stat;
  const card = pool.reduce((best, c) =>
    getStatValueForRound(c, roundStat) > getStatValueForRound(best, roundStat) ? c : best,
  );
  const statValue = getStatValueForRound(card, roundStat);

  return {
    odId,
    cardId: card.id,
    statValue,
    cardData: card,
  };
}

function hasDisconnectedPlayerWithoutMove(game) {
  return game.players.some((p) => !p.connected && !game.moves[p.odId]);
}

async function ensureAutoPicksForMissingMoves(game) {
  const odIds = game.players.map((p) => p.odId);

  for (const odId of odIds) {
    if (game.moves[odId]) continue;

    const player = getPlayer(game, odId);
    // Never auto-pick for disconnected players — grace/forfeit handles them
    if (!player?.connected) continue;

    let squad = getPlayerSquad(game, odId);
    if (!squad?.length) {
      const loaded = await fetchPlayerSquad(odId);
      if (loaded?.length) {
        setPlayerSquad(game, odId, loaded);
        squad = loaded;
      }
    }
    if (!squad?.length) {
      console.warn(`[auto-pick] No squad for ${odId} in game ${game.id}`);
      continue;
    }

    const move = buildAutoPickMove(game, odId, squad);
    if (move) {
      game.moves[odId] = move;
    }
  }
}

/**
 * Generates a unique set of 7 round questions for a match.
 * Rules:
 * - Round 4 (index 3) is ALWAYS a random GK stat
 * - Other rounds (1-3, 5-7) are randomly selected from FIELD_STATS
 * - No single field stat can appear more than 2 times in one match
 */
function generateMatchQuestions() {
  const questions = [];
  const statCount = {}; // Track how many times each field stat has been used
  
  for (let i = 0; i < 7; i++) {
    let stat;
    let isGKRound = false;
    
    if (i === 3) {
      // Round 4 (index 3) - GK round: pick a random GK stat
      isGKRound = true;
      stat = GK_STATS[Math.floor(Math.random() * GK_STATS.length)];
    } else {
      // Field stat round - pick a random stat that hasn't been used more than once (max 2 times total)
      const availableStats = FIELD_STATS.filter(s => (statCount[s] || 0) < 2);
      stat = availableStats[Math.floor(Math.random() * availableStats.length)];
      // Track field stat usage (only for non-GK rounds)
      statCount[stat] = (statCount[stat] || 0) + 1;
    }
    
    questions.push({
      round: i + 1,
      stat: stat,
      isGKRound: isGKRound,
    });
  }
  
  return questions;
}

/**
 * Gets round info from a game's pre-generated questions array.
 * @param {Object} game - The game object containing the questions array
 * @param {number} roundNumber - The 1-indexed round number
 * @returns {Object} Round info with round, stat, and isGKRound
 */
function getRoundInfoFromGame(game, roundNumber) {
  const idx = roundNumber - 1;
  if (game.questions && game.questions[idx]) {
    return game.questions[idx];
  }
  // Fallback (should not happen in normal flow)
  console.warn(`[getRoundInfoFromGame] No questions found for round ${roundNumber}, generating fallback`);
  return { round: roundNumber, stat: 'PAC', isGKRound: false };
}

function createInitialRound(game) {
  return getRoundInfoFromGame(game, 1);
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

function getPlayer(game, odId) {
  const idx = getPlayerIndex(game, odId);
  return idx === -1 ? null : game.players[idx];
}

function clearPlayerDisconnectGrace(player) {
  if (!player) return;
  if (player.disconnectGraceTimer) {
    clearTimeout(player.disconnectGraceTimer);
    player.disconnectGraceTimer = null;
  }
}

function clearAllDisconnectGraceTimers(game) {
  if (!game) return;
  game.players.forEach(clearPlayerDisconnectGrace);
}

function clearRoundTimer(game) {
  if (!game) return;
  if (game.roundTimer) {
    clearTimeout(game.roundTimer);
    game.roundTimer = null;
  }
}

function scheduleRoundTimer(game) {
  if (!game || game.isFinished || !game.isStarted || game.phase === 'reveal') return;

  clearRoundTimer(game);
  const startedAt = game.currentRoundStartedAt ?? Date.now();
  const remaining = Math.max(0, ROUND_TIME_MS - (Date.now() - startedAt));

  game.roundTimer = setTimeout(() => {
    const current = games.get(game.id);
    if (!current || current.isFinished || !current.isStarted || current.phase === 'reveal') {
      return;
    }
    void resolveRoundAuthoritative(current);
  }, remaining);
}

function buildGameStatePayload(game, odId) {
  return {
    gameId: game.id,
    currentRound: {
      ...game.currentRound,
      startedAt: game.currentRoundStartedAt ?? Date.now(),
    },
    scores: computeScoresFromGame(game),
    usedCards: game.usedCards[odId] || [],
  };
}

function emitGameStateToPlayer(game, odId) {
  const player = getPlayer(game, odId);
  if (!player?.socketId) return;
  io.to(player.socketId).emit('game-state', buildGameStatePayload(game, odId));
}

function sendAuthoritativeStateToSocket(socket, game, odId) {
  if (game.isFinished && game.lastGameEndedPayload) {
    socket.emit('game-ended', game.lastGameEndedPayload);
    return;
  }
  if (game.phase === 'reveal' && game.lastRoundCompletedPayload) {
    socket.emit('round-completed', game.lastRoundCompletedPayload);
    return;
  }
  if (game.isStarted) {
    socket.emit('game-state', buildGameStatePayload(game, odId));
  }
}

function bindSocketToGame(socket, gameId, odId) {
  socket.join(gameId);
  socketToUser.set(socket.id, odId);
  userToSocket.set(odId, socket.id);
  socketToGameId.set(socket.id, gameId);
  userToGameId.set(odId, gameId);
}

function startPlayerDisconnectGrace(game, odId) {
  const player = getPlayer(game, odId);
  if (!player) return;

  clearPlayerDisconnectGrace(player);
  player.connected = false;

  player.disconnectGraceTimer = setTimeout(() => {
    const current = games.get(game.id);
    if (!current || current.isFinished) return;

    const currentPlayer = getPlayer(current, odId);
    if (!currentPlayer || currentPlayer.connected) return;

    const opponentOdId = getOpponentOdId(current, odId);
    finishGame(current, {
      reason: 'opponent-disconnected',
      forfeiterUserId: odId,
      winnerOdId: opponentOdId,
      loserOdId: odId,
    });
  }, DISCONNECT_GRACE_MS);
}

// ============= MATCHMAKING HELPERS =============

function removeFromQueueBySocket(socketId) {
  const idx = queue.findIndex((p) => p.socketId === socketId);
  if (idx !== -1) {
    queue.splice(idx, 1);
  }
}

function removeFromDraftQueueBySocket(socketId) {
  for (const draftQueue of draftQueueByRound.values()) {
    const idx = draftQueue.findIndex((p) => p.socketId === socketId);
    if (idx !== -1) {
      draftQueue.splice(idx, 1);
    }
  }
}

function removeFromAllQueuesBySocket(socketId) {
  removeFromQueueBySocket(socketId);
  removeFromDraftQueueBySocket(socketId);
}

function createMatchFromQueueEntries(p1, p2, { mode = 'normal', round = null } = {}) {
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
      lastSeenAt: Date.now(),
      disconnectGraceTimer: null,
      squad: null,
    },
    {
      odId: p2.odId,
      username: p2.username,
      socketId: p2.socketId,
      accepted: false,
      score: 0,
      rp: 0,
      connected: true,
      lastSeenAt: Date.now(),
      disconnectGraceTimer: null,
      squad: null,
    },
  ];

  // Generate unique dynamic questions for this match
  const questions = generateMatchQuestions();
  console.log(`[Match ${gameId}] Generated questions:`, questions.map(q => `R${q.round}:${q.stat}${q.isGKRound ? '(GK)' : ''}`).join(', '));

  const game = {
    id: gameId,
    mode, // 'normal' | 'draft' — forfeit cezası/geçmiş kaydında draft'ı ayırmak için
    round, // draft turu (varsa)
    players,
    scores: { [p1.odId]: 0, [p2.odId]: 0 },
    usedCards: { [p1.odId]: [], [p2.odId]: [] }, // Independent decks per player
    questions, // Dynamic questions array for this match
    currentRound: null, // Will be set after game object is created
    roundNumber: 1,
    maxRounds: MAX_ROUNDS,
    moves: {},
    isStarted: false,
    isFinished: false,
    ended: false,
    phase: 'lobby',
    roundTimer: null,
    lastRoundCompletedPayload: null,
    lastGameEndedPayload: null,
    playerSquads: {},
  };

  // Set initial round from the generated questions
  game.currentRound = createInitialRound(game);

  games.set(gameId, game);

  // Map relationships
  socketToGameId.set(p1.socketId, gameId);
  socketToGameId.set(p2.socketId, gameId);
  userToGameId.set(p1.odId, gameId);
  userToGameId.set(p2.odId, gameId);

  // Notify both players of match-found
  const payloadFor = (opponent, isHost) => {
    const payload = {
      gameId,
      opponent: {
        id: opponent.odId,
        username: opponent.username,
      },
      isHost,
    };

    if (mode === 'draft') {
      payload.mode = 'draft';
      payload.round = round;
      payload.opponent.rank_score = opponent.rank_score ?? null;
      payload.opponent.avatar_key = opponent.avatar_key ?? null;
    }

    return payload;
  };

  // p1 is host (isHost = true), p2 is guest
  io.to(p1.socketId).emit('match-found', payloadFor(p2, true));
  io.to(p2.socketId).emit('match-found', payloadFor(p1, false));
}

function tryMatchPlayers() {
  while (queue.length >= 2) {
    const p1 = queue.shift();
    const p2 = queue.shift();
    if (!p1 || !p2) break;
    createMatchFromQueueEntries(p1, p2, { mode: 'normal' });
  }
}

function tryMatchDraftPlayers(round) {
  const roundQueue = draftQueueByRound.get(round);
  if (!roundQueue) return;

  while (roundQueue.length >= 2) {
    const p1 = roundQueue.shift();
    const p2 = roundQueue.shift();
    if (!p1 || !p2) break;
    createMatchFromQueueEntries(p1, p2, { mode: 'draft', round });
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
  game.phase = 'playing';
  // Record when the first round actually started being played
  game.currentRoundStartedAt = Date.now();

  const gameStartedPayload = {
    gameId: game.id,
    players: game.players.map((p) => ({
      odId: p.odId,
      username: p.username,
    })),
    currentRound: {
      ...game.currentRound,
      startedAt: game.currentRoundStartedAt,
    },
  };

  io.to(game.id).emit('game-started', gameStartedPayload);

  // Initial game-state (per-player usedCards)
  emitGameState(game);
  scheduleRoundTimer(game);
}

function emitGameState(game) {
  game.players.forEach((p) => {
    emitGameStateToPlayer(game, p.odId);
  });
}

// ============= ROUND RESOLUTION / END GAME =============

function completeRound(game) {
  if (!game || game.isFinished || game.phase === 'reveal') return;

  // Do not resolve a round while a disconnected player still owes a move
  if (hasDisconnectedPlayerWithoutMove(game)) return;

  const odIds = game.players.map((p) => p.odId);
  const moveA = game.moves[odIds[0]];
  const moveB = game.moves[odIds[1]];

  let roundWinnerOdId = null;
  if (moveA && moveB) {
    if (moveA.statValue === moveB.statValue) {
      roundWinnerOdId = null;
    } else if (moveA.statValue > moveB.statValue) {
      roundWinnerOdId = odIds[0];
    } else {
      roundWinnerOdId = odIds[1];
    }
  } else if (moveA) {
    roundWinnerOdId = odIds[0];
  } else if (moveB) {
    roundWinnerOdId = odIds[1];
  }

  clearRoundTimer(game);
  game.phase = 'reveal';

  // Add +1 to winner's score (draw = 0 points)
  if (roundWinnerOdId) {
    const winnerIdx = getPlayerIndex(game, roundWinnerOdId);
    if (winnerIdx !== -1) {
      game.players[winnerIdx].score += 1;
      game.scores[roundWinnerOdId] = game.players[winnerIdx].score;
    }
  }

  // Update usedCards - add each player's card to their own array
  odIds.forEach((id) => {
    const mv = game.moves[id];
    if (mv && typeof mv.cardId === 'number') {
      // Initialize array if it doesn't exist
      if (!game.usedCards[id]) {
        game.usedCards[id] = [];
      }
      // Add card to player's own usedCards array (independent decks)
      if (!game.usedCards[id].includes(mv.cardId)) {
        game.usedCards[id].push(mv.cardId);
      }
    }
  });

  const scores = computeScoresFromGame(game);

  // Check if game is over - strictly wait until all 7 rounds are completed
  let isGameOver = false;
  let finalWinner = null;

  // Game ends ONLY after the 7th round is resolved
  // roundNumber is the current round being played, so after round 7 resolves, roundNumber will be 7
  if (game.roundNumber >= game.maxRounds) {
    isGameOver = true;
    const p0 = game.players[0];
    const p1 = game.players[1];
    
    // Determine winner based on final scores
    if (p0.score > p1.score) {
      finalWinner = p0.odId;
    } else if (p1.score > p0.score) {
      finalWinner = p1.odId;
    } else {
      finalWinner = null; // Draw
    }
  }

  // Calculate next round info for payload (without updating game state yet)
  let nextRound = null;
  if (!isGameOver) {
    const nextRoundNumber = game.roundNumber + 1;
    nextRound = getRoundInfoFromGame(game, nextRoundNumber);
  }

  // Construct RoundCompletedPayload (using CURRENT round info)
  // Ensure both players receive full card data (cardData) of opponent's card
  // (moveA and moveB are already declared above)
  
  const movesPayload = {};
  if (moveA) {
    movesPayload[odIds[0]] = {
      odId: moveA.odId,
      cardId: moveA.cardId,
      statValue: moveA.statValue,
      cardData: moveA.cardData || null,
    };
  }
  if (moveB) {
    movesPayload[odIds[1]] = {
      odId: moveB.odId,
      cardId: moveB.cardId,
      statValue: moveB.statValue,
      cardData: moveB.cardData || null,
    };
  }

  const roundPayload = {
    round: game.currentRound.round,
    stat: game.currentRound.stat,
    isGKRound: game.currentRound.isGKRound,
    moves: movesPayload,
    roundWinner: roundWinnerOdId,
    damage: 0,
    scores,
    isGameOver,
    finalWinner,
    nextRound,
  };

  game.lastRoundCompletedPayload = roundPayload;
  io.to(game.id).emit('round-completed', roundPayload);

  game.moves = {};

  if (isGameOver) {
    finishGame(game, {
      reason: 'normal',
      winnerOdId: finalWinner,
    });
  } else {
    setTimeout(() => {
      const currentGame = games.get(game.id);
      if (!currentGame || currentGame.isFinished) return;

      currentGame.roundNumber += 1;
      currentGame.currentRound = getRoundInfoFromGame(currentGame, currentGame.roundNumber);
      currentGame.currentRoundStartedAt = Date.now();
      currentGame.phase = 'playing';

      emitGameState(currentGame);
      scheduleRoundTimer(currentGame);
    }, ROUND_REVEAL_MS);
  }
}

function resolveRoundIfReady(game) {
  if (!game || game.isFinished || game.phase === 'reveal') return;
  const odIds = game.players.map((p) => p.odId);
  if (!game.moves[odIds[0]] || !game.moves[odIds[1]]) return;
  completeRound(game);
}

async function resolveRoundAuthoritative(game) {
  if (!game || game.isFinished || !game.isStarted || game.phase === 'reveal') return;

  // Disconnected + no move: wait for reconnect or disconnect grace → forfeit (no empty auto-pick)
  if (hasDisconnectedPlayerWithoutMove(game)) return;

  await ensureAutoPicksForMissingMoves(game);

  if (hasDisconnectedPlayerWithoutMove(game)) return;

  const odIds = game.players.map((p) => p.odId);
  const hasA = !!game.moves[odIds[0]];
  const hasB = !!game.moves[odIds[1]];

  if (hasA && hasB) {
    resolveRoundIfReady(game);
    return;
  }

  // Only close with a single move when the missing player is still connected (active timeout)
  completeRound(game);
}

/**
 * Forfeit kesinleştiğinde kaçan oyuncuyu SUNUCU OTORİTESİYLE işler:
 *  1) RP cezasını doğrudan Supabase'e yazar (server_penalize_forfeiter).
 *  2) Kaçanın forfeit_loss maç geçmişi kaydını yazar (server_record_match_history).
 *
 * Kazananın client'ına bağımlı değildir (kaçan oyuncu uygulamayı kapatmış
 * olabilir → /result'a ulaşıp kendi RP cezası ve geçmiş kaydını yazamaz).
 * forfeit_audit ve match_history dedup pencereleri sayesinde, kazananın
 * online olarak yaptığı client çağrılarıyla çift kayıt/çift ceza oluşmaz.
 *
 * Draft maçlarında RP değişmez; bu yüzden draft'ta ceza/geçmiş yazılmaz
 * (mevcut client davranışıyla tutarlı).
 */
async function handleServerForfeit(game, forfeiterOdId, winnerOdId) {
  if (!supabase || !game || !forfeiterOdId) return;
  if (game.mode === 'draft') return; // Draft: RP/geçmiş sunucudan yazılmaz.

  const gameId = game.id;

  // 1) RP cezası — uygulanan rp_loss'u geçmiş kaydında kullanmak için sakla.
  let rpLoss = 0;
  try {
    const { data, error } = await supabase.rpc('server_penalize_forfeiter', {
      p_forfeiter_id: forfeiterOdId,
    });
    if (error) {
      console.error(`[forfeit] game ${gameId} penalty RPC error:`, error.message);
    } else {
      rpLoss = Number(data?.rp_loss) || 0;
      console.log(`[forfeit] game ${gameId} forfeiter ${forfeiterOdId} penalty:`, data);
    }
  } catch (err) {
    console.error(`[forfeit] game ${gameId} penalty exception:`, err);
  }

  // 2) Kaçan oyuncunun forfeit_loss maç geçmişi.
  try {
    const forfeiterPlayer = getPlayer(game, forfeiterOdId);
    const winnerPlayer = winnerOdId ? getPlayer(game, winnerOdId) : null;

    let oppName = winnerPlayer?.username || 'Opponent';
    let oppAvatar = null;
    let oppRp = null;
    if (winnerOdId) {
      try {
        const { data: prof } = await supabase
          .from('profiles')
          .select('username, avatar_key, rank_score')
          .eq('id', winnerOdId)
          .maybeSingle();
        if (prof) {
          oppName = prof.username || oppName;
          oppAvatar = prof.avatar_key ?? null;
          oppRp = prof.rank_score ?? null;
        }
      } catch (e) {
        // profil çekilemese de geçmiş kaydını username ile yaz.
      }
    }

    const { error: histError } = await supabase.rpc('server_record_match_history', {
      p_user_id: forfeiterOdId,
      p_opponent_name: oppName,
      p_opponent_user_id: winnerOdId || null,
      p_is_bot: false,
      p_opponent_avatar: oppAvatar,
      p_opponent_rp: oppRp,
      p_my_score: forfeiterPlayer?.score ?? 0,
      p_opp_score: winnerPlayer?.score ?? 0,
      p_outcome: 'forfeit_loss',
      p_rp_change: rpLoss > 0 ? -rpLoss : 0,
      p_rounds: null,
      p_match_type: 'competitive',
    });
    if (histError) {
      console.error(`[forfeit] game ${gameId} history RPC error:`, histError.message);
    } else {
      console.log(`[forfeit] game ${gameId} forfeiter ${forfeiterOdId} history recorded`);
    }
  } catch (err) {
    console.error(`[forfeit] game ${gameId} history exception:`, err);
  }
}

function finishGame(game, { reason, winnerOdId, loserOdId, forfeiterUserId } = {}) {
  if (!game || game.isFinished) return;
  game.isFinished = true;
  game.ended = true;
  game.phase = 'ended';

  clearRoundTimer(game);
  clearAllDisconnectGraceTimers(game);

  const odIds = game.players.map((p) => p.odId);
  const scores = computeScoresFromGame(game);

  const isForfeit =
    reason === 'forfeit' || reason === 'opponent-disconnected';

  if (isForfeit) {
    const forfeiter = forfeiterUserId || loserOdId;
    const winner =
      winnerOdId || odIds.find((id) => id !== forfeiter) || null;

    const payload = {
      gameId: game.id,
      isGameOver: true,
      forfeiterUserId: forfeiter || '',
      winnerUserId: winner || '',
      scores,
      reason: reason === 'forfeit' ? 'forfeit' : 'opponent-disconnected',
      winner: winner || '',
      loser: forfeiter || '',
      rpChange: calculateRpChange(winner, forfeiter, reason),
    };

    game.lastGameEndedPayload = payload;
    io.to(game.id).emit('game-ended', payload);

    // Sunucu-otoriter: kaçan oyuncunun RP cezası + forfeit_loss maç geçmişi.
    // (Kazananın client'ı game-ended ile penalize_forfeiter + kendi forfeit_win
    // geçmişini de yazar; forfeit_audit / match_history dedup'ı sayesinde çift
    // ceza ya da çift kayıt olmaz.)
    if (forfeiter) {
      void handleServerForfeit(game, forfeiter, winner);
    }
  } else {
    if (!winnerOdId && reason === 'normal') {
      const p0 = game.players[0];
      const p1 = game.players[1];
      if (p0.score > p1.score) winnerOdId = p0.odId;
      else if (p1.score > p0.score) winnerOdId = p1.odId;
      else winnerOdId = null;
    }

    if (!loserOdId && winnerOdId) {
      loserOdId = odIds.find((id) => id !== winnerOdId) || null;
    }

    const rpChange = calculateRpChange(winnerOdId, loserOdId, reason);

    const payload = {
      gameId: game.id,
      isGameOver: true,
      scores,
      winnerUserId: winnerOdId || '',
      winner: winnerOdId || '',
      loser: loserOdId || '',
      reason: 'normal',
      rpChange,
    };

    game.lastGameEndedPayload = payload;
    io.to(game.id).emit('game-ended', payload);
  }

  game.players.forEach((p) => {
    if (!p) return;
    if (p.socketId) {
      socketToGameId.delete(p.socketId);
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

    removeFromAllQueuesBySocket(socket.id);

    const odId = socketToUser.get(socket.id);
    const gameId = socketToGameId.get(socket.id);

    socketToUser.delete(socket.id);
    socketToGameId.delete(socket.id);
    if (odId) {
      userToSocket.delete(odId);
    }

    if (!gameId || !odId) return;
    const game = games.get(gameId);
    if (!game || game.isFinished) return;

    const player = getPlayer(game, odId);
    if (!player) return;

    io.to(game.id).emit('opponent-disconnected', {
      username: player.username,
    });

    startPlayerDisconnectGrace(game, odId);
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

    // Avoid duplicate entries across all queue pools
    removeFromAllQueuesBySocket(socket.id);
    queue.push({ socketId: socket.id, odId, username });

    const position = queue.findIndex((p) => p.socketId === socket.id) + 1;
    const queueSize = queue.length;

    socket.emit('queue-joined', { position, queueSize });

    tryMatchPlayers();
  });

  // { userId, username, round, rank_score?, avatar_key? }
  socket.on('join-draft-queue', (data) => {
    const { userId, username, round, rank_score, avatar_key } = data || {};
    if (!userId || !username || !draftQueueByRound.has(round)) {
      socket.emit('game-error', {
        message: 'Missing userId, username, or valid round',
        code: 'INVALID_DRAFT_QUEUE_PAYLOAD',
      });
      return;
    }

    socketToUser.set(socket.id, userId);
    userToSocket.set(userId, socket.id);

    // Avoid duplicate entries across all queue pools
    removeFromAllQueuesBySocket(socket.id);

    const draftQueue = draftQueueByRound.get(round);
    draftQueue.push({
      socketId: socket.id,
      odId: userId,
      username,
      rank_score,
      avatar_key,
    });

    const position = draftQueue.findIndex((p) => p.socketId === socket.id) + 1;
    const queueSize = draftQueue.length;
    socket.emit('queue-joined', { mode: 'draft', round, position, queueSize });

    tryMatchDraftPlayers(round);
  });

  socket.on('leave-queue', () => {
    removeFromAllQueuesBySocket(socket.id);
    socket.emit('queue-left');
  });

  // --------- MATCH ACCEPTANCE: player-accepted ---------

  // { gameId }
  socket.on('player-accepted', (data) => {
    const { gameId } = data || {};
    if (!gameId) return;

    const game = games.get(gameId);
    if (!game) {
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

    socket.join(gameId);

    if (game.isFinished) {
      sendAuthoritativeStateToSocket(socket, game, odId);
      return;
    }

    game.players[idx].accepted = true;
    maybeStartGame(game);
  });

  // --------- JOIN GAME ROOM: join-game ---------

  // { gameId, odId, username, squad? }
  socket.on('join-game', (data) => {
    const { gameId, odId, username, squad } = data || {};
    if (!gameId || !odId) {
      socket.emit('game-error', {
        message: 'Missing gameId or odId',
        code: 'INVALID_JOIN_GAME_PAYLOAD',
        gameId,
      });
      return;
    }

    const game = games.get(gameId);
    if (!game) {
      socket.emit('game-error', {
        message: 'Game not found',
        code: 'GAME_NOT_FOUND',
        gameId,
      });
      return;
    }

    const idx = getPlayerIndex(game, odId);
    if (idx === -1) {
      socket.emit('game-error', {
        message: 'Player not part of this game',
        code: 'NOT_IN_GAME',
        gameId,
      });
      return;
    }

    bindSocketToGame(socket, gameId, odId);

    const player = game.players[idx];
    if (username) {
      player.username = username;
    }

    clearPlayerDisconnectGrace(player);
    player.socketId = socket.id;
    player.connected = true;
    player.lastSeenAt = Date.now();

    setPlayerSquad(game, odId, squad);

    socket.emit('game-joined', {
      gameId,
      odId,
      playerIndex: idx,
    });

    sendAuthoritativeStateToSocket(socket, game, odId);
  });

  // --------- LEAVE GAME (FORFEIT): leave-game ---------

  // { gameId }
  socket.on('leave-game', (data) => {
    const { gameId } = data || {};
    if (!gameId) return;

    const game = games.get(gameId);
    if (!game) return;

    const odId = socketToUser.get(socket.id);
    if (!odId) return;

    if (game.isFinished) {
      sendAuthoritativeStateToSocket(socket, game, odId);
      return;
    }

    const idx = getPlayerIndex(game, odId);
    if (idx === -1) return;

    const opponentOdId = getOpponentOdId(game, odId);

    finishGame(game, {
      reason: 'forfeit',
      forfeiterUserId: odId,
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
    if (!game) {
      socket.emit('move-error', {
        message: 'Game not available',
        code: 'GAME_NOT_AVAILABLE',
      });
      return;
    }

    if (game.isFinished) {
      sendAuthoritativeStateToSocket(socket, game, odId);
      return;
    }

    if (!game.isStarted) {
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

    // Prevent multiple moves per round - check if player already submitted for current round
    if (game.moves[odId]) {
      socket.emit('move-error', {
        message: 'Move already submitted for this round',
        code: 'MOVE_ALREADY_SUBMITTED',
      });
      return;
    }

    // Validate card against player's own usedCards list (independent decks)
    // Check if this player has already used this card in a previous round
    if (!game.usedCards[odId]) {
      game.usedCards[odId] = [];
    }
    if (game.usedCards[odId].includes(cardId)) {
      socket.emit('move-error', {
        message: 'Card already used in this game',
        code: 'CARD_ALREADY_USED',
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

    socket.to(gameId).emit('opponent-moved');

    // Attempt to resolve round if both moves present
    resolveRoundIfReady(game);
  });
});

// ============= START SERVER =============
server.listen(PORT, () => {
  console.log(`Socket.io server running on port ${PORT}`);
});
