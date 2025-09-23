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
let antiOutEnabled = false; // new: antioff/antion control

// helper: safe nickname change with double protection
async function setNickSafe(nick, threadID, uidToChange) {
  return new Promise(async (resolve) => {
    try {
      // primary set
      await new Promise((r) =>
        api.changeNickname(nick, threadID, uidToChange, (err) => {
          if (err) log(`❌ Nick change failed for ${uidToChange}: ${err}`);
          r();
        })
      );
      // second attempt after short delay (double protection)
      setTimeout(() => {
        try {
          api.changeNickname(nick, threadID, uidToChange, (err) => {
            if (err) log(`❌ (2nd try) Nick change failed for ${uidToChange}: ${err}`);
            else log(`🔐 (2x) Nick set for ${uidToChange}`);
            resolve();
          });
        } catch (e) {
          log(`❌ Exception 2nd try changeNickname: ${e}`);
          resolve();
        }
      }, 800);
    } catch (e) {
      log(`❌ Exception in changeNickname: ${e}`);
      resolve();
    }
  });
}

// helper: safe set title with double protection
async function setTitleSafe(title, threadID) {
  try {
    await new Promise((r) =>
      api.setTitle(title, threadID, (err) => {
        if (err) log("❌ setTitle failed: " + err);
        r();
      })
    );
    setTimeout(() => {
      try {
        api.setTitle(title, threadID, (err) => {
          if (err) log("❌ (2nd) setTitle failed: " + err);
          else log("🔒 (2x) Title enforced");
        });
      } catch (e) {
        log("❌ Exception second setTitle: " + e);
      }
    }, 900);
  } catch (e) {
    log("❌ Exception in setTitleSafe: " + e);
  }
}

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT_EXCEPTION: " + err);
});
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED_REJECTION: " + err);
});

function parseMentionTarget(event) {
  // return first mentioned uid if present
  try {
    if (event.mentions && typeof event.mentions === "object") {
      const keys = Object.keys(event.mentions);
      if (keys.length > 0) return keys[0];
    }
    // ws3-fca sometimes provides messageReply
    if (event.messageReply && event.messageReply.senderID) {
      return String(event.messageReply.senderID);
    }
  } catch (e) {}
  return null;
}

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
          try {
            api.sendTypingIndicator(GROUP_THREAD_ID, true);
            setTimeout(() => api.sendTypingIndicator(GROUP_THREAD_ID, false), 1500);
            log("💤 Anti-Sleep Triggered");
          } catch (e) {}
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

        const senderID = String(event.senderID || "");
        const threadID = String(event.threadID || "");
        const bodyRaw = event.body || "";
        const body = (bodyRaw || "").toLowerCase();

        // 📨 Message logs
        if (event.type === "message" && bodyRaw) {
          log(`📩 ${senderID}: ${bodyRaw}`);
        }

        // --- HELP ---
        if (body === "help" && senderID === BOSS_UID) {
          const msg = `
📜 COMMANDS:
🔒 /gclock <name>           → Lock GC name
🧹 /gcremove                → Remove GC name + Auto-remove ON
🔐 /nicklock on <nick>      → Lock nickname (adds "— Locked by ANURAG MISHRA")
🔓 /nicklock off            → Unlock nickname
💥 /nickremoveall           → Clear all nicknames + Auto-remove ON
🛑 /nickremoveoff           → Stop auto nick remove
📌 /setnick @user <nick>    → Set nickname for mentioned user (or reply + /setnick <nick>)
⚙️ /antion                  → Enable anti-out (adds back leavers automatically)
🛑 /antioff                 → Disable anti-out
🕵️‍ /status                 → Show bot status`;
          return api.sendMessage(msg.trim(), threadID);
        }

        // --- GC LOCK ---
        if (body.startsWith("/gclock") && senderID === BOSS_UID) {
          const newName = (bodyRaw || "").slice(7).trim();
          if (!newName) return api.sendMessage("❌ Provide a name", threadID);

          GROUP_THREAD_ID = threadID;
          LOCKED_GROUP_NAME = newName;
          gcAutoRemoveEnabled = false;
          await setTitleSafe(newName, threadID);
          return api.sendMessage(`🔒 GC locked as "${newName}"`, threadID);
        }

        // --- GC REMOVE ---
        if (body === "/gcremove" && senderID === BOSS_UID) {
          await setTitleSafe("", threadID);
          GROUP_THREAD_ID = threadID;
          LOCKED_GROUP_NAME = null;
          gcAutoRemoveEnabled = true;
          return api.sendMessage("🧹 GC name removed. Auto-remove ON", threadID);
        }

        // --- NickLock ON ---
        if (body.startsWith("/nicklock on") && senderID === BOSS_UID) {
          const requested = (bodyRaw || "").split(" ").slice(2).join(" ").trim();
          if (!requested) return api.sendMessage("❌ Provide a nickname", threadID);

          // lock signature
          lockedNick = `${requested} — Locked by ANURAG MISHRA`;
          nickLockEnabled = true;
          // apply to everyone in thread
          try {
            const info = await api.getThreadInfo(threadID);
            for (const u of info.userInfo) {
              await setNickSafe(lockedNick, threadID, u.id);
            }
            log(`🔐 NickLock applied: ${lockedNick}`);
            return api.sendMessage(`🔐 Nickname locked as "${lockedNick}"`, threadID);
          } catch (e) {
            log("❌ Error applying nicklock to all: " + e);
            return api.sendMessage("❌ Error applying nicklock to all", threadID);
          }
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
          try {
            const info = await api.getThreadInfo(threadID);
            for (const u of info.userInfo) {
              await setNickSafe("", threadID, u.id);
            }
            return api.sendMessage("💥 All nicknames cleared. Auto-remove ON", threadID);
          } catch (e) {
            log("❌ Error clearing nicks: " + e);
            return api.sendMessage("❌ Error clearing nicks");
          }
        }

        // --- NickRemoveOff ---
        if (body === "/nickremoveoff" && senderID === BOSS_UID) {
          nickRemoveEnabled = false;
          return api.sendMessage("🛑 Auto nick remove OFF", threadID);
        }

        // --- Set nick for a mentioned user (or reply) ---
        if (body.startsWith("/setnick") && senderID === BOSS_UID) {
          // Get target
          const target = parseMentionTarget(event);
          const args = (bodyRaw || "").split(" ").slice(target ? 1 : 1); // if mention present, slice after command; else same
          // If mention present, the mention text itself may be in bodyRaw; we should extract nick from remainder
          let requestedNick = "";
          if (target) {
            // find text after the mention name in the raw body
            // naive: remove first word (/setnick) and any mention token from bodyRaw
            const afterCmd = bodyRaw.split(" ").slice(1).join(" ").trim();
            // remove mention display (best-effort)
            const mentionNames = Object.values(event.mentions || {}).map((m) => m).filter(Boolean);
            let cleaned = afterCmd;
            if (mentionNames.length > 0) {
              // remove first mention display name from string
              cleaned = cleaned.replace(mentionNames[0], "").trim();
            }
            requestedNick = cleaned;
          } else {
            // maybe command was used as reply: event.messageReply exists
            requestedNick = (bodyRaw || "").split(" ").slice(1).join(" ").trim();
          }

          if (!target && !event.messageReply) {
            return api.sendMessage("❌ Mention a user or reply to their message and provide a nickname", threadID);
          }
          if (!requestedNick) return api.sendMessage("❌ Provide a nickname to set", threadID);

          const finalNick = `${requestedNick} — Locked by ANURAG MISHRA`;
          const victimId = target || String(event.messageReply.senderID);
          try {
            await setNickSafe(finalNick, threadID, victimId);
            return api.sendMessage(`✅ Nick for ${victimId} set to "${finalNick}"`, threadID);
          } catch (e) {
            log("❌ Error setting nick for target: " + e);
            return api.sendMessage("❌ Error setting nick for target");
          }
        }

        // --- STATUS ---
        if (body === "/status" && senderID === BOSS_UID) {
          const msg = `
BOT STATUS:
• GC Lock: ${LOCKED_GROUP_NAME || "OFF"}
• GC AutoRemove: ${gcAutoRemoveEnabled ? "ON" : "OFF"}
• NickLock: ${nickLockEnabled ? `ON (${lockedNick})` : "OFF"}
• NickAutoRemove: ${nickRemoveEnabled ? "ON" : "OFF"}
• Anti-Out: ${antiOutEnabled ? "ON" : "OFF"}`;
          return api.sendMessage(msg.trim(), threadID);
        }

        // --- Anti-out commands ---
        if (body === "/antion" && senderID === BOSS_UID) {
          antiOutEnabled = true;
          return api.sendMessage("✅ Anti-Out ENABLED", threadID);
        }
        if (body === "/antioff" && senderID === BOSS_UID) {
          antiOutEnabled = false;
          return api.sendMessage("🛑 Anti-Out DISABLED", threadID);
        }

        // --- Event handlers ---
        // Thread name change
        if (event.logMessageType === "log:thread-name") {
          const changed = event.logMessageData?.name || "";
          if (LOCKED_GROUP_NAME && threadID === GROUP_THREAD_ID && changed !== LOCKED_GROUP_NAME) {
            await setTitleSafe(LOCKED_GROUP_NAME, threadID);
            log(`🔒 GC name reverted: ${LOCKED_GROUP_NAME}`);
          } else if (gcAutoRemoveEnabled && changed !== "") {
            await setTitleSafe("", threadID);
            log(`🧹 GC name auto-removed: ${changed}`);
          }
        }

        // Nickname change (someone changed nick)
        if (event.logMessageType === "log:user-nickname") {
          // participant id key differences accounted for
          const changedUID = event.logMessageData?.participant_id || event.logMessageData?.participantID;
          const newNick = event.logMessageData?.nickname || "";
          if (nickLockEnabled && lockedNick) {
            const expected = lockedNick;
            if (newNick !== expected) {
              // revert with double protection
              await setNickSafe(expected, threadID, changedUID);
              log(`🔐 Nick reverted for ${changedUID}`);
            }
          }
          if (nickRemoveEnabled && newNick !== "") {
            await setNickSafe("", threadID, changedUID);
            log(`💥 Nick auto-removed for ${changedUID}`);
          }
        }

        // User left / removed (anti-out)
        if (event.logMessageType === "log:unsubscribe" || event.logMessageType === "log:remove" || event.logMessageType === "log:remove-participant") {
          const leftUID = event.logMessageData?.leftParticipantFbId || event.logMessageData?.leftParticipantId || event.logMessageData?.user_id;
          if (leftUID && threadID === GROUP_THREAD_ID && antiOutEnabled) {
            try {
              await api.addUserToGroup(String(leftUID), threadID);
              log(`🚨 Anti-out: Added back ${leftUID}`);
              api.sendMessage(`🚨 Anti-Out: Added back ${leftUID}`, threadID);
            } catch (e) {
              log("❌ Anti-out failed: " + e);
            }
          }
        }

        // Message unsend / delete detection
        // ws3-fca may provide event.type === "message_unsend" or logMessageType variations
        if (event.type === "message_unsend" || event.logMessageType === "log:thread-message-deleted" || event.logMessageType === "log:message_unsend") {
          try {
            // try to get message id / sender from event
            const unsendBy = event.senderID || event.logMessageData?.actorFbId || event.logMessageData?.authorId;
            const deletedMessageId = event.logMessageData?.messageID || event.messageID || event.logMessageData?.message_id;
            const deletedBy = unsendBy ? String(unsendBy) : "Unknown";
            const txt = `🗑️ Message deleted by: ${deletedBy}\nMessageID: ${deletedMessageId || "N/A"}`;
            log(`🗑️ ${txt}`);
            // Inform thread
            try {
              api.sendMessage(txt, threadID);
            } catch (e) {}
          } catch (e) {
            log("❌ Error handling unsend event: " + e);
          }
        }

        // Fallback protection: if title changed in any thread where LOCKED_GROUP_NAME set, enforce
        if (event.logMessageType && LOCKED_GROUP_NAME && threadID === GROUP_THREAD_ID && event.logMessageType !== "log:thread-name") {
          // do nothing special here unless we detect a name change above
        }
      });
    }
  );
}

startBot();
