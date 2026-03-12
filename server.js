const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Serve static frontend
app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── State ──────────────────────────────────────────────
// waiting: { socketId, gender, country }
const waiting = [];

// rooms: Map<roomId, [socketId, socketId]>
const rooms = new Map();

// users: Map<socketId, { roomId, peerId }>
const users = new Map();

// ── Helpers ────────────────────────────────────────────
function removeFromWaiting(socketId) {
  const idx = waiting.findIndex(u => u.socketId === socketId);
  if (idx !== -1) waiting.splice(idx, 1);
}

function findMatch(seeker) {
  // Try same country first (India-biased naturally), then any
  let idx = waiting.findIndex(u =>
    u.socketId !== seeker.socketId &&
    (u.country === seeker.country || seeker.country === 'ANY' || u.country === 'ANY')
  );
  if (idx === -1) {
    // Fallback: any person
    idx = waiting.findIndex(u => u.socketId !== seeker.socketId);
  }
  return idx;
}

function leaveRoom(socketId) {
  const user = users.get(socketId);
  if (!user) return;
  const { roomId } = user;
  const room = rooms.get(roomId);
  if (room) {
    const partnerId = room.find(id => id !== socketId);
    if (partnerId) {
      io.to(partnerId).emit('partner-left');
      users.delete(partnerId);
      // put partner back in waiting with their original info (they'll re-queue)
    }
    rooms.delete(roomId);
  }
  users.delete(socketId);
}

// ── Socket events ──────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected. Online: ${io.engine.clientsCount}`);

  // Broadcast online count every connection/disconnection
  io.emit('online-count', io.engine.clientsCount);

  // ── Find a partner ──
  socket.on('find-partner', ({ gender, country }) => {
    // Remove from any old waiting slot
    removeFromWaiting(socket.id);
    leaveRoom(socket.id);

    const seeker = { socketId: socket.id, gender, country };
    const idx    = findMatch(seeker);

    if (idx !== -1) {
      // Found a partner
      const partner = waiting.splice(idx, 1)[0];
      const roomId  = uuidv4();

      rooms.set(roomId, [socket.id, partner.socketId]);
      users.set(socket.id,     { roomId, peerId: partner.socketId });
      users.set(partner.socketId, { roomId, peerId: socket.id });

      // Tell both who initiates the WebRTC offer
      io.to(socket.id).emit('matched', { roomId, initiator: true,  partnerId: partner.socketId });
      io.to(partner.socketId).emit('matched', { roomId, initiator: false, partnerId: socket.id });
    } else {
      // Join waiting queue
      waiting.push(seeker);
      socket.emit('waiting');
    }
  });

  // ── WebRTC signaling relay ──
  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', { from: socket.id, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // ── Skip / Next ──
  socket.on('skip', () => {
    leaveRoom(socket.id);
    socket.emit('skipped');
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id} disconnected`);
    removeFromWaiting(socket.id);
    leaveRoom(socket.id);
    io.emit('online-count', io.engine.clientsCount);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀  ConnectNow running on port ${PORT}\n`);
});
