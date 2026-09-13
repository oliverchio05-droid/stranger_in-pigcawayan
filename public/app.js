// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const API_BASE = 'https://stranger-in-pigcawayan.onrender.com';
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  // Add your TURN server here once you set one up (see README):
  // { urls: 'turn:YOUR_TURN_URL', username: 'YOUR_USER', credential: 'YOUR_CRED' },
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let userId = localStorage.getItem('sip_user_id') || null;
let socket = null;
let pc = null;
let localStream = null;
let currentRoomId = null;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const el = (id) => document.getElementById(id);
const landing = el('landing');
const chatScreen = el('chatScreen');
const ageGate = el('ageGate');
const birthYearInput = el('birthYear');
const startBtn = el('startBtn');
const ageError = el('ageError');
const scrollHint = el('scrollHint');

const roomStatus = el('roomStatus');
const remoteVideo = el('remoteVideo');
const localVideo = el('localVideo');
const stageOverlay = el('stageOverlay');
const muteBtn = el('muteBtn');
const camBtn = el('camBtn');
const skipBtn = el('skipBtn');
const reportBtn = el('reportBtn');
const endBtn = el('endBtn');
const chatLog = el('chatLog');
const chatForm = el('chatForm');
const chatInput = el('chatInput');

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
if (userId) {
  ageGate.querySelector('label').textContent = 'Welcome back. Ready for another stranger?';
}

// Once they've typed a full 4-digit year, nudge them toward the button —
// on some phones the keyboard covers it, so a visual hint plus an
// auto-scroll makes sure they don't get stuck not knowing what to do next.
birthYearInput.addEventListener('input', () => {
  if (birthYearInput.value.length === 4) {
    scrollHint.hidden = false;
    startBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    scrollHint.hidden = true;
  }
});

startBtn.addEventListener('click', async () => {
  const year = parseInt(birthYearInput.value, 10);
  const age = new Date().getFullYear() - year;
  ageError.textContent = '';

  if (!userId) {
    if (!year || age < 18 || age > 100) {
      ageError.textContent = 'You must enter a valid birth year and be 18 or older.';
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ birthYear: year }),
      });
      const data = await res.json();
      if (!res.ok) {
        ageError.textContent = data.error || 'Something went wrong.';
        return;
      }
      userId = data.userId;
      localStorage.setItem('sip_user_id', userId);
    } catch (err) {
      ageError.textContent = 'Could not reach the server. Try again.';
      return;
    }
  }

  enterChat();
});

// ---------------------------------------------------------------------------
// Enter chat flow
// ---------------------------------------------------------------------------
async function enterChat() {
  landing.hidden = true;
  chatScreen.hidden = false;
  window.scrollTo(0, 0); // always start the chat screen from the top, regardless of scroll position on landing

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
  } catch (err) {
    addSystemMessage('Camera/mic access was denied. You can still text chat.');
  }

  connectSocket();
}

function connectSocket() {
  socket = io(API_BASE);

  socket.on('connect', () => {
    joinQueue();
  });

  socket.on('queued', () => {
    roomStatus.textContent = 'looking for someone…';
    setOverlay(true, 'Casting a lantern downstream…');
  });

  socket.on('matched', async ({ roomId, initiator }) => {
    currentRoomId = roomId;
    roomStatus.textContent = 'connected';
    setOverlay(false);
    chatLog.innerHTML = '';
    addSystemMessage('A stranger has appeared. Say hi.');
    await setupPeerConnection(initiator);
  });

  socket.on('signal', async (payload) => {
    if (!pc) return;
    if (payload.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      if (payload.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal', { sdp: pc.localDescription });
      }
    } else if (payload.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
      } catch (e) { /* ignore benign race conditions */ }
    }
  });

  socket.on('chat-message', ({ text }) => addChatMessage(text, 'them'));

  socket.on('partner-left', ({ reason }) => {
    teardownPeerConnection();
    addSystemMessage(
      reason === 'reported' ? 'That conversation ended.' : 'The stranger left. Finding someone new…'
    );
    roomStatus.textContent = 'looking for someone…';
    setOverlay(true, 'Casting a lantern downstream…');
    joinQueue();
  });

  socket.on('rejoin-check', () => {
    teardownPeerConnection();
    joinQueue();
  });

  socket.on('banned', () => {
    setOverlay(true, 'This account has been restricted due to reports.');
    if (socket) socket.disconnect();
  });

  socket.on('error-message', (msg) => {
    // Most common cause: the backend restarted and lost this session
    // (its small file-based database resets on every redeploy). Rather
    // than showing a dead end, just clear the old ID and let them rejoin.
    addSystemMessage('Reconnecting…');
    localStorage.removeItem('sip_user_id');
    userId = null;
    teardownPeerConnection();
    if (socket) socket.disconnect();
    chatScreen.hidden = true;
    landing.hidden = false;
    ageGate.querySelector('label').textContent = 'Enter your birth year to continue';
  });
}

function joinQueue() {
  if (socket && userId) socket.emit('join-queue', { userId });
}

function setOverlay(show, text) {
  stageOverlay.hidden = !show;
  if (text) stageOverlay.querySelector('p').textContent = text;
}

// ---------------------------------------------------------------------------
// WebRTC
// ---------------------------------------------------------------------------
async function setupPeerConnection(initiator) {
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }

  pc.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) socket.emit('signal', { candidate: event.candidate });
  };

  if (initiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { sdp: pc.localDescription });
  }
}

function teardownPeerConnection() {
  if (pc) {
    pc.close();
    pc = null;
  }
  remoteVideo.srcObject = null;
  currentRoomId = null;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
skipBtn.addEventListener('click', () => {
  if (!socket) return;
  socket.emit('skip');
  teardownPeerConnection(); // clear the old video frame immediately, before the overlay even shows
  addSystemMessage('You skipped. Finding someone new…');
  roomStatus.textContent = 'looking for someone…';
  setOverlay(true, 'Casting a lantern downstream…');
});

reportBtn.addEventListener('click', () => {
  if (!socket || !currentRoomId) return;
  if (confirm('Report this person and end the conversation?')) {
    socket.emit('report', { reason: 'user-reported' });
    teardownPeerConnection();
  }
});

endBtn.addEventListener('click', () => {
  if (socket) {
    socket.emit('leave-chat');
    socket.disconnect();
  }
  teardownPeerConnection();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  chatScreen.hidden = true;
  landing.hidden = false;
});

muteBtn.addEventListener('click', () => {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) return;
  audioTrack.enabled = !audioTrack.enabled;
  muteBtn.classList.toggle('muted', !audioTrack.enabled);
});

camBtn.addEventListener('click', () => {
  if (!localStream) return;
  const videoTrack = localStream.getVideoTracks()[0];
  if (!videoTrack) return;
  videoTrack.enabled = !videoTrack.enabled;
  camBtn.classList.toggle('muted', !videoTrack.enabled);
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !socket) return;
  socket.emit('chat-message', { text });
  addChatMessage(text, 'me');
  chatInput.value = '';
});

function addChatMessage(text, from) {
  const div = document.createElement('div');
  div.className = `chat-msg ${from}`;
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'chat-msg system';
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}
