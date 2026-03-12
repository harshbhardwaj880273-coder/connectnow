const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ── Serve frontend ─────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── ICE config endpoint — fresh on every request ───
// Using free Metered TURN + openrelay as backup
app.get('/ice', (req, res) => {
  res.json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      { urls: 'stun:stun.relay.metered.ca:80' },
      // openrelay — always free, no account needed
      { urls: 'turn:openrelay.metered.ca:80',                   username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:80?transport=tcp',     username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443',                  username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp',    username: 'openrelayproject', credential: 'openrelayproject' },
      // expressturn free tier
      { urls: 'turn:relay1.expressturn.com:3478', username: 'efKBDS8AAAF6GGFY', credential: 'JZEOEt2V3Dputaqw' },
    ],
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── State ──────────────────────────────────────────
const waiting = [];
const rooms   = new Map();
const users   = new Map();

function removeFromWaiting(id) {
  const i = waiting.findIndex(u => u.socketId === id);
  if (i !== -1) waiting.splice(i, 1);
}

function findMatch(seeker) {
  let i = waiting.findIndex(u =>
    u.socketId !== seeker.socketId &&
    (u.country === seeker.country || seeker.country === 'ANY' || u.country === 'ANY')
  );
  if (i === -1) i = waiting.findIndex(u => u.socketId !== seeker.socketId);
  return i;
}

function leaveRoom(id) {
  const user = users.get(id);
  if (!user) return;
  const room = rooms.get(user.roomId);
  if (room) {
    const pid = room.find(x => x !== id);
    if (pid) { io.to(pid).emit('partner-left'); users.delete(pid); }
    rooms.delete(user.roomId);
  }
  users.delete(id);
}

// ── Socket ─────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id}  online=${io.engine.clientsCount}`);
  io.emit('online-count', io.engine.clientsCount);

  socket.on('find-partner', ({ gender, country }) => {
    removeFromWaiting(socket.id);
    leaveRoom(socket.id);
    const seeker = { socketId: socket.id, gender, country };
    const idx    = findMatch(seeker);
    if (idx !== -1) {
      const partner = waiting.splice(idx, 1)[0];
      const roomId  = uuidv4();
      rooms.set(roomId, [socket.id, partner.socketId]);
      users.set(socket.id,          { roomId, peerId: partner.socketId });
      users.set(partner.socketId,   { roomId, peerId: socket.id });
      io.to(socket.id).emit('matched',         { roomId, initiator: true,  partnerId: partner.socketId });
      io.to(partner.socketId).emit('matched',  { roomId, initiator: false, partnerId: socket.id });
      console.log(`  room ${roomId.slice(0,8)} — ${socket.id.slice(0,6)} <-> ${partner.socketId.slice(0,6)}`);
    } else {
      waiting.push(seeker);
      socket.emit('waiting');
    }
  });

  socket.on('offer',         ({ to, offer })      => io.to(to).emit('offer',         { from: socket.id, offer }));
  socket.on('answer',        ({ to, answer })     => io.to(to).emit('answer',        { from: socket.id, answer }));
  socket.on('ice-candidate', ({ to, candidate })  => io.to(to).emit('ice-candidate', { from: socket.id, candidate }));

  socket.on('skip', () => { leaveRoom(socket.id); socket.emit('skipped'); });

  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id}`);
    removeFromWaiting(socket.id);
    leaveRoom(socket.id);
    io.emit('online-count', io.engine.clientsCount);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 ConnectNow on port ${PORT}`));
