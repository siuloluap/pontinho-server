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
const DISCARD_CLAIM_SECONDS = 8;

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
