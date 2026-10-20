const socket = io();
const joinForm = document.querySelector("#join-form");
const nameInput = document.querySelector("#name");
const lobby = document.querySelector("#lobby");
const userList = document.querySelector("#users");
const emptyState = document.querySelector("#empty-state");
const onlineCount = document.querySelector("#online-count");
const notice = document.querySelector("#notice");
const callPanel = document.querySelector("#call-panel");
const callStatus = document.querySelector("#call-status");
const voiceIndicator = document.querySelector("#voice-indicator");
const callDuration = document.querySelector("#call-duration");
const incomingActions = document.querySelector("#incoming-actions");
const acceptButton = document.querySelector("#accept-call");
const declineButton = document.querySelector("#decline-call");
const endButton = document.querySelector("#end-call");
const remoteAudio = document.querySelector("#remote-audio");
const localAudio = document.querySelector("#local-audio");

let ownId = null;
let peerId = null;
let peerConnection = null;
let localStream = null;
let pendingOffer = null;
let pendingIceCandidates = [];
let iceServers = [];
let callStartedAt = null;
let callTimer = null;

fetch("/config")
  .then((response) => {
    if (!response.ok) throw new Error("Could not load WebRTC configuration.");
    return response.json();
  })
  .then((config) => {
    iceServers = config.iceServers;
  })
  .catch((error) => showNotice(error.message));

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  socket.emit("join", nameInput.value);
});

socket.on("joined", ({ id, name }) => {
  ownId = id;
  joinForm.hidden = true;
  lobby.hidden = false;
  showNotice(`Joined as ${name}.`);
});

socket.on("users", (users) => {
  userList.replaceChildren();
  const others = users.filter((user) => user.id !== ownId);
  onlineCount.textContent = String(others.length);
  emptyState.hidden = others.length > 0;

  for (const user of others) {
    const item = document.createElement("li");
    item.className = "user-row";
    const label = document.createElement("span");
    label.textContent = user.name;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Call";
    button.addEventListener("click", () => {
      if (peerId) return;
      peerId = user.id;
      showCall(`Calling ${user.name}…`);
      socket.emit("call-user", user.id);
    });
    item.append(label, button);
    userList.append(item);
  }
});

socket.on("incoming-call", ({ from, name }) => {
  if (peerId) {
    socket.emit("decline-call", from);
    return;
  }
  peerId = from;
  pendingOffer = null;
  showCall(`${name} is calling.`);
  incomingActions.hidden = false;
});

acceptButton.addEventListener("click", async () => {
  if (!peerId) return;
  try {
    await ensurePeerConnection();
    socket.emit("accept-call", peerId);
    incomingActions.hidden = true;
    endButton.hidden = false;
    callStatus.textContent = "Connecting…";
    if (pendingOffer) await handleOffer(pendingOffer);
  } catch (error) {
    showNotice(error.message);
    socket.emit("end-call");
    resetCall();
  }
});

declineButton.addEventListener("click", () => {
  socket.emit("decline-call", peerId);
  resetCall();
});

endButton.addEventListener("click", () => {
  socket.emit("end-call");
  resetCall();
});

socket.on("call-accepted", async () => {
  try {
    await ensurePeerConnection();
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit("offer", offer);
    incomingActions.hidden = true;
    endButton.hidden = false;
    callStatus.textContent = "Calling…";
  } catch (error) {
    showNotice(error.message);
    socket.emit("end-call");
    resetCall();
  }
});

socket.on("offer", async (offer) => {
  if (!peerConnection) {
    pendingOffer = offer;
    return;
  }
  try {
    await handleOffer(offer);
  } catch (error) {
    showNotice(error.message);
    socket.emit("end-call");
    resetCall();
  }
});

socket.on("answer", async (answer) => {
  try {
    if (peerConnection) {
      await peerConnection.setRemoteDescription(answer);
      await flushPendingIceCandidates();
    }
  } catch (error) {
    showNotice(error.message);
    socket.emit("end-call");
    resetCall();
  }
});

socket.on("ice-candidate", async (candidate) => {
  try {
    if (peerConnection && peerConnection.remoteDescription) {
      await peerConnection.addIceCandidate(candidate);
    } else {
      pendingIceCandidates.push(candidate);
    }
  } catch (error) {
    showNotice(`Could not add an ICE candidate: ${error.message}`);
  }
});

socket.on("call-ended", ({ reason }) => {
  resetCall();
  if (reason === "declined") showNotice("The call was declined.");
  else if (reason === "disconnected") showNotice("The other user disconnected.");
});

socket.on("server-error", showNotice);
socket.on("call-error", (message) => {
  showNotice(message);
  resetCall();
});
socket.on("connect_error", () => showNotice("Could not connect to the signaling server."));
socket.on("disconnect", () => {
  resetCall();
  showNotice("Disconnected from the signaling server.");
});

async function ensurePeerConnection() {
  if (peerConnection) return;
  if (
    !window.isSecureContext ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== "function"
  ) {
    throw new Error(
      "Microphone access requires a secure page. Open this app at http://localhost:3000 or serve it over HTTPS."
    );
  }
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  localAudio.srcObject = localStream;
  peerConnection = new RTCPeerConnection({ iceServers });
  for (const track of localStream.getAudioTracks()) {
    peerConnection.addTrack(track, localStream);
  }
  peerConnection.ontrack = (event) => {
    remoteAudio.srcObject = event.streams[0];
    if (peerConnection.connectionState === "connected") markCallConnected();
  };
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) socket.emit("ice-candidate", event.candidate);
  };
  peerConnection.onconnectionstatechange = () => {
    if (peerConnection && peerConnection.connectionState === "connected") {
      markCallConnected();
    }
    if (peerConnection && peerConnection.connectionState === "failed") {
      showNotice("Connection failed. Check your network or TURN server settings.");
      socket.emit("end-call");
      resetCall();
    }
  };
}

async function handleOffer(offer) {
  await peerConnection.setRemoteDescription(offer);
  await flushPendingIceCandidates();
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit("answer", answer);
  pendingOffer = null;
  callStatus.textContent = "Connecting…";
}

async function flushPendingIceCandidates() {
  const candidates = pendingIceCandidates;
  pendingIceCandidates = [];
  for (const candidate of candidates) {
    await peerConnection.addIceCandidate(candidate);
  }
}

function showCall(status) {
  callPanel.hidden = false;
  callStatus.textContent = status;
  endButton.hidden = true;
}

function markCallConnected() {
  callStatus.textContent = "Connected";
  voiceIndicator.hidden = false;
  if (callTimer) return;
  callStartedAt = Date.now();
  updateCallDuration();
  callTimer = window.setInterval(updateCallDuration, 1000);
}

function updateCallDuration() {
  if (!callStartedAt) return;
  const seconds = Math.floor((Date.now() - callStartedAt) / 1000);
  const minutesText = String(Math.floor(seconds / 60)).padStart(2, "0");
  const secondsText = String(seconds % 60).padStart(2, "0");
  callDuration.textContent = `${minutesText}:${secondsText}`;
}

function showNotice(message) {
  notice.textContent = message;
}

function resetCall() {
  if (callTimer) {
    window.clearInterval(callTimer);
    callTimer = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (localStream) {
    for (const track of localStream.getTracks()) track.stop();
    localStream = null;
  }
  remoteAudio.srcObject = null;
  localAudio.srcObject = null;
  peerId = null;
  pendingOffer = null;
  pendingIceCandidates = [];
  callStartedAt = null;
  callDuration.textContent = "00:00";
  voiceIndicator.hidden = true;
  callPanel.hidden = true;
  incomingActions.hidden = true;
  endButton.hidden = true;
}
