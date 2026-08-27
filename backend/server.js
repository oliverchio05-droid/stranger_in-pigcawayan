require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4000;
const FREE_MATCH_LIMIT = parseInt(process.env.FREE_MATCH_LIMIT || '5', 10);
const PAID_MATCH_LIMIT = parseInt(process.env.PAID_MATCH_LIMIT || '50', 10);
const MEMBERSHIP_PRICE_PHP = parseInt(process.env.MEMBERSHIP_PRICE_PHP || '100', 10);
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
      isPaid: false,
      reportCount: 0,
      banned: false,
      birthYear: null,
    };
  }
  return db.users[userId];
}

function userLimit(user) {
  return user.isPaid ? PAID_MATCH_LIMIT : FREE_MATCH_LIMIT;
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

// Get a user's current status (matches used, limit, paid or not)
app.get('/api/status/:userId', (req, res) => {
  const db = loadDb();
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Unknown user' });

  res.json({
    matchesUsed: user.matchesUsed,
    limit: userLimit(user),
    isPaid: user.isPaid,
    banned: user.banned,
    remaining: Math.max(0, userLimit(user) - user.matchesUsed),
    membershipPricePhp: MEMBERSHIP_PRICE_PHP,
  });
});

// Create a payment reference. If PayMongo isn't configured, falls back to
// "manual GCash" mode: shows your GCash number and a reference code the user
// includes in the payment note, and you upgrade them by hand (see /api/admin/upgrade).
app.post('/api/create-payment', async (req, res) => {
  const { userId } = req.body || {};
  const db = loadDb();
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Unknown user' });

  if (!process.env.PAYMONGO_SECRET_KEY) {
    return res.json({
      mode: 'manual',
      gcashName: process.env.GCASH_NAME || 'Your Name',
      gcashNumber: process.env.GCASH_NUMBER || '09XXXXXXXXX',
      amountPhp: MEMBERSHIP_PRICE_PHP,
      referenceCode: userId.slice(0, 8).toUpperCase(),
      instructions:
        'Send the exact amount via GCash, then message the admin your reference code and payment screenshot to get upgraded.',
    });
  }

  // --- PayMongo GCash payment link (only runs if you've set PAYMONGO_SECRET_KEY) ---
  try {
    const response = await fetch('https://api.paymongo.com/v1/links', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(process.env.PAYMONGO_SECRET_KEY + ':').toString('base64'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: {
          attributes: {
            amount: MEMBERSHIP_PRICE_PHP * 100, // centavos
            description: `Stranger in Pigcawayan membership (${userId})`,
            remarks: userId,
          },
        },
      }),
    });
    const data = await response.json();
    const checkoutUrl = data?.data?.attributes?.checkout_url;
    if (!checkoutUrl) throw new Error('No checkout URL returned');
    res.json({ mode: 'paymongo', checkoutUrl });
  } catch (err) {
    console.error('PayMongo error:', err.message);
    res.status(500).json({ error: 'Could not create payment link right now.' });
  }
});

// PayMongo webhook: call this URL from your PayMongo dashboard so payments
// automatically upgrade the right user. Verifies nothing by itself yet —
// see README for adding real signature verification before going live.
app.post('/api/payment-webhook', (req, res) => {
  const event = req.body;
  const remarks = event?.data?.attributes?.data?.attributes?.remarks; // userId we stored above
  const status = event?.data?.attributes?.type;

  if (status === 'link.payment.paid' && remarks) {
    const db = loadDb();
    const user = db.users[remarks];
    if (user) {
      user.isPaid = true;
      saveDb(db);
      console.log(`User ${remarks} upgraded to paid via PayMongo webhook.`);
    }
  }
  res.sendStatus(200);
});

// Manual upgrade endpoint for when you're confirming GCash payments by hand.
// Protect this with your own secret before deploying publicly!
app.post('/api/admin/upgrade', (req, res) => {
  const { userId, adminSecret } = req.body || {};
  if (adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const db = loadDb();
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'Unknown user' });
  user.isPaid = true;
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

    // Count this as a "match used" for both users
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

    if (user.matchesUsed >= userLimit(user)) {
      return socket.emit('limit-reached', {
        limit: userLimit(user),
        isPaid: user.isPaid,
        membershipPricePhp: MEMBERSHIP_PRICE_PHP,
      });
    }

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
    const userId = socketToUser.get(socket.id);
    if (!userId) return;
    // put them back in queue for their next match (limit already checked on join-queue)
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
