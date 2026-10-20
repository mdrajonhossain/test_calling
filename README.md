# Audio-only calling

A minimal Node.js, Express, Socket.IO, and WebRTC audio-calling app. Signaling and
online-user presence are held in server memory; there is no database.

## Run locally

1. Install Node.js 18 or newer.
2. Copy `.env.example` to `.env` and set your TURN server URL, username, and
   credential.
3. Install dependencies with `npm install`.
4. Start the app with `npm start`.
5. Open `http://localhost:3000` in two browser windows and join with different
   names. Allow microphone access when prompted.

`TURN_URLS` accepts one or more comma-separated TURN URLs. The configuration
endpoint shares the TURN username and credential with browsers because WebRTC
clients need them to use the TURN relay. Use temporary/rotating TURN credentials
and HTTPS in deployments; browsers generally require a secure context for
microphone access (localhost is allowed).

This sample uses an in-memory user list, so users and calls are cleared when the
server restarts. Audio calling requires microphone permission and network access
to the configured ICE servers.
