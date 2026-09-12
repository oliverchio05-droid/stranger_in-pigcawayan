require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';

// ---------------------------------------------------------------------------
// Tiny JSON "database". Fine for an MVP with modest traffic. Swap for a real
// database (Postgres/Supabase/Firebase) once you have real growth.
// ---------------------------------------------------------------------------
const DB_PATH = path.join(__dirname, 'db.json');
const REPORTS_PATH = path.join(__dirname, 'reports.json');

function loadDb() {
  if (!fs.existsSync(DB_PATH)) return { users: {} };
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return { users: {} };
  }
}
function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
function logReport(entry) {
  let reports = [];
  if (fs.existsSync(REPORTS_PATH)) {
    try { reports = JSON.parse(fs.readFileSync(REPORTS_PATH, 'utf8')); } catch { reports = []; }
  }
  reports.push({ ...entry, at: new Date().toISOString() });
  fs.writeFileSync(REPORTS_PATH, JSON.stringify(reports, null, 2));
}

function getOrCreateUser(db, userId) {
  if (!db.users[userId]) {
    db.users[userId] = {
      id: userId,
      createdAt: new Date().toISOString(),
      matchesUsed: 0,
      reportCount: 0,
      banned: false,
      birthYear: null,
    };
  }
  return db.users[userId];
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
const app = express();
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: FRONTEND_ORIGIN, methods: ['GET', 'POST'] },
});

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

// Register a new anonymous user (called once by the frontend, id then stored
// in localStorage). Requires a birth year so we can enforce a real age gate.
app.post('/api/register', (req, res) => {
  const { birthYear } = req.body || {};
  const currentYear = new Date().getFullYear();
  const age = birthYear ? currentYear - parseInt(birthYear, 10) : 0;

  if (!birthYear || isNaN(age) || age < 18 || age > 100) {
    return res.status(403).json({ error: 'You must be 18 or older to use this site.' });
  }

  const db = loadDb();
  const userId = uuidv4();
  const user = getOrCreateUser(db, userId);
  user.birthYear = parseInt(birthYear, 10);
  saveDb(db);

  res.json({ userId });
});

// Admin: list users for moderation (report counts, ban status).
// Protected by ADMIN_SECRET, passed as a query param from the admin page.
app.get('/api/admin/users', (req, res) => {
  const { adminSecret } = req.query;
  if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const db = loadDb();
  const users = Object.values(db.users)
    .map((u) => ({
      id: u.id,
      referenceCode: u.id.slice(0, 8).toUpperCase(),
      matchesUsed: u.matchesUsed,
      reportCount: u.reportCount,
      banned: u.banned,
      createdAt: u.createdAt,
    }))
    .sort((a, b) => (b.reportCount - a.reportCount) || (new Date(b.createdAt) - new Date(a.createdAt)));
  res.json({ users });
});

// Admin: manually unban a user (e.g. if reports were unfair).
app.post('/api/admin/unban', (req, res) => {
  const { userId, adminSecret } = req.body || {};
  if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const db = loadDb();
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Unknown user' });
  user.banned = false;
  user.reportCount = 0;
  saveDb(db);
  res.json({ success: true });
});

// Admin: manually ban a user directly (e.g. a report came in outside the app).
app.post('/api/admin/ban', (req, res) => {
  const { userId, adminSecret } = req.body || {};
  if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const db = loadDb();
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Unknown user' });
  user.banned = true;
  saveDb(db);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Socket.io: matching queue + WebRTC signaling relay + chat + moderation
// ---------------------------------------------------------------------------
let waitingQueue = []; // { socketId, userId }
const rooms = new Map(); // roomId -> { a: socketId, b: socketId }
const socketToUser = new Map(); // socketId -> userId
const socketToRoom = new Map(); // socketId -> roomId

function removeFromQueue(socketId) {
  waitingQueue = waitingQueue.filter((entry) => entry.socketId !== socketId);
}

function tryMatch() {
  while (waitingQueue.length >= 2) {
    const a = waitingQueue.shift();
    const b = waitingQueue.shift();

    // Don't match someone with themself across duplicate tabs
    if (a.userId === b.userId) {
      waitingQueue.unshift(b);
      continue;
    }

    const roomId = uuidv4();
    rooms.set(roomId, { a: a.socketId, b: b.socketId });
    socketToRoom.set(a.socketId, roomId);
    socketToRoom.set(b.socketId, roomId);

    // Track for stats only — no limit is enforced on this anymore.
    const db = loadDb();
    [a, b].forEach(({ userId }) => {
      const user = getOrCreateUser(db, userId);
      user.matchesUsed += 1;
    });
    saveDb(db);

    io.to(a.socketId).emit('matched', { roomId, initiator: true });
    io.to(b.socketId).emit('matched', { roomId, initiator: false });
  }
}

function leaveRoom(socketId, reason = 'left') {
  const roomId = socketToRoom.get(socketId);
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;

  const partnerId = room.a === socketId ? room.b : room.a;
  io.to(partnerId).emit('partner-left', { reason });

  socketToRoom.delete(room.a);
  socketToRoom.delete(room.b);
  rooms.delete(roomId);
}

io.on('connection', (socket) => {
  socket.on('join-queue', ({ userId }) => {
    if (!userId) return;
    const db = loadDb();
    const user = db.users[userId];
    if (!user) return socket.emit('error-message', 'Please refresh — your session was not found.');
    if (user.banned) return socket.emit('banned');

    socketToUser.set(socket.id, userId);
    removeFromQueue(socket.id); // no duplicates
    waitingQueue.push({ socketId: socket.id, userId });
    socket.emit('queued');
    tryMatch();
  });

  socket.on('signal', (payload) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const partnerId = room.a === socket.id ? room.b : room.a;
    io.to(partnerId).emit('signal', payload);
  });

  socket.on('chat-message', ({ text }) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId || !text) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const partnerId = room.a === socket.id ? room.b : room.a;
    io.to(partnerId).emit('chat-message', { text: String(text).slice(0, 1000) });
  });

  socket.on('skip', () => {
    leaveRoom(socket.id, 'skipped');
    socket.emit('rejoin-check');
  });

  socket.on('report', ({ reason }) => {
    const roomId = socketToRoom.get(socket.id);
    const reporterId = socketToUser.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const partnerSocketId = room.a === socket.id ? room.b : room.a;
    const reportedUserId = socketToUser.get(partnerSocketId);

    logReport({ reporterId, reportedUserId, reason: reason || 'unspecified' });

    if (reportedUserId) {
      const db = loadDb();
      const reported = getOrCreateUser(db, reportedUserId);
      reported.reportCount += 1;
      if (reported.reportCount >= 3) reported.banned = true; // tune this threshold
      saveDb(db);
      if (reported.banned) io.to(partnerSocketId).emit('banned');
    }

    leaveRoom(socket.id, 'reported');
    io.to(partnerSocketId).emit('partner-left', { reason: 'reported' });
  });

  socket.on('leave-chat', () => {
    leaveRoom(socket.id, 'left');
    removeFromQueue(socket.id);
  });

  socket.on('disconnect', () => {
    leaveRoom(socket.id, 'disconnected');
    removeFromQueue(socket.id);
    socketToUser.delete(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Stranger in Pigcawayan server running on port ${PORT}`);
});
