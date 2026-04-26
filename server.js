// ─── Pontinho Multiplayer Server ─────────────────────────────────────────────
// Install: npm install express socket.io cors
// Run:     node server.js
// Deploy:  Railway / Render / Fly.io (free tier)

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const PORT = process.env.PORT || 3001;

// ─── Game Logic (mirrored from client) ───────────────────────────────────────
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
const RANK_VALUES = { A:15, 2:2, 3:3, 4:4, 5:5, 6:6, 7:7, 8:8, 9:9, 10:10, J:10, Q:10, K:10 };
const DISCARD_CLAIM_SECONDS = 12;

function buildDoubleDeck() {
  const deck = []; let id = 0;
  for (let d = 0; d < 2; d++) {
    for (const suit of SUITS)
      for (const rank of RANKS)
        deck.push({ id: id++, rank, suit, isJoker: false, isWild: false });
    deck.push({ id: id++, rank: "JK", suit: "★", isJoker: true, isWild: true });
    deck.push({ id: id++, rank: "JK", suit: "★", isJoker: true, isWild: true });
  }
  return deck;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function markWilds(deck, cutCard) {
  if (!cutCard) return deck;
  const rankIdx = RANKS.indexOf(cutCard.rank);
  const wildRank = RANKS[(rankIdx + 1) % RANKS.length];
  const wildSuit = cutCard.suit;
  return deck.map(c => ({ ...c, isWild: c.isJoker || (c.rank === wildRank && c.suit === wildSuit) }));
}

function cardPoints(card) {
  if (card.isWild) return 20;
  return RANK_VALUES[card.rank] || 0;
}

function getRankIndex(rank) { return RANKS.indexOf(rank); }

function runIndices(nonWild) {
  const hasAce = nonWild.some(c => c.rank === "A");
  const hasLowCard = nonWild.some(c => ["2","3","4","5","6","7"].includes(c.rank));
  if (hasAce && !hasLowCard && nonWild.some(c => ["9","10","J","Q","K"].includes(c.rank)))
    return nonWild.map(c => c.rank === "A" ? 13 : getRankIndex(c.rank));
  return nonWild.map(c => getRankIndex(c.rank));
}

function canFormSequence(cards) {
  const nonWild = cards.filter(c => !c.isWild);
  if (!nonWild.length) return false;
  const wildCount = cards.filter(c => c.isWild).length;
  if (!nonWild.map(c => c.suit).every(s => s === nonWild[0].suit)) return false;
  if (nonWild.filter(c => c.rank === "A").length > 1) return false;
  const rc = {}; for (const c of nonWild) rc[c.rank] = (rc[c.rank] || 0) + 1;
  if (Object.values(rc).some(v => v > 1)) return false;
  const sorted = [...nonWild].sort((a, b) => getRankIndex(a.rank) - getRankIndex(b.rank));
  const indices = runIndices(sorted).sort((a, b) => a - b);
  const span = indices[indices.length-1] - indices[0];
  const gaps = span - (nonWild.length - 1);
  return gaps <= wildCount && cards.length >= 3;
}

function wildIsInCenter(cards) {
  let effective = cards;
  const specialWilds = cards.filter(c => c.isWild && !c.isJoker);
  if (specialWilds.length > 0) {
    for (const sw of specialWilds) {
      const asNormal = cards.map(c => c.id === sw.id ? { ...c, isWild: false } : c);
      const nw = asNormal.filter(c => !c.isWild);
      if (nw.length >= 2) { effective = asNormal; break; }
    }
  }
  const nonWild = effective.filter(c => !c.isWild).sort((a, b) => getRankIndex(a.rank) - getRankIndex(b.rank));
  if (nonWild.length < 2) return false;
  const indices = runIndices(nonWild).sort((a, b) => a - b);
  const span = indices[indices.length-1] - indices[0];
  return (span - (nonWild.length - 1)) >= 1;
}

function isValidMeld(cards, isBaterRound) {
  if (cards.length < 3) return false;
  const specialWilds = cards.filter(c => c.isWild && !c.isJoker);
  if (specialWilds.length > 0) {
    for (const sw of specialWilds) {
      const asNormal = cards.map(c => c.id === sw.id ? { ...c, isWild: false } : c);
      const result = isValidMeld(asNormal, isBaterRound);
      if (result) return result;
    }
  }
  const nonWild = cards.filter(c => !c.isWild);
  const wildCount = cards.filter(c => c.isWild).length;
  if (wildCount > 1) return false;
  if (nonWild.length >= 2) {
    const ranks = nonWild.map(c => c.rank);
    if (ranks.every(r => r === ranks[0]) && cards.length <= 6) {
      const suitCount = {};
      for (const c of nonWild) suitCount[c.suit] = (suitCount[c.suit] || 0) + 1;
      if (Object.keys(suitCount).length <= 3 && Math.max(...Object.values(suitCount)) <= 2) {
        if (wildCount > 0 && !isBaterRound) return false;
        return "set";
      }
    }
  }
  if (nonWild.length >= 2) {
    const suits = nonWild.map(c => c.suit);
    if (suits.every(s => s === suits[0]) && canFormSequence(cards)) {
      if (wildCount > 0 && !isBaterRound && !wildIsInCenter(cards)) return false;
      return "run";
    }
  }
  return false;
}

function normalizeWildsInMeld(cards) {
  // For each non-joker wild, check if it can act as its real card value
  return cards.map(c => {
    if (!c.isWild || c.isJoker) return c;
    // Try using it as its real value
    const asNormal = { ...c, isWild: false };
    const testCards = cards.map(x => x.id === c.id ? asNormal : x);
    if (isValidMeld(testCards, true)) {
      return { ...c, actingAsNormal: true };
    }
    return c;
  });
}

function tryDisplaceWild(meldCards, newCard) {
  // Check if newCard can replace a wild in the meld
  // Returns { newMeldCards, displacedWild } or null
  for (let i = 0; i < meldCards.length; i++) {
    const c = meldCards[i];
    // Consider both isWild cards and actingAsNormal wilds
    if (!c.isWild && !c.actingAsNormal) continue;
    // Try replacing this wild with newCard
    const testMeld = meldCards.map((x, j) => {
      if (j === i) return newCard;
      // Restore actingAsNormal cards to their wild state for testing
      if (x.actingAsNormal) return { ...x, isWild: true, actingAsNormal: false };
      return x;
    });
    if (isValidMeld(testMeld, false)) {
      // Valid! displaced wild goes back to hand (restore to wild state)
      const displaced = { ...c, isWild: true, actingAsNormal: false };
      return { newMeldCards: meldCards.map((x, j) => j === i ? newCard : x), displacedWild: displaced };
    }
  }
  return null;
}


function sortMeldCards(cards, type) {
  if (type !== "run") return cards;
  const nonWild = cards.filter(c => !c.isWild).sort((a, b) => getRankIndex(a.rank) - getRankIndex(b.rank));
  const wilds = cards.filter(c => c.isWild);
  if (nonWild.length === 0) return cards;
  const idxMap = runIndices(nonWild);
  const pairs = nonWild.map((c, i) => ({ card: c, idx: idxMap[i] })).sort((a, b) => a.idx - b.idx);
  const minIdx = pairs[0].idx;
  const maxIdx = pairs[pairs.length - 1].idx;
  const sorted = [];
  let wi = 0;
  for (let i = minIdx; i <= maxIdx; i++) {
    const p = pairs.find(p => p.idx === i);
    if (p) sorted.push(p.card);
    else if (wi < wilds.length) sorted.push(wilds[wi++]);
  }
  while (wi < wilds.length) sorted.push(wilds[wi++]);
  return sorted;
}


function initRound(playerNames, dealerIdx, scores, wins, round) {
  let deck = shuffle(buildDoubleDeck());
  const cutIdx = Math.floor(deck.length * 0.6) + Math.floor(Math.random() * Math.floor(deck.length * 0.2));
  const cutCard = deck[cutIdx];
  deck = markWilds(deck, cutCard);
  const n = playerNames.length;
  const hands = playerNames.map(() => []);
  let dealPos = (cutIdx + 1) % deck.length;
  const dealt = new Set([cutIdx]);
  for (let c = 0; c < 9; c++) {
    for (let p = 0; p < n; p++) {
      while (dealt.has(dealPos)) dealPos = (dealPos + 1) % deck.length;
      hands[p].push({ ...deck[dealPos] });
      dealt.add(dealPos);
      dealPos = (dealPos + 1) % deck.length;
    }
  }
  const stock = deck.filter((_, i) => !dealt.has(i));
  const firstPlayer = (dealerIdx + 1) % n;
  return {
    phase: "playing",
    players: playerNames.map((name, i) => ({
      name, hand: hands[i], melds: [], socketId: null,
    })),
    stock, discard: [], cutCard,
    dealerPlayer: dealerIdx,
    currentPlayer: firstPlayer,
    turnPhase: "draw",
    meldsThisTurn: 0,
    claimedDiscardCardId: null,
    pendingNextPlayer: null,
    scores: scores || playerNames.map(() => 0),
    wins: wins || playerNames.map(() => 0),
    round: round || 1,
    lastAction: null,
    // Discard claim state
    discardClaim: null, // { card, claimDeadline, claims: [{playerIdx, ts}], timerHandle }
  };
}

// ─── Room Management ──────────────────────────────────────────────────────────
const rooms = {}; // roomCode -> { game, players: [{socketId, name, playerIdx}], chat }

function generateCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function broadcastGameState(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.game) return;
  const g = room.game;

  // Send each player a view with only their own hand visible
  room.players.forEach(({ socketId, playerIdx }) => {
    const playerView = {
      ...g,
      players: g.players.map((p, i) => ({
        ...p,
        hand: i === playerIdx ? p.hand : p.hand.map(() => ({ id: -1, faceDown: true })),
        socketId: undefined,
      })),
      myPlayerIdx: playerIdx,
      discardClaim: g.discardClaim ? {
        card: g.discardClaim.card,
        deadline: g.discardClaim.claimDeadline,
        claims: g.discardClaim.claims,
      } : null,
    };
    io.to(socketId).emit("gameState", playerView);
  });
}

function broadcastChat(roomCode, messages) {
  io.to(roomCode).emit("chatMessages", messages);
}

// ─── Discard Claim Timer ──────────────────────────────────────────────────────
function startDiscardClaim(roomCode, discardedCard, discardingPlayerIdx) {
  const room = rooms[roomCode];
  if (!room) return;

  const deadline = Date.now() + DISCARD_CLAIM_SECONDS * 1000;

  // Clear any existing timer
  if (room.game.discardClaim?.timerHandle) {
    clearTimeout(room.game.discardClaim.timerHandle);
  }

  const discardingPlayerName = room.game.players[discardingPlayerIdx].name;
  room.game.discardClaim = {
    card: discardedCard,
    claimDeadline: deadline,
    discardingPlayerIdx,
    discardingPlayerName,
    claims: [],
    timerHandle: null,
  };

  // Broadcast claim window open
  io.to(roomCode).emit("discardClaimOpen", {
    card: discardedCard,
    deadline,
    discardingPlayerIdx,
    discardingPlayerName,
  });

  // Timer: resolve after 8 seconds
  const handle = setTimeout(() => resolveDiscardClaim(roomCode), DISCARD_CLAIM_SECONDS * 1000);
  room.game.discardClaim.timerHandle = handle;

  broadcastGameState(roomCode);
}

function resolveDiscardClaim(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.game.discardClaim) return;

  const { card, discardingPlayerIdx, claims } = room.game.discardClaim;
  const g = room.game;
  const n = g.players.length;

  // Determine priority order: player after discarding player first
  const priorityOrder = [];
  for (let i = 1; i < n; i++) {
    priorityOrder.push((discardingPlayerIdx + i) % n);
  }

  // Find winner: first in priority order who claimed
  const claimSet = new Set(claims.map(c => c.playerIdx));
  const winner = priorityOrder.find(idx => claimSet.has(idx));

  // Clear timer
  if (room.game.discardClaim.timerHandle) {
    clearTimeout(room.game.discardClaim.timerHandle);
  }
  room.game.discardClaim = null;

  const nextPlayer = (discardingPlayerIdx + 1) % n;

  if (winner !== undefined) {
    // Remove card from discard pile (winner takes it)
    g.discard = g.discard.filter(c => c.id !== card.id);
    g.players[winner].hand.push(card);
    g.claimedDiscardCardId = card.id; // Must use this card in first meld
    g.meldsThisTurn = 0;

    if (winner === nextPlayer) {
      // Next player claimed: normal turn for them (no melo obligation before others)
      g.currentPlayer = winner;
      g.turnPhase = "play";
      g.pendingNextPlayer = null;
      io.to(roomCode).emit("discardClaimResolved", {
        winner, winnerName: g.players[winner].name, card,
        message: `${g.players[winner].name} pescou a carta descartada! Baixe jogos ou descarte.`,
      });
    } else {
      // Other player claimed: they must play a meld FIRST, then next player draws
      g.currentPlayer = winner;
      g.turnPhase = "play";
      g.pendingNextPlayer = nextPlayer; // After winner plays, turn goes here
      io.to(roomCode).emit("discardClaimResolved", {
        winner, winnerName: g.players[winner].name, card,
        message: `${g.players[winner].name} pescou a carta descartada! Deve baixar um jogo antes de ${g.players[nextPlayer].name} jogar.`,
      });
    }
  } else {
    // No claims — card stays on discard, next player's turn
    g.currentPlayer = nextPlayer;
    g.turnPhase = "draw";
    io.to(roomCode).emit("discardClaimResolved", {
      winner: null, card,
      message: `${g.players[nextPlayer].name}, é sua vez! Compre uma carta.`,
    });
  }

  broadcastGameState(roomCode);
}

// ─── Socket.io Events ─────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // ── Create room ──
  socket.on("createRoom", ({ name }) => {
    const code = generateCode();
    rooms[code] = {
      game: null,
      players: [{ socketId: socket.id, name, playerIdx: 0, ready: false }],
      chat: [],
    };
    socket.join(code);
    socket.roomCode = code;
    socket.playerIdx = 0;
    socket.emit("roomCreated", { code, playerIdx: 0, players: [name] });
    console.log(`Room ${code} created by ${name}`);
  });

  // ── Join room ──
  socket.on("joinRoom", ({ code, name }) => {
    const room = rooms[code];
    if (!room) { socket.emit("error", "Sala não encontrada."); return; }
    if (room.game) { socket.emit("error", "Jogo já em andamento."); return; }
    if (room.players.length >= 12) { socket.emit("error", "Sala cheia."); return; }

    const playerIdx = room.players.length;
    room.players.push({ socketId: socket.id, name, playerIdx, ready: false });
    socket.join(code);
    socket.roomCode = code;
    socket.playerIdx = playerIdx;

    const playerNames = room.players.map(p => p.name);
    socket.emit("roomJoined", { code, playerIdx, players: playerNames });
    io.to(code).emit("playerJoined", { players: playerNames });
    console.log(`${name} joined room ${code}`);
  });

  // ── Start game ──
  socket.on("startGame", () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    if (socket.playerIdx !== 0) { socket.emit("error", "Apenas o criador pode iniciar."); return; }
    if (room.players.length < 2) { socket.emit("error", "Precisa de pelo menos 2 jogadores."); return; }

    const names = room.players.map(p => p.name);
    room.game = initRound(names, 0, null, null, 1);

    // Assign socket IDs to players
    room.players.forEach(p => {
      room.game.players[p.playerIdx].socketId = p.socketId;
    });

    io.to(socket.roomCode).emit("gameStarted");
    broadcastGameState(socket.roomCode);
  });

  // ── Draw from stock ──
  socket.on("drawFromStock", () => {
    const room = rooms[socket.roomCode];
    if (!room?.game) return;
    const g = room.game;
    if (g.currentPlayer !== socket.playerIdx) return;
    if (g.turnPhase !== "draw") return;
    if (g.stock.length === 0) return;

    const [drawn, ...rest] = g.stock;
    g.stock = rest;
    g.players[socket.playerIdx].hand.push(drawn);
    g.turnPhase = "play";
    g.meldsThisTurn = 0;
    g.message = g.players[socket.playerIdx].name + ", baixe jogos ou descarte.";

    broadcastGameState(socket.roomCode);
  });

  // ── Claim discard ── (any player can claim during claim window)
  socket.on("claimDiscard", () => {
    const room = rooms[socket.roomCode];
    if (!room?.game?.discardClaim) return;
    const { discardingPlayerIdx, claims } = room.game.discardClaim;
    if (socket.playerIdx === discardingPlayerIdx) return; // can't claim own discard

    // Avoid duplicate claims
    if (claims.some(c => c.playerIdx === socket.playerIdx)) return;
    claims.push({ playerIdx: socket.playerIdx, ts: Date.now() });

    io.to(socket.roomCode).emit("discardClaimUpdate", {
      claims: claims.map(c => ({ playerIdx: c.playerIdx, name: room.game.players[c.playerIdx].name })),
    });
  });

  // ── Discard card ──
  socket.on("discardCard", ({ cardId }) => {
    const room = rooms[socket.roomCode];
    if (!room?.game) return;
    const g = room.game;
    if (g.currentPlayer !== socket.playerIdx) return;
    if (g.turnPhase !== "play") return;

    const cardIdx = g.players[socket.playerIdx].hand.findIndex(c => c.id === cardId);
    if (cardIdx === -1) return;

    const [card] = g.players[socket.playerIdx].hand.splice(cardIdx, 1);
    const won = g.players[socket.playerIdx].hand.length === 0;

    if (won) {
      g.wins[socket.playerIdx]++;
      g.phase = "roundEnd";
      g.message = g.players[socket.playerIdx].name + " BATEU! 🎉";
      g.discardClaim = null;
      g.discard.push(card);
      broadcastGameState(socket.roomCode);
    } else {
      // Put card on discard immediately so all players see it
      g.discard.push(card);
      broadcastGameState(socket.roomCode);
      // Then start claim window
      startDiscardClaim(socket.roomCode, card, socket.playerIdx);
    }
  });

  // ── Play meld ──
  socket.on("playMeld", ({ cardIds }) => {
    const room = rooms[socket.roomCode];
    if (!room?.game) return;
    const g = room.game;
    if (g.currentPlayer !== socket.playerIdx) return;
    if (g.turnPhase !== "play") return;

    const player = g.players[socket.playerIdx];
    const selCards = player.hand.filter(c => cardIds.includes(c.id));
    if (selCards.length < 3) return;

    const remainingAfter = player.hand.filter(c => !cardIds.includes(c.id));
    const isBater = remainingAfter.length === 0 || remainingAfter.length === 1 ||
      g.meldsThisTurn >= 1;

    const type = isValidMeld(selCards, isBater);
    if (!type) {
      socket.emit("error", "Jogo inválido!");
      return;
    }

    player.hand = player.hand.filter(c => !cardIds.includes(c.id));
    player.melds.push({ cards: sortMeldCards(selCards, type), type, owner: socket.playerIdx, order: Date.now() });
    g.meldsThisTurn++;
    g.lastAction = { type: "newMeld", player: player.name, cardIds: new Set(cardIds), meldOrder: player.melds[player.melds.length-1].order, ts: Date.now() };

    const won = player.hand.length === 0;
    if (won) {
      g.wins[socket.playerIdx]++;
      g.phase = "roundEnd";
      g.message = player.name + " BATEU! 🎉";
    }

    broadcastGameState(socket.roomCode);
  });

  // ── Add to meld ──
  socket.on("addToMeld", ({ cardIds, targetPlayerIdx, targetMeldIdx }) => {
    const room = rooms[socket.roomCode];
    if (!room?.game) return;
    const g = room.game;
    if (g.currentPlayer !== socket.playerIdx) return;
    if (g.turnPhase !== "play") return;

    const player = g.players[socket.playerIdx];
    const selCards = player.hand.filter(c => cardIds.includes(c.id));
    if (selCards.length === 0) return;

    const targetMeld = g.players[targetPlayerIdx].melds[targetMeldIdx];
    if (!targetMeld) return;

    const combined = [...targetMeld.cards, ...selCards];
    const remainingAfter = player.hand.filter(c => !cardIds.includes(c.id));
    const isBater = remainingAfter.length === 0 || remainingAfter.length === 1 || g.meldsThisTurn >= 1;

    const type = isValidMeld(combined, isBater);
    if (!type) { socket.emit("error", "Jogo inválido!"); return; }

    player.hand = player.hand.filter(c => !cardIds.includes(c.id));
    g.players[targetPlayerIdx].melds[targetMeldIdx].cards = sortMeldCards(combined, type);
    g.lastAction = { type: "addToMeld", player: player.name, cardIds: new Set(cardIds), meldOrder: targetMeld.order, ts: Date.now() };

    const won = player.hand.length === 0;
    if (won) {
      g.wins[socket.playerIdx]++;
      g.phase = "roundEnd";
      g.message = player.name + " BATEU! 🎉";
    }

    broadcastGameState(socket.roomCode);
  });

  // ── Next round ──
  socket.on("nextRound", () => {
    const room = rooms[socket.roomCode];
    if (!room?.game) return;
    const g = room.game;
    if (g.phase !== "roundEnd") return;

    const newScores = g.players.map((p, i) => g.scores[i] + p.hand.reduce((s, c) => s + cardPoints(c), 0));
    const nextDealer = (g.dealerPlayer + 1) % g.players.length;
    const names = g.players.map(p => p.name);
    const newGame = initRound(names, nextDealer, newScores, g.wins, g.round + 1);

    // Re-assign socket IDs
    room.players.forEach(p => {
      newGame.players[p.playerIdx].socketId = p.socketId;
    });

    room.game = newGame;
    broadcastGameState(socket.roomCode);
  });

  // ── Chat ──
  socket.on("chatMessage", ({ sender, text }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    room.chat.push({ sender, text, time: Date.now() });
    // Keep last 100 messages
    if (room.chat.length > 100) room.chat.shift();
    broadcastChat(socket.roomCode, room.chat);
  });

  // ── Disconnect ──
  socket.on("disconnect", () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (player) {
      io.to(socket.roomCode).emit("playerDisconnected", { name: player.name });
      console.log(`${player.name} disconnected from room ${socket.roomCode}`);
    }
  });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "Pontinho server running 🃏" }));

server.listen(PORT, () => console.log(`Pontinho server on port ${PORT}`));
