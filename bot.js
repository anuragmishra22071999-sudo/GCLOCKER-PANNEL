const ws3 = require("ws3-fca");
const login = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
const fs = require("fs");
const path = require("path");
const HttpsProxyAgent = require("https-proxy-agent");
const express = require("express");
const bodyParser = require("body-parser");
const http = require("http");
const { Server } = require("socket.io");

// Optional Proxy
const INDIAN_PROXY = "http://103.119.112.54:80";
let proxyAgent;
try {
  proxyAgent = new HttpsProxyAgent(INDIAN_PROXY);
} catch {
  proxyAgent = null;
}

const uid = process.argv[2];
const userDir = path.join(__dirname, "users", uid);
const appStatePath = path.join(userDir, "appstate.json");
const adminPath = path.join(userDir, "admin.txt");
const logPath = path.join(userDir, "logs.txt");

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(logPath, line + "\n");
  emitLog(line); // <-- socket.io emit bhi karega
}

// Load AppState
let appState;
try {
  const raw = fs.readFileSync(appStatePath, "utf-8");
  if (!raw.trim()) throw new Error("File empty");
  appState = JSON.parse(raw);
} catch {
  log("❌ appstate.json invalid or empty.");
  process.exit(1);
}

// Load Admin UID
let BOSS_UID;
try {
  BOSS_UID = fs.readFileSync(adminPath, "utf-8").trim();
  if (!BOSS_UID) throw new Error("UID missing");
} catch {
  log("❌ admin.txt invalid or empty.");
  process.exit(1);
}

// State Variables
let GROUP_THREAD_ID = null;
let LOCKED_GROUP_NAME = null;
let lockedNick = null;
let nickLockEnabled = false;
let nickRemoveEnabled = false;
let gcAutoRemoveEnabled = false;

let api = null;

// --- EXPRESS + SOCKET.IO API ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(bodyParser.json());
app.use(express.static("public"));

// Root
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// Send message API
app.post("/send", (req, res) => {
  const { threadID, message } = req.body;
  if (!api) return res.status(500).send("❌ Bot not logged in yet");
  if (!threadID || !message) return res.status(400).send("❌ threadID & message required");

  api.sendMessage(message, String(threadID), (err) => {
    if (err) return res.status(500).send("❌ Failed: " + err);
    res.send("✅ Message sent to " + threadID);
  });
});

// Status API
app.get("/status", (req, res) => {
  res.json({
    gcLock: LOCKED_GROUP_NAME || "OFF",
    gcAutoRemove: gcAutoRemoveEnabled ? "ON" : "OFF",
    nickLock: nickLockEnabled ? `ON (${lockedNick})` : "OFF",
    nickAutoRemove: nickRemoveEnabled ? "ON" : "OFF",
  });
});

// Socket.io connections
io.on("connection", (socket) => {
  socket.emit("botlog", `Bot: ${api ? "Started" : "Idle"}`);
  socket.emit("statusUpdate", {
    gcLock: LOCKED_GROUP_NAME || "OFF",
    gcAutoRemove: gcAutoRemoveEnabled ? "ON" : "OFF",
    nickLock: nickLockEnabled ? `ON (${lockedNick})` : "OFF",
    nickAutoRemove: nickRemoveEnabled ? "ON" : "OFF",
  });
});

function emitLog(message) {
  io.emit("botlog", message);
}

function emitStatus() {
  io.emit("statusUpdate", {
    gcLock: LOCKED_GROUP_NAME || "OFF",
    gcAutoRemove: gcAutoRemoveEnabled ? "ON" : "OFF",
    nickLock: nickLockEnabled ? `ON (${lockedNick})` : "OFF",
    nickAutoRemove: nickRemoveEnabled ? "ON" : "OFF",
  });
}

// Start HTTP server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => log(`🌐 API Server running on port ${PORT}`));

// --- Bot Function ---
function startBot() {
  login(
    {
      appState,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) " +
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FBAV/400.0.0.0.0",
      agent: proxyAgent,
    },
    (err, a) => {
      if (err) {
        log("❌ [LOGIN FAILED]: " + err);
        setTimeout(startBot, 10000);
        return;
      }

      api = a;

      api.setOptions({
        listenEvents: true,
        selfListen: true,
        updatePresence: true,
      });

      log("🤖 BOT ONLINE — Running now");

      // Anti-Sleep
      setInterval(() => {
        if (GROUP_THREAD_ID) {
          api.sendTypingIndicator(String(GROUP_THREAD_ID), true);
          setTimeout(() => api.sendTypingIndicator(String(GROUP_THREAD_ID), false), 1500);
          log("💤 Anti-Sleep Triggered");
        }
      }, 300000);

      // Auto-save AppState
      setInterval(() => {
        try {
          const newAppState = api.getAppState();
          fs.writeFileSync(appStatePath, JSON.stringify(newAppState, null, 2));
          log("💾 AppState saved ✅");
        } catch (e) {
          log("❌ Failed saving AppState: " + e);
        }
      }, 600000);

      // Listener
      function listen() {
        try {
          api.listenMqtt(async (err, event) => {
            if (err) {
              log("❌ Listen error: " + err);
              setTimeout(listen, 5000);
              return;
            }

            const senderID = event.senderID;
            const threadID = String(event.threadID);
            const body = (event.body || "").toLowerCase();

            if (event.type === "message") {
              log(`📩 ${senderID}: ${event.body} (Group: ${threadID})`);
            }

            // Commands handling (same as before)
            // 🔒 Group Lock
            if (body.startsWith("/gclock") && senderID === BOSS_UID) {
              try {
                const newName = event.body.slice(7).trim();
                if (!newName) return api.sendMessage("❌ Please provide a group name", threadID);

                GROUP_THREAD_ID = threadID;
                LOCKED_GROUP_NAME = newName;
                gcAutoRemoveEnabled = false;

                await api.setTitle(LOCKED_GROUP_NAME, threadID);
                api.sendMessage(`🔒 Group name locked: "${LOCKED_GROUP_NAME}"`, threadID);
                emitStatus();
              } catch (e) {
                log("❌ Failed to lock group name: " + e);
                api.sendMessage("❌ Failed to lock group name", threadID);
              }
            }

            // 🧹 GC Remove
            if (body === "/gcremove" && senderID === BOSS_UID) {
              try {
                await api.setTitle("", threadID);
                LOCKED_GROUP_NAME = null;
                GROUP_THREAD_ID = threadID;
                gcAutoRemoveEnabled = true;
                api.sendMessage("🧹 Name removed. Auto-remove ON ✅", threadID);
                emitStatus();
              } catch (e) {
                log("❌ Failed to remove GC name: " + e);
                api.sendMessage("❌ Failed to remove name", threadID);
              }
            }

            // Handle group name changes
            if (event.logMessageType === "log:thread-name") {
              const changed = event.logMessageData.name;
              if (LOCKED_GROUP_NAME && threadID === GROUP_THREAD_ID && changed !== LOCKED_GROUP_NAME) {
                try {
                  await api.setTitle(LOCKED_GROUP_NAME, threadID);
                } catch (e) {
                  log("❌ Failed reverting GC name: " + e);
                }
              } else if (gcAutoRemoveEnabled) {
                try {
                  await api.setTitle("", threadID);
                  log(`🧹 GC name auto-removed: "${changed}"`);
                } catch (e) {
                  log("❌ Failed auto-remove GC name: " + e);
                }
              }
            }

            // 🔐 Nick Lock
            if (body.startsWith("/nicklock on") && senderID === BOSS_UID) {
              const parts = event.body.split(" ");
              lockedNick = parts.slice(2).join(" ").trim();
              if (!lockedNick) return api.sendMessage("❌ Please provide a nickname", threadID);

              nickLockEnabled = true;
              try {
                const info = await api.getThreadInfo(threadID);
                for (const u of info.userInfo) {
                  await api.changeNickname(lockedNick, threadID, String(u.id));
                }
                api.sendMessage(`🔐 Nickname locked: "${lockedNick}"`, threadID);
                emitStatus();
              } catch (e) {
                log("❌ Failed setting nick: " + e);
                api.sendMessage("❌ Failed setting nick", threadID);
              }
            }

            // 🔓 Nick Lock Off
            if (body === "/nicklock off" && senderID === BOSS_UID) {
              nickLockEnabled = false;
              lockedNick = null;
              api.sendMessage("🔓 Nickname lock disabled", threadID);
              emitStatus();
            }

            // 💥 Nick Remove All
            if (body === "/nickremoveall" && senderID === BOSS_UID) {
              nickRemoveEnabled = true;
              try {
                const info = await api.getThreadInfo(threadID);
                for (const u of info.userInfo) {
                  await api.changeNickname("", threadID, String(u.id));
                }
                api.sendMessage("💥 Nicknames cleared. Auto-remove ON", threadID);
                emitStatus();
              } catch (e) {
                log("❌ Failed removing nicknames: " + e);
                api.sendMessage("❌ Failed removing nicknames", threadID);
              }
            }

            // 🛑 Nick Remove Off
            if (body === "/nickremoveoff" && senderID === BOSS_UID) {
              nickRemoveEnabled = false;
              api.sendMessage("🛑 Nick auto-remove OFF", threadID);
              emitStatus();
            }

            // Handle nickname changes
            if (event.logMessageType === "log:user-nickname") {
              const changedUID = event.logMessageData.participant_id || event.logMessageData.participantID;
              const newNick = event.logMessageData.nickname || "";

              if (nickLockEnabled && newNick !== lockedNick) {
                try {
                  await api.changeNickname(lockedNick, threadID, String(changedUID));
                } catch (e) {
                  log("❌ Failed reverting nickname: " + e);
                }
              }

              if (nickRemoveEnabled && newNick !== "") {
                try {
                  await api.changeNickname("", threadID, String(changedUID));
                } catch (e) {
                  log("❌ Failed auto-remove nickname: " + e);
                }
              }
            }

            // 📊 Status command
            if (body === "/status" && senderID === BOSS_UID) {
              const msg = `
BOT STATUS:
• GC Lock: ${LOCKED_GROUP_NAME || "OFF"}
• GC AutoRemove: ${gcAutoRemoveEnabled ? "ON" : "OFF"}
• Nick Lock: ${nickLockEnabled ? `ON (${lockedNick})` : "OFF"}
• Nick AutoRemove: ${nickRemoveEnabled ? "ON" : "OFF"}
`;
              api.sendMessage(msg.trim(), threadID);
            }
          });
        } catch (e) {
          log("❌ Listener crashed: " + e);
          setTimeout(listen, 5000);
        }
      }

      listen();
    }
  );
}

startBot();
