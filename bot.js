const ws3 = require("ws3-fca");
const login = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
const fs = require("fs");
const path = require("path");
const HttpsProxyAgent = require("https-proxy-agent");

const uid = process.argv[2];
if (!uid) {
  console.error("❌ No UID provided to bot.js");
  process.exit(1);
}

const userDir = path.join(__dirname, "users", String(uid));
const appStatePath = path.join(userDir, "appstate.json");
const adminPath = path.join(userDir, "admin.txt");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// --- Load appstate ---
let appState;
try {
  appState = JSON.parse(fs.readFileSync(appStatePath, "utf-8"));
} catch (e) {
  console.error("❌ Invalid appstate.json");
  process.exit(1);
}

// --- Load Admin UID ---
let BOSS_UID;
try {
  BOSS_UID = fs.readFileSync(adminPath, "utf-8").trim();
} catch (e) {
  console.error("❌ Invalid admin.txt");
  process.exit(1);
}

// Proxy
const INDIAN_PROXY = process.env.INDIAN_PROXY || "http://103.119.112.54:80";
let proxyAgent = null;
try {
  proxyAgent = new HttpsProxyAgent(INDIAN_PROXY);
} catch (e) {}

let api = null;

// State
let GROUP_THREAD_ID = null;
let LOCKED_GROUP_NAME = null;
let lockedNick = null;
let nickLockEnabled = false;
let nickRemoveEnabled = false;
let gcAutoRemoveEnabled = false;

// safe nickname change
async function setNickSafe(nick, threadID, uid) {
  return new Promise((resolve) => {
    try {
      api.changeNickname(nick, threadID, uid, (err) => {
        if (err) log(`❌ Nick change failed for ${uid}: ${err}`);
        resolve();
      });
    } catch (e) {
      log(`❌ Exception in changeNickname: ${e}`);
      resolve();
    }
  });
}

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT_EXCEPTION: " + err);
});
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED_REJECTION: " + err);
});

function startBot() {
  login(
    {
      appState,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FBAV/400.0.0.0.0",
      agent: proxyAgent,
    },
    (err, a) => {
      if (err) {
        console.error("❌ LOGIN FAILED: " + err);
        process.exit(1);
      }

      api = a;
      api.setOptions({ listenEvents: true, selfListen: true });

      log("🤖 BOT ONLINE");

      // Anti-sleep
      setInterval(() => {
        if (GROUP_THREAD_ID) {
          api.sendTypingIndicator(GROUP_THREAD_ID, true);
          setTimeout(() => api.sendTypingIndicator(GROUP_THREAD_ID, false), 1500);
          log("💤 Anti-Sleep Triggered");
        }
      }, 300000);

      // Save appstate
      setInterval(() => {
        try {
          fs.writeFileSync(appStatePath, JSON.stringify(api.getAppState(), null, 2));
          log("💾 AppState saved");
        } catch (e) {}
      }, 600000);

      // --- LISTENER ---
      api.listenMqtt(async (err, event) => {
        if (err) return log("❌ Listen error: " + err);

        const senderID = event.senderID;
        const threadID = String(event.threadID);
        const body = (event.body || "").toLowerCase();

        // 📨 Message logs
        if (event.type === "message") {
          log(`📩 ${senderID}: ${event.body}`);
        }

        // --- HELP ---
        if (body === "help" && senderID === BOSS_UID) {
          const msg = `
📜 COMMANDS:
🔒 /gclock <name>        → Lock GC name
🧹 /gcremove             → Remove GC name + Auto-remove ON
🔐 /nicklock on <nick>   → Lock nickname
🔓 /nicklock off         → Unlock nickname
💥 /nickremoveall        → Clear all nicknames + Auto-remove ON
🛑 /nickremoveoff        → Stop auto nick remove
📊 /status               → Show bot status`;
          return api.sendMessage(msg.trim(), threadID);
        }

        // --- GC LOCK ---
        if (body.startsWith("/gclock") && senderID === BOSS_UID) {
          const newName = (event.body || "").slice(7).trim();
          if (!newName) return api.sendMessage("❌ Provide a name", threadID);

          GROUP_THREAD_ID = threadID;
          LOCKED_GROUP_NAME = newName;
          gcAutoRemoveEnabled = false;
          await api.setTitle(newName, threadID);
          return api.sendMessage(`🔒 GC locked as "${newName}"`, threadID);
        }

        // --- GC REMOVE ---
        if (body === "/gcremove" && senderID === BOSS_UID) {
          await api.setTitle("", threadID);
          GROUP_THREAD_ID = threadID;
          LOCKED_GROUP_NAME = null;
          gcAutoRemoveEnabled = true;
          return api.sendMessage("🧹 GC name removed. Auto-remove ON", threadID);
        }

        // --- NickLock ON ---
        if (body.startsWith("/nicklock on") && senderID === BOSS_UID) {
          lockedNick = event.body.split(" ").slice(2).join(" ").trim();
          if (!lockedNick) return api.sendMessage("❌ Provide a nickname", threadID);

          nickLockEnabled = true;
          const info = await api.getThreadInfo(threadID);
          for (const u of info.userInfo) {
            await setNickSafe(lockedNick, threadID, u.id);
          }
          return api.sendMessage(`🔐 Nickname locked as "${lockedNick}"`, threadID);
        }

        // --- NickLock OFF ---
        if (body === "/nicklock off" && senderID === BOSS_UID) {
          nickLockEnabled = false;
          lockedNick = null;
          return api.sendMessage("🔓 NickLock OFF", threadID);
        }

        // --- NickRemoveAll ---
        if (body === "/nickremoveall" && senderID === BOSS_UID) {
          nickRemoveEnabled = true;
          const info = await api.getThreadInfo(threadID);
          for (const u of info.userInfo) {
            await setNickSafe("", threadID, u.id);
          }
          return api.sendMessage("💥 All nicknames cleared. Auto-remove ON", threadID);
        }

        // --- NickRemoveOff ---
        if (body === "/nickremoveoff" && senderID === BOSS_UID) {
          nickRemoveEnabled = false;
          return api.sendMessage("🛑 Auto nick remove OFF", threadID);
        }

        // --- STATUS ---
        if (body === "/status" && senderID === BOSS_UID) {
          const msg = `
BOT STATUS:
• GC Lock: ${LOCKED_GROUP_NAME || "OFF"}
• GC AutoRemove: ${gcAutoRemoveEnabled ? "ON" : "OFF"}
• NickLock: ${nickLockEnabled ? `ON (${lockedNick})` : "OFF"}
• NickAutoRemove: ${nickRemoveEnabled ? "ON" : "OFF"}`;
          return api.sendMessage(msg.trim(), threadID);
        }

        // --- Event handlers ---
        if (event.logMessageType === "log:thread-name") {
          const changed = event.logMessageData?.name || "";
          if (LOCKED_GROUP_NAME && threadID === GROUP_THREAD_ID && changed !== LOCKED_GROUP_NAME) {
            await api.setTitle(LOCKED_GROUP_NAME, threadID);
            log(`🔒 GC name reverted: ${LOCKED_GROUP_NAME}`);
          } else if (gcAutoRemoveEnabled && changed !== "") {
            await api.setTitle("", threadID);
            log(`🧹 GC name auto-removed: ${changed}`);
          }
        }

        if (event.logMessageType === "log:user-nickname") {
          const changedUID = event.logMessageData?.participant_id || event.logMessageData?.participantID;
          const newNick = event.logMessageData?.nickname || "";
          if (nickLockEnabled && newNick !== lockedNick) {
            await setNickSafe(lockedNick, threadID, changedUID);
            log(`🔐 Nick reverted for ${changedUID}`);
          }
          if (nickRemoveEnabled && newNick !== "") {
            await setNickSafe("", threadID, changedUID);
            log(`💥 Nick auto-removed for ${changedUID}`);
          }
        }

        if (event.logMessageType === "log:unsubscribe") {
          const leftUID = event.logMessageData?.leftParticipantFbId || event.logMessageData?.leftParticipantId;
          if (leftUID && threadID === GROUP_THREAD_ID) {
            try {
              await api.addUserToGroup(leftUID, threadID);
              log(`🚨 Anti-out: Added back ${leftUID}`);
            } catch (e) {
              log("❌ Anti-out failed: " + e);
            }
          }
        }
      });
    }
  );
}

startBot();
