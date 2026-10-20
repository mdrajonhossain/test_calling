require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = Number(process.env.PORT) || 3000;

const users = new Map();
const activeCalls = new Map();

app.use(express.static(path.join(__dirname, "public")));

app.get("/config", (_req, res) => {
  const urls = (process.env.TURN_URLS || "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

  if (urls.length > 0) {
    iceServers.push({
      urls,
      username: process.env.TURN_USERNAME || "",
      credential: process.env.TURN_CREDENTIAL || "",
    });
  }

  res.json({ iceServers });
});

function publishUsers() {
  io.emit("users", Array.from(users, ([id, name]) => ({ id, name })));
}

function sendError(socket, message) {
  socket.emit("server-error", message);
}

function clearCall(socketId, reason) {
  const peerId = activeCalls.get(socketId);
  if (!peerId) return;

  activeCalls.delete(socketId);
  activeCalls.delete(peerId);
  io.to(peerId).emit("call-ended", { reason });
}

io.on("connection", (socket) => {
  socket.on("join", (rawName) => {
    if (users.has(socket.id)) {
      sendError(socket, "You have already joined.");
      return;
    }

    const name = typeof rawName === "string" ? rawName.trim().slice(0, 32) : "";
    if (!name) {
      sendError(socket, "Enter a name to join.");
      return;
    }

    const nameTaken = Array.from(users.values()).some(
      (existingName) => existingName.toLowerCase() === name.toLowerCase()
    );
    if (nameTaken) {
      sendError(socket, "That name is already in use. Choose another name.");
      return;
    }

    users.set(socket.id, name);
    socket.emit("joined", { id: socket.id, name });
    publishUsers();
  });

  socket.on("call-user", (targetId) => {
    if (!users.has(socket.id)) {
      sendError(socket, "Join before starting a call.");
      return;
    }
    if (typeof targetId !== "string" || !users.has(targetId) || targetId === socket.id) {
      socket.emit("call-error", "That user is not available.");
      return;
    }
    if (activeCalls.has(socket.id) || activeCalls.has(targetId)) {
      socket.emit("call-error", "One of the users is already on a call.");
      return;
    }

    activeCalls.set(socket.id, targetId);
    activeCalls.set(targetId, socket.id);
    io.to(targetId).emit("incoming-call", {
      from: socket.id,
      name: users.get(socket.id),
    });
  });

  socket.on("accept-call", (callerId) => {
    if (activeCalls.get(socket.id) !== callerId) return;
    io.to(callerId).emit("call-accepted");
  });

  socket.on("decline-call", (callerId) => {
    if (activeCalls.get(socket.id) !== callerId) return;
    clearCall(socket.id, "declined");
  });

  for (const event of ["offer", "answer", "ice-candidate"]) {
    socket.on(event, (payload) => {
      const peerId = activeCalls.get(socket.id);
      if (!peerId || !payload || typeof payload !== "object") return;
      io.to(peerId).emit(event, payload);
    });
  }

  socket.on("end-call", () => clearCall(socket.id, "ended"));

  socket.on("disconnect", () => {
    clearCall(socket.id, "disconnected");
    if (users.delete(socket.id)) publishUsers();
  });
});

server.listen(port, () => {
  console.log(`Audio calling server listening on http://localhost:${port}`);
});
