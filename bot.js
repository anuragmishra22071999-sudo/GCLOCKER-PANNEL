const ws3 = require('ws3-fca');
const login = typeof ws3 === 'function' ? ws3 : (ws3.default || ws3.login || ws3);
const fs = require('fs');
const path = require('path');
const HttpsProxyAgent = require('https-proxy-agent');

const uid = process.argv[2];
if (!uid) {
  console.error('❌ No UID provided to bot.js');
  process.exit(1);
}

const userDir = path.join(__dirname, 'users', String(uid));
const appStatePath = path.join(userDir, 'appstate.json');
const adminPath = path.join(userDir, 'admin.txt');

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// Load AppState
let appState;
try {
  const raw = fs.readFileSync(appStatePath, 'utf-8');
  if (!raw.trim()) throw new Error('File empty');
  appState = JSON.parse(raw);
} catch (e) {
  console.error('❌ appstate.json invalid or empty.');
  process.exit(1);
}

// Load Admin UID
let BOSS_UID;
try {
  BOSS_UID = fs.readFileSync(adminPath, 'utf-8').trim();
  if (!BOSS_UID) throw new Error('UID missing');
} catch (e) {
  console.error('❌ admin.txt invalid or empty.');
  process.exit(1);
}

// Optional Proxy
const INDIAN_PROXY = process.env.INDIAN_PROXY || 'http://103.119.112.54:80';
let proxyAgent = null;
try {
  proxyAgent = new HttpsProxyAgent(INDIAN_PROXY);
} catch (e) {
  proxyAgent = null;
}

// State
let GROUP_THREAD_ID = null;
let LOCKED_GROUP_NAME = null;
let lockedNick = null;
let nickLockEnabled = false;
let nickRemoveEnabled = false;
let gcAutoRemoveEnabled = false;

let api = null;

function setNickSafe(nick, threadID, uid) {
  return new Promise((resolve) => {
    try {
      api.changeNickname(nick, threadID, uid, (err) => {
        if (err) log(`❌ Nick change failed for ${uid}: ${err}`);
        resolve();
      });
    } catch (e) {
      log(`❌ changeNickname exception: ${e}`);
      resolve();
    }
  });
}

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT_EXCEPTION: ' + err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED_REJECTION: ' + err);
  process.exit(1);
});

function startBot() {
  login(
    {
      appState,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FBAV/400.0.0.0.0',
      agent: proxyAgent,
    },
    (err, a) => {
      if (err) {
        console.error('❌ [LOGIN FAILED]: ' + err);
        // exit so parent knows and can restart / user can inspect logs
        setTimeout(() => process.exit(1), 10000);
        return;
      }

      api = a;

      api.setOptions({
        listenEvents: true,
        selfListen: true,
        updatePresence: true,
      });

      log('🤖 BOT ONLINE — Running now');

      // Anti-Sleep
      setInterval(() => {
        if (GROUP_THREAD_ID) {
          try {
            api.sendTypingIndicator(String(GROUP_THREAD_ID), true);
            setTimeout(() => api.sendTypingIndicator(String(GROUP_THREAD_ID), false), 1500);
            log('💤 Anti-Sleep Triggered');
          } catch (e) {
            log('Anti-Sleep error: ' + e);
          }
        }
      }, 300000);

      // Auto-save AppState
      setInterval(() => {
        try {
          const newAppState = (api.getAppState && api.getAppState()) || appState;
          fs.writeFileSync(appStatePath, JSON.stringify(newAppState, null, 2));
          log('💾 AppState saved ✅');
        } catch (e) {
          log('❌ Failed saving AppState: ' + e);
        }
      }, 600000);

      // Listener
      function listen() {
        try {
          api.listenMqtt(async (err, event) => {
            if (err) {
              log('❌ Listen error: ' + err);
              setTimeout(listen, 5000);
              return;
            }

            const senderID = event.senderID;
            const threadID = String(event.threadID);
            const body = (event.body || '').toLowerCase();

            if (event.type === 'message') {
              log(`📩 ${senderID}: ${event.body} (Group: ${threadID})`);
            }

            // HELP (without prefix)
            if (body === 'help' && String(senderID) === String(BOSS_UID)) {
              const helpMsg = `\n📜 𝗔𝗩𝗔𝗜𝗟𝗔𝗕𝗟𝗘 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦 📜\n\n🔒 /gclock <name>   → Lock group name\n🧹 /gcremove        → Remove GC name + Auto-remove ON\n🔐 /nicklock on <nick> → Lock nickname\n🔓 /nicklock off    → Unlock nickname\n💥 /nickremoveall   → Remove all nicknames + Auto-remove ON\n🛑 /nickremoveoff   → Stop auto nick remove\n📊 /status          → Show current bot status\n`;
              api.sendMessage(helpMsg.trim(), threadID);
            }

            // /gclock
            if (body.startsWith('/gclock') && String(senderID) === String(BOSS_UID)) {
              try {
                const newName = (event.body || '').slice(7).trim();
                if (!newName) return api.sendMessage('❌ Please provide a group name', threadID);

                GROUP_THREAD_ID = threadID;
                LOCKED_GROUP_NAME = newName;
                gcAutoRemoveEnabled = false;

                await api.setTitle(LOCKED_GROUP_NAME, threadID);
                api.sendMessage(`🔒 Group name locked: "${LOCKED_GROUP_NAME}"`, threadID);
              } catch (e) {
                log('❌ Failed to lock group name: ' + e);
                api.sendMessage('❌ Failed to lock group name', threadID);
              }
            }

            // /gcremove
            if (body === '/gcremove' && String(senderID) === String(BOSS_UID)) {
              try {
                await api.setTitle('', threadID);
                LOCKED_GROUP_NAME = null;
                GROUP_THREAD_ID = threadID;
                gcAutoRemoveEnabled = true;
                api.sendMessage('🧹 Name removed. Auto-remove ON ✅', threadID);
              } catch (e) {
                log('❌ Failed to remove GC name: ' + e);
                api.sendMessage('❌ Failed to remove name', threadID);
              }
            }

            // Handle thread-name changes
            if (event.logMessageType === 'log:thread-name') {
              const changed = event.logMessageData && event.logMessageData.name;
              if (LOCKED_GROUP_NAME && threadID === GROUP_THREAD_ID && changed !== LOCKED_GROUP_NAME) {
                try {
                  await api.setTitle(LOCKED_GROUP_NAME, threadID);
                } catch (e) {
                  log('❌ Failed reverting GC name: ' + e);
                }
              } else if (gcAutoRemoveEnabled) {
                try {
                  await api.setTitle('', threadID);
                  log(`🧹 GC name auto-removed: "${changed}"`);
                } catch (e) {
                  log('❌ Failed auto-remove GC name: ' + e);
                }
              }
            }

            // /nicklock on <nick>
            if (body.startsWith('/nicklock on') && String(senderID) === String(BOSS_UID)) {
              const parts = (event.body || '').split(' ');
              lockedNick = parts.slice(2).join(' ').trim();
              if (!lockedNick) return api.sendMessage('❌ Please provide a nickname', threadID);

              nickLockEnabled = true;
              try {
                const info = await api.getThreadInfo(threadID);
                for (const u of info.userInfo) {
                  await setNickSafe(lockedNick, threadID, String(u.id));
                }
                api.sendMessage(`🔐 Nickname locked: "${lockedNick}"`, threadID);
              } catch (e) {
                log('❌ Failed setting nick: ' + e);
                api.sendMessage('❌ Failed setting nick', threadID);
              }
            }

            // /nicklock off
            if (body === '/nicklock off' && String(senderID) === String(BOSS_UID)) {
              nickLockEnabled = false;
              lockedNick = null;
              api.sendMessage('🔓 Nickname lock disabled', threadID);
            }

            // /nickremoveall
            if (body === '/nickremoveall' && String(senderID) === String(BOSS_UID)) {
              nickRemoveEnabled = true;
              try {
                const info = await api.getThreadInfo(threadID);
                for (const u of info.userInfo) {
                  await setNickSafe('', threadID, String(u.id));
                }
                api.sendMessage('💥 Nicknames cleared. Auto-remove ON', threadID);
              } catch (e) {
                log('❌ Failed removing nicknames: ' + e);
                api.sendMessage('❌ Failed removing nicknames', threadID);
              }
            }

            // /nickremoveoff
            if (body === '/nickremoveoff' && String(senderID) === String(BOSS_UID)) {
              nickRemoveEnabled = false;
              api.sendMessage('🛑 Nick auto-remove OFF', threadID);
            }

            // Handle nickname changes
            if (event.logMessageType === 'log:user-nickname') {
              const changedUID = event.logMessageData && (event.logMessageData.participant_id || event.logMessageData.participantID);
              const newNick = event.logMessageData && (event.logMessageData.nickname || '');

              if (nickLockEnabled && newNick !== lockedNick) {
                await setNickSafe(lockedNick, threadID, String(changedUID));
              }

              if (nickRemoveEnabled && newNick !== '') {
                await setNickSafe('', threadID, String(changedUID));
              }
            }

            // Anti-out (auto add back)
            if (event.logMessageType === 'log:unsubscribe') {
              const leftUID = event.logMessageData && (event.logMessageData.leftParticipantFbId || event.logMessageData.leftParticipantId);
              if (leftUID && threadID === GROUP_THREAD_ID) {
                try {
                  await api.addUserToGroup(leftUID, threadID);
                  log(`🚨 Anti-out: Added back ${leftUID}`);
                } catch (e) {
                  log('❌ Failed anti-out re-add: ' + e);
                }
              }
            }

            // /status
            if (body === '/status' && String(senderID) === String(BOSS_UID)) {
              const msg = `\nBOT STATUS:\n• GC Lock: ${LOCKED_GROUP_NAME || 'OFF'}\n• GC AutoRemove: ${gcAutoRemoveEnabled ? 'ON' : 'OFF'}\n• Nick Lock: ${nickLockEnabled ? `ON (${lockedNick})` : 'OFF'}\n• Nick AutoRemove: ${nickRemoveEnabled ? 'ON' : 'OFF'}\n`;
              api.sendMessage(msg.trim(), threadID);
            }

          });
        } catch (e) {
          log('❌ Listener crashed: ' + e);
          setTimeout(listen, 5000);
        }
      }

      listen();
    }
  );
}

startBot();
