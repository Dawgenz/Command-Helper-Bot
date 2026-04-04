require("dotenv").config();

const REQUIRED_ENV = ['DISCORD_TOKEN', 'CLIENT_ID', 'CLIENT_SECRET', 'REDIRECT_URI', 'SESSION_SECRET', 'ADMIN_DISCORD_ID', 'ADMIN_SECRET'];
const missingEnv = REQUIRED_ENV.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
    console.error(`❌ Missing required environment variables: ${missingEnv.join(', ')}`);
    process.exit(1);
}

process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
    try {
        db.prepare("INSERT INTO audit_logs (guild_id, action, details) VALUES (?, ?, ?)").run(
            'SYSTEM', 'ERROR', `Unhandled rejection: ${error?.message || String(error)}`
        );
    } catch (e) { /* db might not be ready */ }
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    try {
        db.prepare("INSERT INTO audit_logs (guild_id, action, details) VALUES (?, ?, ?)").run(
            'SYSTEM', 'ERROR', `Uncaught exception: ${error?.message || String(error)}`
        );
    } catch (e) {}
    process.exit(1);
});

const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  EmbedBuilder,
  Partials,
} = require("discord.js");
const Database = require("better-sqlite3");
const express = require("express");
const cookieParser = require('cookie-parser');
const passport = require("passport");
const { Strategy } = require("passport-discord");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);

const db = new Database("database.db");
const app = express();
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions, // Added for the link reaction
    GatewayIntentBits.DirectMessages, // Added for DMing the link
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.User],
});
db.prepare(
  `CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    guild_name TEXT,
    forum_id TEXT,
    resolved_tag TEXT,
    duplicate_tag TEXT,
    unanswered_tag TEXT,
    helper_role_id TEXT
)`
).run();

db.prepare(
  `CREATE TABLE IF NOT EXISTS thread_tracking (
    thread_id TEXT PRIMARY KEY,
    guild_id TEXT,
    created_at INTEGER,
    stale_warning_sent INTEGER DEFAULT 0,
    last_renewed_at INTEGER
)`
).run();

db.prepare(
  "CREATE TABLE IF NOT EXISTS pending_locks (thread_id TEXT PRIMARY KEY, guild_id TEXT, lock_at INTEGER)"
).run();

db.prepare(
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, 
    guild_id TEXT, 
    action TEXT, 
    details TEXT, 
    user_id TEXT,
    user_name TEXT,
    user_avatar TEXT,
    command_used TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`
).run();

db.prepare(
  `
CREATE TABLE IF NOT EXISTS snippets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    title TEXT,
    description TEXT,
    color TEXT,
    fields TEXT,
    footer TEXT,
    enabled INTEGER DEFAULT 1,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(guild_id, name)
)
`
).run();

db.prepare(
  `CREATE TABLE IF NOT EXISTS thread_links (
    thread_id TEXT PRIMARY KEY,
    guild_id TEXT,
    url TEXT,
    created_by TEXT,
    created_at INTEGER
)`
).run();

db.prepare(`
    CREATE TABLE IF NOT EXISTS reaction_triggers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT,
        target_user_id TEXT,
        reaction_id TEXT,
        trigger_count INTEGER,
        response_text TEXT DEFAULT 'L color',
        enabled INTEGER DEFAULT 1
    )
`).run();

db.prepare(`
    CREATE TABLE IF NOT EXISTS triggered_messages (
        message_id TEXT,
        trigger_id INTEGER,
        PRIMARY KEY (message_id, trigger_id)
    )
`).run();

db.prepare(`
    CREATE TABLE IF NOT EXISTS blocked_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT,
        user_id TEXT,
        reason TEXT,
        blocked_by TEXT,
        blocked_at INTEGER,
        UNIQUE(guild_id, user_id)
    )
`).run();

db.prepare(`
    CREATE TABLE IF NOT EXISTS banned_users (
        user_id TEXT PRIMARY KEY,
        reason TEXT,
        banned_by TEXT,
        banned_at INTEGER
    )
`).run();

db.prepare(`
    CREATE TABLE IF NOT EXISTS command_cooldowns (
        user_id TEXT,
        guild_id TEXT,
        command TEXT,
        last_used INTEGER,
        use_count INTEGER DEFAULT 1,
        PRIMARY KEY (user_id, guild_id, command)
    )
`).run();

db.prepare(`
    CREATE TABLE IF NOT EXISTS suspended_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT,
        user_id TEXT,
        reason TEXT,
        suspended_at INTEGER,
        expires_at INTEGER,
        UNIQUE(guild_id, user_id)
    )
`).run();

try {
    db.prepare(`ALTER TABLE guild_settings ADD COLUMN fun_features_enabled INTEGER DEFAULT 1`).run();
} catch (e) { /* Column already exists */ }

try {
  db.prepare(`ALTER TABLE snippets ADD COLUMN url TEXT`).run();
  db.prepare(`ALTER TABLE snippets ADD COLUMN image_url TEXT`).run();
  db.prepare(`ALTER TABLE snippets ADD COLUMN thumbnail_url TEXT`).run();
} catch (e) {
  // Columns already exist
}

try {
  db.prepare(`ALTER TABLE audit_logs ADD COLUMN thread_id TEXT`).run();
  db.prepare(`ALTER TABLE audit_logs ADD COLUMN message_id TEXT`).run();
} catch (e) {
  /* Columns exist */
}

try {
  db.prepare(`ALTER TABLE guild_settings ADD COLUMN unanswered_tag TEXT`).run();
} catch (e) {
  /* Column exists */
}

try {
  db.prepare(
    `ALTER TABLE thread_tracking ADD COLUMN stale_warning_sent INTEGER DEFAULT 0`
  ).run();
  db.prepare(
    `ALTER TABLE thread_tracking ADD COLUMN last_renewed_at INTEGER`
  ).run();
} catch (e) {
  /* Columns exist */
}

// --- HELPERS ---
const getSettings = (guildId) =>
  db.prepare("SELECT * FROM guild_settings WHERE guild_id = ?").get(guildId);

function getNav(activePage, user) {
  const current = activePage === "home" ? "overview" : activePage;
  const pages = ["overview", "snippets", "threads", "fun", "logs"];
  const isAdmin = user && user.id === process.env.ADMIN_DISCORD_ID;

  const profileSection = user
    ? `
        <div class="flex items-center gap-4 bg-slate-900/80 px-4 py-2 rounded-full border border-slate-800 shadow-xl">
            <div class="text-right hidden sm:block">
                <p class="text-[10px] font-black text-white uppercase leading-none">${user.username}</p>
                <a href="/logout" class="text-[8px] font-bold text-rose-500 uppercase hover:text-rose-400 transition-colors">Terminate Session</a>
            </div>
            <img src="https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png" class="w-8 h-8 rounded-full border-2 border-[#FFAA00]">
        </div>
    `
    : "";

  return `
    <nav class="flex flex-col md:flex-row items-center justify-between gap-6 mb-12">
        <div class="flex items-center gap-4">
            <img src="${client.user.displayAvatarURL()}" class="w-10 h-10 rounded-xl shadow-lg border border-[#FFAA00]/30">
            <div>
                <h1 class="text-lg font-black text-white uppercase tracking-tighter leading-none">Impulse</h1>
                <p class="text-[8px] font-bold text-[#FFAA00] uppercase tracking-[0.3em]">Bot Dashboard</p>
            </div>
        </div>

        <div class="flex items-center bg-slate-900/50 p-1.5 rounded-2xl border border-slate-800 backdrop-blur-md">
            ${[...pages, ...(isAdmin ? ["admin"] : [])]
              .map(
                (p) => `
                <a href="/${p === "overview" ? "" : p}"
                   class="px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
                     current === p
                       ? "bg-[#FFAA00] text-black shadow-lg shadow-amber-500/10"
                       : "text-slate-500 hover:text-white"
                   }">
                    ${p}
                </a>
            `
              )
              .join("")}
        </div>

        ${profileSection}
    </nav>
    `;
}

function getAdminNav(activePage) {
    const pages = ['overview', 'users', 'errors', 'database', 'system'];
    return `
    <nav class="flex flex-col md:flex-row items-center justify-between gap-6 mb-12">
        <div class="flex items-center gap-4">
            <div class="w-10 h-10 rounded-xl bg-red-500/20 border border-red-500/40 flex items-center justify-center">
                <svg class="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
                </svg>
            </div>
            <div>
                <h1 class="text-lg font-black text-white uppercase tracking-tighter leading-none">Impulse <span class="text-red-400">Admin</span></h1>
                <p class="text-[8px] font-bold text-red-500 uppercase tracking-[0.3em]">Control Panel • Restricted</p>
            </div>
        </div>

        <div class="flex items-center bg-slate-900/50 p-1.5 rounded-2xl border border-red-900/30 backdrop-blur-md">
            ${pages.map(p => `
                <a href="/admin/${p === 'overview' ? '' : p}" 
                   class="px-5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
                     activePage === p
                       ? "bg-red-500 text-white shadow-lg shadow-red-500/20"
                       : "text-slate-500 hover:text-white"
                   }">
                    ${p}
                </a>
            `).join('')}
        </div>

        <div class="flex items-center gap-3">
            <span class="text-[9px] font-black text-red-500 uppercase tracking-widest bg-red-500/10 px-3 py-1.5 rounded-lg border border-red-500/20">⚡ Root Access</span>
            <a href="/admin/logout" class="text-[9px] font-black text-slate-500 hover:text-white uppercase tracking-widest transition">Terminate →</a>
        </div>
    </nav>`;
}

const logAction = (
  guildId,
  action,
  details,
  userId = null,
  userName = null,
  userAvatar = null,
  command = null,
  threadId = null,
  messageId = null
) => {
  db.prepare(
    "INSERT INTO audit_logs (guild_id, action, details, user_id, user_name, user_avatar, command_used, thread_id, message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    guildId,
    action,
    details,
    userId,
    userName,
    userAvatar,
    command,
    threadId,
    messageId
  );
};

function hasHelperRole(member, settings) {
  if (!settings.helper_role_id) return false;
  const roleIDs = settings.helper_role_id.split(",").map((id) => id.trim());
  return member.roles.cache.some((role) => roleIDs.includes(role.id));
}

function isUserBlocked(userId, guildId) {
    const banned = db.prepare("SELECT 1 FROM banned_users WHERE user_id = ?").get(userId);
    if (banned) return { blocked: true, reason: "You are globally banned from using this bot." };
    const blocked = db.prepare("SELECT reason FROM blocked_users WHERE user_id = ? AND guild_id = ?").get(userId, guildId);
    if (blocked) return { blocked: true, reason: `You are blocked from using bot commands in this server.${blocked.reason ? ` Reason: ${blocked.reason}` : ''}` };
    const suspended = db.prepare("SELECT reason, expires_at FROM suspended_users WHERE user_id = ? AND guild_id = ?").get(userId, guildId);
    if (suspended) {
        if (suspended.expires_at && Date.now() > suspended.expires_at) {
            db.prepare("DELETE FROM suspended_users WHERE user_id = ? AND guild_id = ?").run(userId, guildId);
            return { blocked: false };
        }
        const expiresIn = suspended.expires_at ? `<t:${Math.floor(suspended.expires_at / 1000)}:R>` : 'indefinitely';
        return { blocked: true, reason: `You are temporarily suspended from using bot commands. Expires ${expiresIn}.` };
    }
    return { blocked: false };
}

// Returns true if the user should be rate limited, auto-suspends on spam
function checkCooldown(userId, guildId, command, limitSeconds = 10, maxUses = 3) {
    const now = Date.now();
    const window = limitSeconds * 1000;
    const row = db.prepare("SELECT last_used, use_count FROM command_cooldowns WHERE user_id = ? AND guild_id = ? AND command = ?").get(userId, guildId, command);
    
    if (!row) {
        db.prepare("INSERT INTO command_cooldowns (user_id, guild_id, command, last_used, use_count) VALUES (?, ?, ?, ?, 1)").run(userId, guildId, command, now);
        return { limited: false };
    }

    const timeSince = now - row.last_used;
    if (timeSince > window) {
        // Reset window
        db.prepare("UPDATE command_cooldowns SET last_used = ?, use_count = 1 WHERE user_id = ? AND guild_id = ? AND command = ?").run(now, userId, guildId, command);
        return { limited: false };
    }

    const newCount = row.use_count + 1;
    db.prepare("UPDATE command_cooldowns SET use_count = ?, last_used = ? WHERE user_id = ? AND guild_id = ? AND command = ?").run(newCount, now, userId, guildId, command);

    if (newCount > maxUses) {
        // Auto-suspend for 10 minutes on spam
        const suspendUntil = now + 10 * 60 * 1000;
        db.prepare("INSERT OR REPLACE INTO suspended_users (guild_id, user_id, reason, suspended_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(
            guildId, userId, `Auto-suspended: Spammed /${command} ${newCount} times in ${limitSeconds}s`, now, suspendUntil
        );
        return { limited: true, suspended: true, message: `⚠️ You've been temporarily suspended for 10 minutes due to command spam.` };
    }

    const retryAfter = Math.ceil((window - timeSince) / 1000);
    return { limited: true, message: `⏳ Slow down! You can use this command again in **${retryAfter}s**.` };
}

function parseVars(text, interaction = null) {
  if (!text || text === "null") return "";
  let processed = String(text);

  if (interaction) {
    processed = processed
      .replace(/{user}/g, interaction.user.toString())
      .replace(/{username}/g, interaction.user.username)
      .replace(/{server}/g, interaction.guild.name)
      .replace(/{channel}/g, interaction.channel.toString());
  }

  processed = processed.replace(/{br}/g, "\n");

  return processed.length > 4000
    ? processed.substring(0, 4000) + "..."
    : processed.replace(/{br}/g, "\n");
}

function sanitize(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function getErrorPage(title, message, code = "403") {
  return `
    <html>
    ${getHead("Impulse | " + title)}
    <body class="bg-[#0b0f1a] text-slate-200 min-h-screen flex items-center justify-center p-6">
        <div class="max-w-md w-full text-center space-y-6">
            <div class="relative">
                <h1 class="text-9xl font-black text-white/5 tracking-tighter select-none">${code}</h1>
                <div class="absolute inset-0 flex items-center justify-center">
                    <div class="w-16 h-16 bg-[#FFAA00]/20 rounded-full flex items-center justify-center border border-[#FFAA00]/50 animate-pulse">
                        <svg class="w-8 h-8 text-[#FFAA00]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                        </svg>
                    </div>
                </div>
            </div>
            
            <div class="space-y-2">
                <h2 class="text-2xl font-black text-white uppercase tracking-tight">${title}</h2>
                <p class="text-slate-500 text-sm font-medium leading-relaxed">${message}</p>
            </div>

            <div class="pt-4">
                <a href="/" class="inline-block bg-slate-900 hover:bg-slate-800 text-white px-8 py-3 rounded-xl border border-slate-800 text-xs font-black uppercase tracking-widest transition-all">
                    Return to Dashboard
                </a>
            </div>
        </div>
    </body>
    </html>
    `;
}

function getDiscordLink(guildId, channelId, messageId = null) {
  if (messageId) {
    return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
  }
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

function getReadableName(channelId, guildId) {
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return `Channel ${channelId.slice(-4)}`;

    const channel = guild.channels.cache.get(channelId);
    if (!channel) return `Channel ${channelId.slice(-4)}`;

    return channel.name;
  } catch (e) {
    return `Channel ${channelId.slice(-4)}`;
  }
}

// --- PASSPORT / OAUTH2 CONFIG ---
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(
  new Strategy(
    {
      clientID: process.env.CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET,
      callbackURL: process.env.REDIRECT_URI,
      scope: ["identify", "guilds", "guilds.members.read"],
    },
    (accessToken, refreshToken, profile, done) => {
      process.nextTick(() => done(null, profile));
    }
  )
);

app.use(
  session({
    store: new SQLiteStore({ db: "database.db", table: "sessions", dir: "./" }),
    secret: process.env.SESSION_SECRET || "keyboard cat",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
  })
);
app.use(passport.initialize());
app.use(cookieParser());

const rateLimit = require('express-rate-limit');
app.use('/auth', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Too many auth attempts, try again later.'
}));
app.use('/admin/login', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Too many admin login attempts.'
}));

app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: true, limit: '50kb' }));
app.use(passport.session());

const adminSessions = new Map();
function getAdminSession(req) {
    const token = req.cookies?.admin_token;
    if (!token) return null;
    const session = adminSessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expires) {
        adminSessions.delete(token);
        return null;
    }
    session.expires = Date.now() + 2 * 60 * 60 * 1000; // refresh on activity
    return session;
}

function requireAdmin(req, res, next) {
    // Layer 2: Must be logged in via Discord OAuth
    if (!req.isAuthenticated()) return res.redirect('/auth/discord');
    
    // Layer 2: Must be your specific Discord account
    if (req.user.id !== process.env.ADMIN_DISCORD_ID) {
        return res.status(403).send(getErrorPage(
            "Access Denied",
            "This area is restricted to authorized personnel only.",
            "403"
        ));
    }

    // Layer 3: Must have active admin session token
    const adminSession = getAdminSession(req);
    if (!adminSession) return res.redirect('/admin/login');

    next();
}

// --- ROUTES ---
app.get("/auth/discord", passport.authenticate("discord"));
app.get(
  "/auth/discord/callback",
  passport.authenticate("discord", { failureRedirect: "/" }),
  (req, res) => res.redirect("/")
);
app.get("/logout", (req, res) => {
  req.logout(() => res.redirect("/"));
});

// HELPER: Shared Header/Favicon HTML
const getHead = (title) => `
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"> 
        <title>${title}</title>
        <link rel="icon" type="image/png" href="${client.user?.displayAvatarURL() || 'https://cdn.discordapp.com/embed/avatars/0.png'}">
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;500;700&family=JetBrains+Mono&display=swap');
            body { font-family: 'Space Grotesk', sans-serif; }
            .mono { font-family: 'JetBrains Mono', monospace; }
            .glow-amber { box-shadow: 0 0 20px rgba(255, 170, 0, 0.15); }
            .border-amber { border-color: rgba(255, 170, 0, 0.3); }
            ::-webkit-scrollbar { width: 8px; }
            ::-webkit-scrollbar-track { background: #0b0f1a; }
            ::-webkit-scrollbar-thumb { background: #334155; border-radius: 10px; }
            ::-webkit-scrollbar-thumb:hover { background: #FFAA00; }
            .no-scrollbar::-webkit-scrollbar { display: none; }
        </style>
    </head>
`;

async function canManageSnippet(req, guild_id) {
  try {
    let guild = client.guilds.cache.get(guild_id);
    if (!guild) guild = await client.guilds.fetch(guild_id);

    const member = await guild.members.fetch(req.user.id);
    const settings = getSettings(guild_id);
    return (
      member.permissions.has(PermissionFlagsBits.Administrator) ||
      hasHelperRole(member, settings)
    );
  } catch (e) {
    return false;
  }
}

const getActionColor = (action) => {
  const colors = {
    SNIPPET_CREATE: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    SNIPPET_UPDATE: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    SNIPPET_DELETE: "bg-rose-500/10 text-rose-400 border-rose-500/20",
    SNIPPET: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    LOCK: "bg-amber-500/10 text-amber-500 border-amber-500/20",
    CANCEL: "bg-orange-500/10 text-orange-500 border-orange-500/20",
    GREET: "bg-indigo-500/10 text-indigo-400 border-indigo-500/20",
    DUPLICATE: "bg-sky-500/10 text-sky-500 border-sky-500/20",
    SETUP: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
    RESOLVED: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
    ANSWERED: "bg-green-500/10 text-green-500 border-green-500/20",
    AUTO_CLOSE: "bg-gray-500/10 text-gray-500 border-gray-500/20",
    STALE_WARNING: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
    THREAD_RENEWED: "bg-cyan-500/10 text-cyan-500 border-cyan-500/20",
    LINK_ADDED: "bg-blue-600/10 text-blue-600 border-blue-600/20",
    LINK_ACCESSED: "bg-purple-500/10 text-purple-500 border-purple-500/20",
    LINK_REMOVED: "bg-red-500/10 text-red-500 border-red-500/20",
    TRIGGER_CREATE: "bg-pink-500/10 text-pink-400 border-pink-500/20",
    USER_BLOCKED: "bg-red-600/10 text-red-400 border-red-600/20",
    USER_UNBLOCKED: "bg-teal-500/10 text-teal-400 border-teal-500/20",
    USER_BANNED: "bg-red-900/20 text-red-300 border-red-900/30",
    USER_UNBANNED: "bg-teal-600/10 text-teal-300 border-teal-600/20",
    AUTO_SUSPEND: "bg-orange-500/10 text-orange-400 border-orange-500/20",
    BULK_CLOSE: "bg-slate-500/10 text-slate-300 border-slate-500/20",
  };
  return colors[action] || "bg-slate-800 text-slate-400 border-slate-700";
};

function getManagedGuilds(userId) {
  return client.guilds.cache
    .filter((guild) => {
      const member = guild.members.cache.get(userId);
      if (!member) return false;

      const settings = getSettings(guild.id);
      const isHandler = hasHelperRole(member, settings);
      const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);

      return isHandler || isAdmin;
    })
    .map((guild) => guild.id);
}

app.get("/", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.send(`
        <html>
        ${getHead("Impulse | Terminal Access")}
        <body class="bg-[#0b0f1a] text-white flex items-center justify-center min-h-screen p-6">
            <div class="max-w-md w-full">
                <div class="text-center mb-8">
                    <div class="inline-block p-4 rounded-full bg-[#FFAA00]/10 border-2 border-[#FFAA00] shadow-[0_0_20px_rgba(255,170,0,0.3)] mb-4 animate-pulse">
                        <img src="${client.user.displayAvatarURL()}" class="w-16 h-16 rounded-full">
                    </div>
                    <h1 class="text-4xl font-black tracking-tighter text-white uppercase">Impulse <span class="text-[#FFAA00]">OS</span></h1>
                    <p class="text-slate-500 text-[10px] mt-2 uppercase tracking-[0.2em]">Improving Quality of Life and More!</p>
                </div>
                
                <div class="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 md:p-8 shadow-2xl backdrop-blur-md relative overflow-hidden">
                    <div class="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-[#FFAA00] to-transparent opacity-20"></div>
                    
                    <div class="space-y-4 mb-8">
                        <div class="flex items-start gap-3">
                            <div class="mt-1 w-2 h-2 rounded-full bg-[#FFAA00] shrink-0"></div>
                            <p class="text-xs text-slate-400 font-mono"><span class="text-[#FFAA00]">STATUS:</span> System online. Monitoring 24/7 forum threads and community health.</p>
                        </div>
                        <div class="flex items-start gap-3">
                            <div class="mt-1 w-2 h-2 rounded-full bg-[#FFAA00] shrink-0"></div>
                            <p class="text-xs text-slate-400 font-mono"><span class="text-[#FFAA00]">SECURE:</span> OAuth2 Protocol active. Impulse Bot Dashboard requires Admin or Command Helper clearance.</p>
                        </div>
                    </div>

                    <div class="space-y-3">
                        <a href="/auth/discord" class="w-full text-center bg-[#FFAA00] hover:bg-[#ffbb33] text-black py-4 rounded-xl font-black text-xs uppercase tracking-widest transition-all shadow-[0_0_15px_rgba(255,170,0,0.2)] block">
                            Establish Connection
                        </a>
                        
                        <a href="/invite" class="w-full text-center bg-slate-800 hover:bg-slate-700 text-[#FFAA00] py-3 rounded-xl font-bold text-xs uppercase tracking-widest transition-all border-2 border-[#FFAA00]/30 hover:border-[#FFAA00] block flex items-center justify-center gap-2">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
                            </svg>
                            Add Bot to Server
                        </a>
                    </div>
                    
                    <p class="text-[9px] text-center text-slate-600 mt-6 uppercase tracking-widest italic font-bold">Authorized personnel only</p>
                </div>
            </div>
        </body></html>`);
  }

  const botAvatar = client.user.displayAvatarURL();
  const allSettings = db.prepare(`SELECT * FROM guild_settings`).all();
  const authorizedGuilds = [];

  for (const settings of allSettings) {
    const guild = client.guilds.cache.get(settings.guild_id);
    if (!guild) continue;
    try {
      const member = await guild.members.fetch(req.user.id);
      if (
        member.permissions.has(PermissionFlagsBits.Administrator) ||
        hasHelperRole(member, settings)
      ) {
        const timers = db
          .prepare(
            "SELECT thread_id, lock_at FROM pending_locks WHERE guild_id = ?"
          )
          .all(settings.guild_id);
        const snippetCount = db
          .prepare("SELECT COUNT(*) as count FROM snippets WHERE guild_id = ?")
          .get(settings.guild_id).count;
        authorizedGuilds.push({ ...settings, timers, snippetCount });
      }
    } catch (e) {}
  }

  const recentLogs = db
    .prepare(
      `
        SELECT audit_logs.*, guild_settings.guild_name 
        FROM audit_logs 
        LEFT JOIN guild_settings ON audit_logs.guild_id = guild_settings.guild_id 
        ORDER BY timestamp DESC LIMIT 5
    `
    )
    .all();

  const totalSnippets = db
    .prepare("SELECT COUNT(*) as count FROM snippets")
    .get().count;
  const totalLocks = db
    .prepare("SELECT COUNT(*) as count FROM pending_locks")
    .get().count;
  const totalLogs = db
    .prepare("SELECT COUNT(*) as count FROM audit_logs")
    .get().count;

  res.send(`
    <html>
    ${getHead("Impulse | Dashboard Overview")}
    <body class="bg-[#0b0f1a] text-slate-200 min-h-screen p-4 md:p-8">
        <div class="max-w-6xl mx-auto">
            ${getNav("overview", req.user)}

            <div class="mb-10">
                <h1 class="text-3xl md:text-4xl font-black text-white uppercase tracking-tighter mb-2">
                    System <span class="text-[#FFAA00]">Overview</span>
                </h1>
                <p class="text-xs text-slate-500 uppercase font-bold tracking-widest">Real-time monitoring & statistics</p>
            </div>

            <!-- Stats Grid -->
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
                <div class="bg-slate-900/40 backdrop-blur-md p-6 rounded-2xl border border-slate-800/50 hover:border-[#FFAA00]/30 transition">
                    <div class="flex items-center justify-between mb-4">
                        <h3 class="text-[10px] font-black text-slate-500 uppercase tracking-widest">Active Servers</h3>
                        <svg class="w-5 h-5 text-[#FFAA00]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"></path>
                        </svg>
                    </div>
                    <p class="text-4xl font-black text-white">${
                      authorizedGuilds.length
                    }</p>
                    <p class="text-[10px] text-slate-600 uppercase font-bold tracking-wider mt-1">Monitored guilds</p>
                </div>

                <div class="bg-slate-900/40 backdrop-blur-md p-6 rounded-2xl border border-slate-800/50 hover:border-emerald-500/30 transition">
                    <div class="flex items-center justify-between mb-4">
                        <h3 class="text-[10px] font-black text-slate-500 uppercase tracking-widest">Pending Locks</h3>
                        <svg class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path>
                        </svg>
                    </div>
                    <p class="text-4xl font-black text-white">${totalLocks}</p>
                    <p class="text-[10px] text-slate-600 uppercase font-bold tracking-wider mt-1">Active timers</p>
                </div>

                <div class="bg-slate-900/40 backdrop-blur-md p-6 rounded-2xl border border-slate-800/50 hover:border-blue-500/30 transition">
                    <div class="flex items-center justify-between mb-4">
                        <h3 class="text-[10px] font-black text-slate-500 uppercase tracking-widest">Total Snippets</h3>
                        <svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"></path>
                        </svg>
                    </div>
                    <p class="text-4xl font-black text-white">${totalSnippets}</p>
                    <p class="text-[10px] text-slate-600 uppercase font-bold tracking-wider mt-1">Saved templates</p>
                </div>
            </div>

            <!-- Server Cards -->
            <div class="mb-10">
                <div class="flex items-center justify-between mb-6">
                    <h2 class="text-xl font-black text-white uppercase tracking-tight">Managed Servers</h2>
                    <a href="/threads" class="text-[#FFAA00] text-[9px] font-black tracking-widest hover:underline uppercase">View All →</a>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    ${authorizedGuilds
                      .slice(0, 6)
                      .map(
                        (s) => `
                        <div class="bg-slate-900/40 backdrop-blur-md p-6 rounded-2xl border border-slate-800/50 hover:border-[#FFAA00]/30 transition shadow-lg">
                            <div class="flex items-center justify-between mb-4">
                                <h3 class="text-[#FFAA00] uppercase text-[10px] font-black tracking-widest opacity-80 truncate flex-1">${
                                  s.guild_name
                                }</h3>
                                <span class="text-[8px] bg-slate-800 px-2 py-1 rounded text-slate-500 font-bold">${
                                  s.snippetCount
                                } SNIPPETS</span>
                            </div>
                            <div class="space-y-2">
                                ${
                                  s.timers.length > 0
                                    ? s.timers
                                        .slice(0, 3)
                                        .map(
                                          (t) => `
                                    <div class="flex justify-between items-center bg-black/40 p-3 rounded-lg border border-slate-800/50">
                                        <span class="text-[10px] mono text-slate-500">ID:${t.thread_id.slice(
                                          -5
                                        )}</span>
                                        <span class="text-xs font-bold text-emerald-400 mono" data-expire="${
                                          t.lock_at
                                        }">--:--</span>
                                    </div>
                                `
                                        )
                                        .join("")
                                    : '<div class="text-slate-600 text-xs py-2 italic text-center">No active timers</div>'
                                }
                            </div>
                        </div>`
                      )
                      .join("")}
                </div>
            </div>

            <!-- Recent Activity -->
            <div class="bg-slate-900/40 rounded-2xl border border-slate-800 overflow-hidden shadow-2xl">
                <div class="p-6 border-b border-slate-800 flex justify-between items-center bg-slate-900/20">
                    <h2 class="text-md md:text-lg font-bold text-white flex items-center gap-2 uppercase tracking-tight">
                        <span class="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
                        Recent Activity
                    </h2>
                    <a href="/logs" class="text-[#FFAA00] text-[9px] font-black tracking-widest hover:bg-[#FFAA00] hover:text-black transition px-4 py-2 rounded-lg border border-[#FFAA00]/20 uppercase">Full Logs</a>
                </div>
                <div class="divide-y divide-slate-800/40">
                    ${recentLogs
                      .map((l) => {
                        return `
                        <div class="p-4 hover:bg-[#FFAA00]/5 transition flex items-center gap-4">
                            <div class="hidden md:block text-[10px] mono text-slate-600 w-20 text-right shrink-0" data-timestamp="${
                              l.timestamp
                            }">
                                --:--:--
                            </div>
                            <div class="w-20 flex items-center justify-center shrink-0">
                                <span class="px-2 py-0.5 rounded text-[8px] font-black mono ${getActionColor(
                                  l.action
                                )} inline-block text-center min-w-[70px]">
                                    ${l.action}
                                </span>
                            </div>
                            <div class="flex-1 min-w-0">
                                <p class="text-xs text-slate-300 truncate font-medium">${
                                  l.details
                                }</p>
                            </div>
                            <div class="text-[9px] font-black text-slate-600 uppercase tracking-widest shrink-0 w-24 text-right">
                                ${l.guild_name || "System"}
                            </div>
                        </div>
                    `;
                      })
                      .join("")}
                </div>
                <div class="p-4 bg-slate-900/20 text-center">
                    <p class="text-[10px] text-slate-600 font-mono">Total Events: ${totalLogs.toLocaleString()}</p>
                </div>
            </div>

            <!-- INFO FOOTER -->
            <footer class="mt-12 pt-8 border-t border-slate-800/50">
                <div class="max-w-5xl mx-auto space-y-6">

                    <!-- Bot Status Bar -->
                    <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <div class="bg-slate-900/40 border border-slate-800 rounded-xl p-4 flex items-center gap-3">
                            <div class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse shrink-0"></div>
                            <div>
                                <p class="text-[9px] font-black text-slate-500 uppercase tracking-widest">Bot Status</p>
                                <p class="text-xs font-bold text-emerald-400">Online</p>
                            </div>
                        </div>
                        <div class="bg-slate-900/40 border border-slate-800 rounded-xl p-4">
                            <p class="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Uptime</p>
                            <p class="text-xs font-bold text-white mono" id="uptimeDisplay">calculating...</p>
                        </div>
                        <div class="bg-slate-900/40 border border-slate-800 rounded-xl p-4">
                            <p class="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Dashboard</p>
                            <div class="flex items-center gap-2">
                                <div class="w-2 h-2 rounded-full bg-emerald-500"></div>
                                <p class="text-xs font-bold text-emerald-400">Operational</p>
                            </div>
                        </div>
                        <div class="bg-slate-900/40 border border-slate-800 rounded-xl p-4">
                            <p class="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Version</p>
                            <p class="text-xs font-bold text-[#FFAA00]">2.5.0 • Stable</p>
                        </div>
                    </div>

                    <!-- Bot Specs -->
                    <div class="bg-slate-900/40 border border-slate-800 rounded-xl p-5">
                        <p class="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-4">System Specs</p>
                        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                            <div>
                                <p class="text-lg font-black text-white">${client.guilds.cache.size}</p>
                                <p class="text-[9px] text-slate-600 uppercase font-bold tracking-wider">Servers</p>
                            </div>
                            <div>
                                <p class="text-lg font-black text-white">${client.users.cache.size}</p>
                                <p class="text-[9px] text-slate-600 uppercase font-bold tracking-wider">Cached Users</p>
                            </div>
                            <div>
                                <p class="text-lg font-black text-white">${db.prepare("SELECT COUNT(*) as c FROM blocked_users").get().c}</p>
                                <p class="text-[9px] text-slate-600 uppercase font-bold tracking-wider">Blocked Users</p>
                            </div>
                            <div>
                                <p class="text-lg font-black text-white">${db.prepare("SELECT COUNT(*) as c FROM banned_users").get().c}</p>
                                <p class="text-[9px] text-slate-600 uppercase font-bold tracking-wider">Banned Users</p>
                            </div>
                        </div>
                    </div>

                    <!-- Privacy + Report Bug -->
                    <div class="bg-slate-900/40 border border-slate-800 rounded-xl p-6">
                        <p class="text-xs text-slate-400 leading-relaxed mb-3">
                            <span class="text-[#FFAA00] font-bold">Privacy Notice:</span> This dashboard does not store, collect, or use any personal user data. 
                            It only accesses Discord OAuth2 to verify your server membership and display relevant information from servers where the bot is installed.
                        </p>
                        <p class="text-[10px] text-slate-500 italic">All data is pulled in real-time and nothing is cached or saved beyond your active session.</p>
                    </div>

                    <!-- Footer Links -->
                    <div class="flex flex-col md:flex-row items-center justify-between gap-4 pb-4">
                        <div class="flex items-center gap-3">
                            <img src="${botAvatar}" class="w-7 h-7 rounded-full border border-[#FFAA00]/30">
                            <div>
                                <p class="text-[10px] font-black text-[#FFAA00] uppercase tracking-widest">Impulse Dashboard</p>
                                <p class="text-[9px] text-slate-600">Built for Gups Command Central • Powered by Discord.js</p>
                            </div>
                        </div>
                        <a href="https://discord.com/users/809204882997248091" 
                          target="_blank"
                          class="flex items-center gap-2 bg-rose-900/30 hover:bg-rose-900/50 border border-rose-800/50 text-rose-300 px-5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                            </svg>
                            Report a Bug
                        </a>
                    </div>
                </div>
            </footer>
            <script>
                const botStartTime = ${Date.now() - process.uptime() * 1000};
                function updateUptime() {
                    const diff = Date.now() - botStartTime;
                    const d = Math.floor(diff / 86400000);
                    const h = Math.floor((diff % 86400000) / 3600000);
                    const m = Math.floor((diff % 3600000) / 60000);
                    const s = Math.floor((diff % 60000) / 1000);
                    document.getElementById('uptimeDisplay').innerText = 
                        (d > 0 ? d + 'd ' : '') + (h > 0 ? h + 'h ' : '') + m + 'm ' + s + 's';
                }
                setInterval(updateUptime, 1000);
                updateUptime();
            </script>
        </div>
        <script>
            function updateTimers() {
                document.querySelectorAll('[data-expire]').forEach(el => {
                    const diff = parseInt(el.getAttribute('data-expire')) - Date.now();
                    if (diff <= 0) {
                        el.innerText = "LOCKED";
                        el.className = "text-xs font-bold text-rose-500 mono uppercase";
                    } else {
                        const m = Math.floor(diff / 60000);
                        const s = Math.floor((diff % 60000) / 1000);
                        el.innerText = m + "m " + s + "s";
                    }
                });
            }
            
            function updateTimestamps() {
                document.querySelectorAll('[data-timestamp]').forEach(el => {
                    const timestamp = el.getAttribute('data-timestamp');
                    // If the DB date doesn't have a 'Z', browser might think it's local. 
                    // We force it to UTC by adding 'Z' if it's missing, then the browser converts to local.
                    const date = new Date(timestamp.includes(' ') ? timestamp.replace(' ', 'T') + 'Z' : timestamp);
                    
                    const timeStr = date.toLocaleString(undefined, {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: true
                    });
                    el.innerText = timeStr;
                });
            }
            
            setInterval(updateTimers, 1000); 
            updateTimers();
            updateTimestamps();
        </script>
    </body></html>`);
});

app.get("/logs", async (req, res) => {
  if (!req.isAuthenticated()) return res.redirect("/auth/discord");

  const filterActions = [].concat(req.query.action || []);
  const filterGuilds = [].concat(req.query.guild || []);
  const filterUsers = [].concat(req.query.user || []);

  const managedGuildIds = getManagedGuilds(req.user.id);

  if (managedGuildIds.length === 0) {
    return res.send(
      getErrorPage(
        "No Access",
        "You don't have permission to view logs from any servers."
      )
    );
  }

  let query = `SELECT * FROM audit_logs WHERE guild_id IN (${managedGuildIds
    .map(() => "?")
    .join(",")})`;
  let params = [...managedGuildIds];

  if (filterActions.length > 0) {
    query += ` AND action IN (${filterActions.map(() => "?").join(",")})`;
    params.push(...filterActions);
  }

  if (filterGuilds.length > 0) {
    query += ` AND guild_id IN (${filterGuilds.map(() => "?").join(",")})`;
    params.push(...filterGuilds);
  }

  if (filterUsers.length > 0) {
    query += ` AND user_id IN (${filterUsers.map(() => "?").join(",")})`;
    params.push(...filterUsers);
  }

  query += " ORDER BY timestamp DESC LIMIT 100";

  const rawLogs = db.prepare(query).all(...params);

  const logs = rawLogs.map((log) => {
    const guild = client.guilds.cache.get(log.guild_id);
    let contextLink = null;
    let readableContext = null;

    if (log.thread_id && log.message_id) {
      contextLink = getDiscordLink(log.guild_id, log.thread_id, log.message_id);
      readableContext = getReadableName(log.thread_id, log.guild_id);
    } else if (log.thread_id) {
      contextLink = getDiscordLink(log.guild_id, log.thread_id);
      readableContext = getReadableName(log.thread_id, log.guild_id);
    }

    return {
      ...log,
      displayName: guild ? guild.name : `Server ${log.guild_id.slice(-4)}`,
      contextLink,
      readableContext,
      actionStyle: getActionColor(log.action),
    };
  });

  const allActions = [
    "SNIPPET_CREATE",
    "SNIPPET_UPDATE",
    "SNIPPET_DELETE",
    "SNIPPET",
    "LOCK",
    "CANCEL",
    "GREET",
    "DUPLICATE",
    "SETUP",
    "RESOLVED",
    "ANSWERED",
    "AUTO_CLOSE",
    "STALE_WARNING",
    "THREAD_RENEWED",
    "LINK_ADDED",
    "LINK_ACCESSED",
    "LINK_REMOVED",
    "TRIGGER_CREATE",
    "USER_BLOCKED",
    "USER_UNBLOCKED",
    "USER_BANNED",
    "USER_UNBANNED",
    "AUTO_SUSPEND",
    "BULK_CLOSE",
  ];

  const managedGuilds = managedGuildIds.map((id) => {
    const guild = client.guilds.cache.get(id);
    return { id, name: guild ? guild.name : `Server ${id.slice(-4)}` };
  });

  const userList = db
    .prepare(
      `
    SELECT DISTINCT user_id, user_name 
    FROM audit_logs 
    WHERE guild_id IN (${managedGuildIds.map(() => "?").join(",")}) 
    AND user_id IS NOT NULL
    ORDER BY user_name ASC
`
    )
    .all(...managedGuildIds);

  res.send(`
    <html>
    ${getHead("Impulse | Audit Logs")}
    <body class="bg-[#0b0f1a] text-slate-200 min-h-screen p-6 md:p-8">
        <div class="max-w-7xl mx-auto">
            ${getNav("logs", req.user)}

            <div class="mb-8">
                <h1 class="text-3xl md:text-4xl font-black text-white uppercase tracking-tighter mb-2">
                    Audit <span class="text-[#FFAA00]">Logs</span>
                </h1>
                <p class="text-xs text-slate-500 uppercase font-bold tracking-widest">System • Security • Activity</p>
            </div>

            <!-- FILTERS - Horizontal layout -->
<div class="mb-10 space-y-6">
    <!-- Action Type Row -->
    <div>
        <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Action Type</p>
        <div class="flex flex-wrap gap-2">
            <a href="/logs?${new URLSearchParams({
              guild: filterGuilds,
              user: filterUsers,
            }).toString()}"
               class="px-3 py-1.5 rounded-lg text-[10px] font-black uppercase transition-all ${
                 filterActions.length === 0
                   ? "bg-[#FFAA00] text-black shadow-lg shadow-amber-500/30"
                   : "bg-slate-800/70 text-slate-400 hover:bg-slate-700"
               } border border-slate-700">
                All Actions
            </a>
            ${allActions
              .map((act) => {
                const active = filterActions.includes(act);
                const params = new URLSearchParams();
                const currentActions = active
                  ? filterActions.filter((a) => a !== act)
                  : [...filterActions, act];
                currentActions.forEach((a) => params.append("action", a));
                filterGuilds.forEach((g) => params.append("guild", g));
                filterUsers.forEach((u) => params.append("user", u));

                return `
                <a href="/logs?${params.toString()}"
                   class="px-3 py-1.5 rounded-lg text-[10px] font-black uppercase transition-all ${
                     active
                       ? "bg-[#FFAA00] text-black shadow-md shadow-amber-500/30"
                       : "bg-slate-800/70 text-slate-400 hover:bg-slate-700"
                   } border border-slate-700">
                    ${act.replace(/_/g, " ")}
                </a>`;
              })
              .join("")}
        </div>
    </div>

    <!-- Server Row -->
    <div>
        <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Server</p>
        <div class="flex flex-wrap gap-2">
            <a href="/logs?${new URLSearchParams({
              action: filterActions,
              user: filterUsers,
            }).toString()}"
               class="px-3 py-1.5 rounded-lg text-[10px] font-black uppercase transition-all ${
                 filterGuilds.length === 0
                   ? "bg-[#FFAA00] text-black shadow-lg shadow-amber-500/30"
                   : "bg-slate-800/70 text-slate-400 hover:bg-slate-700"
               } border border-slate-700">
                All Servers
            </a>
            ${managedGuilds
              .map((g) => {
                const active = filterGuilds.includes(g.id);
                const params = new URLSearchParams();
                const currentGuilds = active
                  ? filterGuilds.filter((id) => id !== g.id)
                  : [...filterGuilds, g.id];
                currentGuilds.forEach((id) => params.append("guild", id));
                filterActions.forEach((a) => params.append("action", a));
                filterUsers.forEach((u) => params.append("user", u));

                return `
                <a href="/logs?${params.toString()}"
                   class="px-3 py-1.5 rounded-lg text-[10px] font-black uppercase transition-all ${
                     active
                       ? "bg-[#FFAA00] text-black shadow-md shadow-amber-500/30"
                       : "bg-slate-800/70 text-slate-400 hover:bg-slate-700"
                   } border border-slate-700">
                    ${g.name}
                </a>`;
              })
              .join("")}
        </div>
    </div>

    <!-- User Row -->
    <div>
        <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">User</p>
        <div class="flex flex-wrap gap-2">
            <a href="/logs?${new URLSearchParams({
              action: filterActions,
              guild: filterGuilds,
            }).toString()}"
               class="px-3 py-1.5 rounded-lg text-[10px] font-black uppercase transition-all ${
                 filterUsers.length === 0
                   ? "bg-[#FFAA00] text-black shadow-lg shadow-amber-500/30"
                   : "bg-slate-800/70 text-slate-400 hover:bg-slate-700"
               } border border-slate-700">
                All Users
            </a>
            ${
              userList.length > 0
                ? userList
                    .map((u) => {
                      const active = filterUsers.includes(u.user_id);
                      const params = new URLSearchParams();
                      const currentUsers = active
                        ? filterUsers.filter((id) => id !== u.user_id)
                        : [...filterUsers, u.user_id];
                      currentUsers.forEach((id) => params.append("user", id));
                      filterActions.forEach((a) => params.append("action", a));
                      filterGuilds.forEach((g) => params.append("guild", g));

                      return `
                <a href="/logs?${params.toString()}"
                   class="px-3 py-1.5 rounded-lg text-[10px] font-black uppercase transition-all ${
                     active
                       ? "bg-purple-600/80 text-white shadow-md shadow-purple-500/30"
                       : "bg-slate-800/70 text-slate-400 hover:bg-slate-700"
                   } border border-slate-700">
                    @${u.user_name || "Unknown"}
                </a>`;
                    })
                    .join("")
                : `
                <span class="px-3 py-1.5 text-[10px] text-slate-600 italic">No users found in logs yet</span>
            `
            }
        </div>
    </div>

    <!-- Clear Filters + Active Filters Summary -->
    <div class="flex flex-wrap items-center gap-4 pt-4 border-t border-slate-800/70">
        <a href="/logs"
           class="px-5 py-2 bg-rose-900/60 hover:bg-rose-800/80 text-rose-300 text-[11px] font-black uppercase rounded-lg border border-rose-800/50 transition-all shadow-sm">
            Clear All Filters
        </a>

        ${
          filterActions.length + filterGuilds.length + filterUsers.length > 0
            ? `
        <div class="flex items-center gap-3">
            <span class="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Active:</span>
            <div class="flex flex-wrap gap-2">
                ${filterActions
                  .map(
                    (a) =>
                      `<span class="px-2.5 py-1 bg-blue-950/70 text-blue-300 text-[10px] rounded border border-blue-900/40">${a.replace(
                        /_/g,
                        " "
                      )}</span>`
                  )
                  .join("")}
                ${filterGuilds
                  .map((id) => {
                    const g = managedGuilds.find((g) => g.id === id);
                    return g
                      ? `<span class="px-2.5 py-1 bg-amber-950/70 text-amber-300 text-[10px] rounded border border-amber-900/40">${g.name}</span>`
                      : "";
                  })
                  .join("")}
                ${filterUsers
                  .map((id) => {
                    const u = userList.find((u) => u.user_id === id);
                    return u
                      ? `<span class="px-2.5 py-1 bg-purple-950/70 text-purple-300 text-[10px] rounded border border-purple-900/40">@${
                          u.user_name || "unknown"
                        }</span>`
                      : "";
                  })
                  .join("")}
            </div>
        </div>`
            : ""
        }
    </div>
</div>

            <div class="bg-slate-900/40 rounded-2xl border border-slate-800 overflow-hidden shadow-2xl">
                <div class="overflow-x-auto">
                    <table class="w-full text-left border-collapse min-w-[800px]">
                        <thead class="bg-slate-900/60 border-b border-slate-800">
                            <tr>
                                <th class="p-4 text-[10px] font-black uppercase text-slate-500 tracking-widest">Timestamp</th>
                                <th class="p-4 text-[10px] font-black uppercase text-slate-500 tracking-widest">Source</th>
                                <th class="p-4 text-[10px] font-black uppercase text-slate-500 tracking-widest">Action</th>
                                <th class="p-4 text-[10px] font-black uppercase text-slate-500 tracking-widest">Context</th>
                                <th class="p-4 text-[10px] font-black uppercase text-slate-500 tracking-widest">User</th>
                                <th class="p-4 text-[10px] font-black uppercase text-slate-500 tracking-widest">Details</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-slate-800/40">
                            ${
                              logs.length > 0
                                ? logs
                                    .map((l) => {
                                      // Force SQLite UTC → browser local time
                                      const iso = l.timestamp.includes(" ")
                                        ? l.timestamp.replace(" ", "T") + "Z"
                                        : l.timestamp;

                                      const date = new Date(iso);

                                      const formattedDate =
                                        date.toLocaleDateString("en-US", {
                                          month: "short",
                                          day: "numeric",
                                          year: "numeric",
                                        });
                                      const formattedTime =
                                        date.toLocaleTimeString("en-US", {
                                          hour: "2-digit",
                                          minute: "2-digit",
                                          second: "2-digit",
                                          hour12: false,
                                        });

                                      return `
                                <tr class="hover:bg-white/5 transition-colors">
                                    <td class="p-4 text-[10px] text-slate-500 whitespace-nowrap font-mono">
                                        <div class="font-bold">${formattedDate}</div>
                                        <div class="text-slate-600">${formattedTime}</div>
                                    </td>
                                    <td class="p-4">
                                        <span class="text-[10px] font-black text-[#FFAA00] uppercase bg-[#FFAA00]/5 px-2 py-1 rounded border border-[#FFAA00]/10">
                                            ${l.displayName}
                                        </span>
                                    </td>
                                    <td class="p-4">
                                        <span class="px-2 py-1 rounded border text-[9px] font-bold uppercase ${
                                          l.actionStyle
                                        }">
                                            ${l.action}
                                        </span>
                                    </td>
                                    <td class="p-4">
                                        ${
                                          l.contextLink
                                            ? `
                                            <a href="${l.contextLink}" target="_blank" class="flex items-center gap-2 text-xs text-blue-400 hover:text-blue-300 transition group">
                                                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"></path>
                                                </svg>
                                                <span class="truncate max-w-[120px]" title="${l.readableContext}">${l.readableContext}</span>
                                            </a>
                                        `
                                            : '<span class="text-xs text-slate-600">—</span>'
                                        }
                                    </td>
                                    <td class="p-4">
                                        <div class="flex items-center gap-2">
                                            <img src="${
                                              l.user_avatar ||
                                              "https://cdn.discordapp.com/embed/avatars/0.png"
                                            }" 
                                                 class="w-6 h-6 rounded-full border border-slate-700">
                                            <span class="text-xs font-bold text-slate-300">${
                                              l.user_name || "SYSTEM"
                                            }</span>
                                        </div>
                                    </td>
                                    <td class="p-4">
                                        <details class="group">
                                            <summary class="list-none flex items-center justify-between hover:text-white transition-all cursor-pointer text-xs text-slate-400">
                                                <span class="truncate max-w-md">${
                                                  l.details
                                                }</span>
                                                <svg class="w-3 h-3 text-slate-600 group-open:rotate-180 transition-transform shrink-0 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                                                </svg>
                                            </summary>
                                            <div class="mt-3 p-3 bg-black/40 rounded-lg border border-slate-800 font-mono text-[10px] text-blue-400">
                                                <span class="text-slate-600 mr-2">>_</span>${
                                                  l.command_used ||
                                                  "N/A (Automated Event)"
                                                }
                                            </div>
                                        </details>
                                    </td>
                                </tr>
                            `;
                                    })
                                    .join("")
                                : `
                                <tr>
                                    <td colspan="6" class="p-8 text-center text-slate-500">
                                        <div class="flex flex-col items-center gap-3">
                                            <svg class="w-12 h-12 text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
                                            </svg>
                                            <p class="text-sm font-bold uppercase tracking-widest">No logs found</p>
                                            <p class="text-xs">Try adjusting your filters</p>
                                        </div>
                                    </td>
                                </tr>
                            `
                            }
                        </tbody>
                    </table>
                </div>
            </div>

            <div class="mt-6 text-center text-xs text-slate-600 font-mono">
                Showing ${logs.length} ${
    logs.length === 1 ? "entry" : "entries"
  } • Last updated: ${new Date().toLocaleTimeString()}
            </div>
        </div>
    </body>
    </html>
    `);
});

app.get("/threads", async (req, res) => {
  if (!req.isAuthenticated()) return res.redirect("/auth/discord");

  const allSettings = db.prepare(`SELECT * FROM guild_settings`).all();
  const authorizedGuilds = [];

  for (const settings of allSettings) {
    const guild = client.guilds.cache.get(settings.guild_id);
    if (!guild) continue;
    try {
      const member = await guild.members.fetch(req.user.id);
      if (
        member.permissions.has(PermissionFlagsBits.Administrator) ||
        hasHelperRole(member, settings)
      ) {
        const timers = db
          .prepare(
            "SELECT thread_id, lock_at FROM pending_locks WHERE guild_id = ?"
          )
          .all(settings.guild_id);
        const threadTracking = db
          .prepare(
            "SELECT COUNT(*) as count FROM thread_tracking WHERE guild_id = ?"
          )
          .get(settings.guild_id).count;
        authorizedGuilds.push({ ...settings, timers, threadTracking });
      }
    } catch (e) {}
  }

  res.send(`
    <html>
    ${getHead("Impulse | Thread Management")}
    <body class="bg-[#0b0f1a] text-slate-200 min-h-screen p-6 md:p-8">
        <div class="max-w-6xl mx-auto">
            ${getNav("threads", req.user)}

            <div class="mb-10">
                <h1 class="text-3xl md:text-4xl font-black text-white uppercase tracking-tighter mb-2">
                    Thread <span class="text-[#FFAA00]">Management</span>
                </h1>
                <p class="text-xs text-slate-500 uppercase font-bold tracking-widest">Monitor active timers & thread automation</p>
            </div>

            <!-- Summary Cards -->
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
                <div class="bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 backdrop-blur-md p-6 rounded-2xl border border-emerald-500/20 shadow-lg">
                    <div class="flex items-center justify-between mb-4">
                        <h3 class="text-[10px] font-black text-emerald-400 uppercase tracking-widest">Active Timers</h3>
                        <svg class="w-6 h-6 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                        </svg>
                    </div>
                    <p class="text-4xl font-black text-white mb-1">${authorizedGuilds.reduce(
                      (acc, g) => acc + g.timers.length,
                      0
                    )}</p>
                    <p class="text-[10px] text-slate-500 uppercase font-bold tracking-wider">Pending locks across all servers</p>
                </div>

                <div class="bg-gradient-to-br from-blue-500/10 to-blue-500/5 backdrop-blur-md p-6 rounded-2xl border border-blue-500/20 shadow-lg">
                    <div class="flex items-center justify-between mb-4">
                        <h3 class="text-[10px] font-black text-blue-400 uppercase tracking-widest">Tracked Threads</h3>
                        <svg class="w-6 h-6 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"></path>
                        </svg>
                    </div>
                    <p class="text-4xl font-black text-white mb-1">${authorizedGuilds.reduce(
                      (acc, g) => acc + g.threadTracking,
                      0
                    )}</p>
                    <p class="text-[10px] text-slate-500 uppercase font-bold tracking-wider">Threads monitored for auto-close</p>
                </div>

                <div class="bg-gradient-to-br from-amber-500/10 to-amber-500/5 backdrop-blur-md p-6 rounded-2xl border border-amber-500/20 shadow-lg">
                    <div class="flex items-center justify-between mb-4">
                        <h3 class="text-[10px] font-black text-amber-400 uppercase tracking-widest">Configured Servers</h3>
                        <svg class="w-6 h-6 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path>
                        </svg>
                    </div>
                    <p class="text-4xl font-black text-white mb-1">${
                      authorizedGuilds.length
                    }</p>
                    <p class="text-[10px] text-slate-500 uppercase font-bold tracking-wider">With active thread automation</p>
                </div>
            </div>

            <!-- Server Thread Details -->
            <div class="space-y-6">
                ${authorizedGuilds
                  .map(
                    (s) => `
                    <div class="bg-slate-900/40 backdrop-blur-md rounded-2xl border border-slate-800/50 overflow-hidden shadow-xl">
                        <div class="p-6 border-b border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-900/20">
                            <div>
                                <h3 class="text-xl font-black text-white uppercase tracking-tight mb-1">${
                                  s.guild_name
                                }</h3>
                                <div class="flex items-center gap-4 text-[10px] text-slate-500 uppercase font-bold tracking-wider">
                                    <span>Forum: <span class="text-[#FFAA00]">#${s.forum_id.slice(
                                      -4
                                    )}</span></span>
                                    <span>•</span>
                                    <span>${
                                      s.timers.length
                                    } Active Timers</span>
                                    <span>•</span>
                                    <span>${s.threadTracking} Tracked</span>
                                </div>
                            </div>
                            <div class="flex items-center gap-2">
                                <span class="text-[9px] px-3 py-1.5 rounded-lg ${
                                  s.timers.length > 0
                                    ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                                    : "bg-slate-800 text-slate-500 border border-slate-700"
                                } font-black uppercase">
                                    ${s.timers.length > 0 ? "Active" : "Idle"}
                                </span>
                            </div>
                        </div>

                        ${
                          s.timers.length > 0
                            ? `
                            <div class="p-6">
                                <p class="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-4">Pending Lock Queue</p>
                                <div class="space-y-3">
                                    ${s.timers
                                      .map(
                                        (t) => `
                                        <div class="flex items-center justify-between bg-black/40 p-4 rounded-xl border border-slate-800/50 hover:border-[#FFAA00]/30 transition">
                                            <div class="flex items-center gap-4">
                                                <div class="bg-slate-800 px-3 py-2 rounded-lg">
                                                    <p class="text-[10px] mono text-slate-500 font-bold">ID: ${t.thread_id.slice(
                                                      -8
                                                    )}</p>
                                                </div>
                                                <div>
                                                    <p class="text-xs font-bold text-white">Thread Lock Scheduled</p>
                                                    <p class="text-[10px] text-slate-600 uppercase tracking-wider font-bold mt-0.5">Auto-lock timer running</p>
                                                </div>
                                            </div>
                                            <div class="flex items-center gap-4">
                                                <div class="text-right">
                                                    <p class="text-[9px] text-slate-600 uppercase font-bold tracking-wider">Time Remaining</p>
                                                    <p class="text-lg font-black text-emerald-400 mono" data-expire="${
                                                      t.lock_at
                                                    }">--:--</p>
                                                </div>
                                                <svg class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                                                </svg>
                                            </div>
                                        </div>
                                    `
                                      )
                                      .join("")}
                                </div>
                            </div>
                        `
                            : `
                            <div class="p-12 text-center">
                                <svg class="w-12 h-12 text-slate-700 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                                </svg>
                                <p class="text-sm font-bold text-slate-600 uppercase tracking-widest">All Clear</p>
                                <p class="text-xs text-slate-700 mt-1">No pending thread locks</p>
                            </div>
                        `
                        }

                        <div class="p-4 bg-slate-900/20 border-t border-slate-800">
                            <div class="flex items-center justify-between text-[10px]">
                                <div class="flex items-center gap-6">
                                    <span class="text-slate-600 uppercase font-bold tracking-wider">Configuration</span>
                                    <span class="text-slate-500">Resolved Tag: <code class="text-[#FFAA00] bg-[#FFAA00]/10 px-2 py-0.5 rounded">${
                                      s.resolved_tag
                                    }</code></span>
                                    <span class="text-slate-500">Duplicate Tag: <code class="text-sky-400 bg-sky-400/10 px-2 py-0.5 rounded">${
                                      s.duplicate_tag
                                    }</code></span>
                                    ${
                                      s.unanswered_tag
                                        ? `<span class="text-slate-500">Unanswered Tag: <code class="text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded">${s.unanswered_tag}</code></span>`
                                        : ""
                                    }
                                </div>
                            </div>
                        </div>
                    </div>
                `
                  )
                  .join("")}
            </div>

            ${
              authorizedGuilds.length === 0
                ? `
                <div class="text-center py-20">
                    <svg class="w-16 h-16 text-slate-700 mx-auto mb-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"></path>
                    </svg>
                    <h3 class="text-xl font-black text-white uppercase tracking-tight mb-2">No Servers Configured</h3>
                    <p class="text-sm text-slate-500 mb-6">Add the bot to a server and run <code class="bg-slate-800 px-2 py-1 rounded text-[#FFAA00]">/setup</code> to get started</p>
                    <a href="/invite" class="inline-block bg-[#FFAA00] text-black px-6 py-3 rounded-xl font-black text-xs uppercase tracking-widest hover:bg-[#ffbb33] transition">
                        Add Bot to Server
                    </a>
                </div>
            `
                : ""
            }
        </div>

        <script>
            function updateTimers() {
                document.querySelectorAll('[data-expire]').forEach(el => {
                    const diff = parseInt(el.getAttribute('data-expire')) - Date.now();
                    if (diff <= 0) {
                        el.innerText = "LOCKED";
                        el.className = "text-lg font-black text-rose-500 mono uppercase";
                    } else {
                        const m = Math.floor(diff / 60000);
                        const s = Math.floor((diff % 60000) / 1000);
                        el.innerText = m + "m " + s + "s";
                    }
                });
            }
            setInterval(updateTimers, 1000); 
            updateTimers();
        </script>
    </body>
    </html>
    `);
});

app.get("/invite", (req, res) => {
  const permissions = "292057869376";
  const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${process.env.CLIENT_ID}&permissions=${permissions}&scope=bot%20applications.commands`;

  const botAvatar = client.user?.displayAvatarURL() || '';

  res.send(`
    <html>
    ${getHead("Impulse OS | Authorization Protocol")}
    <body class="bg-[#0b0f1a] text-slate-200 min-h-screen py-12 px-6 overflow-x-hidden relative">
        <!-- Background Glow -->
        <div class="absolute inset-0 opacity-30 pointer-events-none">
            <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-[#FFAA00] rounded-full blur-[120px] animate-pulse"></div>
        </div>

        <div class="max-w-5xl mx-auto w-full relative z-10">
            <!-- Hero Header -->
            <div class="text-center mb-16">
                <div class="inline-block relative mb-8">
                    <div class="absolute inset-0 bg-[#FFAA00] blur-xl opacity-40 rounded-full animate-pulse"></div>
                    <img src="${botAvatar}" class="w-32 h-32 rounded-full border-4 border-[#FFAA00] shadow-2xl relative z-10">
                </div>
                <h1 class="text-5xl md:text-7xl font-black tracking-tighter uppercase bg-gradient-to-r from-white to-[#FFAA00] bg-clip-text text-transparent">
                    Impulse<span class="text-[#FFAA00]">OS</span>
                </h1>
                <p class="text-base md:text-lg font-bold text-[#FFAA00] uppercase tracking-[0.4em] mt-4">Built for Gup's Command Central</p>
                <p class="text-slate-400 max-w-2xl mx-auto mt-6 leading-relaxed text-sm md:text-base">Precision thread management • Reusable resource snippets • Secure link delivery • Full audit dashboard</p>
            </div>

            <!-- Features Grid -->
            <div class="grid grid-cols-1 md:grid-cols-3 gap-8 mb-16">
                <div class="bg-slate-900/60 backdrop-blur-md border border-slate-800 rounded-2xl p-8 hover:border-[#FFAA00]/50 transition-all group">
                    <div class="w-12 h-12 bg-emerald-500/20 rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                        <svg class="w-7 h-7 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
                    </div>
                    <h3 class="text-lg font-black uppercase text-white mb-3">Smart Automation</h3>
                    <ul class="space-y-3 text-sm text-slate-400">
                        <li>• Instant greeting embeds on thread creation</li>
                        <li>• Auto "unanswered" tagging</li>
                        <li>• 24-day stale warnings → 30-day auto-lock</li>
                        <li>• /resolved → tag + 30min timed lock</li>
                        <li>• /cancel to undo or renew</li>
                    </ul>
                </div>

                <div class="bg-slate-900/60 backdrop-blur-md border border-slate-800 rounded-2xl p-8 hover:border-[#FFAA00]/50 transition-all group">
                    <div class="w-12 h-12 bg-blue-500/20 rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                        <svg class="w-7 h-7 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                    </div>
                    <h3 class="text-lg font-black uppercase text-white mb-3">Resource Snippets</h3>
                    <ul class="space-y-3 text-sm text-slate-400">
                        <li>• Create rich reusable embeds via dashboard</li>
                        <li>• Supports variables {user}, {server}, images, thumbnails</li>
                        <li>• Instant access with /snippet &lt;name&gt;</li>
                        <li>• Perfect for FAQs, guides, common fixes</li>
                    </ul>
                </div>

                <div class="bg-slate-900/60 backdrop-blur-md border border-slate-800 rounded-2xl p-8 hover:border-[#FFAA00]/50 transition-all group">
                    <div class="w-12 h-12 bg-purple-500/20 rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                        <svg class="w-7 h-7 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
                    </div>
                    <h3 class="text-lg font-black uppercase text-white mb-3">Secure Link System</h3>
                    <ul class="space-y-3 text-sm text-slate-400">
                        <li>• Thread owners attach private links (/link)</li>
                        <li>• Users react 🔗 on starter message → get DM</li>
                        <li>• Bot auto-removes reaction for clean UI</li>
                        <li>• Staff can remove with /removelink</li>
                    </ul>
                </div>
            </div>

            <!-- Permissions & Privacy -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-8 mb-16">
                <div class="bg-slate-900/60 backdrop-blur-md border border-slate-800 rounded-2xl p-8">
                    <h3 class="text-[#FFAA00] font-black uppercase tracking-widest mb-6">Required Permissions</h3>
                    <p class="text-sm text-slate-400 mb-6">Minimal & transparent — no Administrator access needed.</p>
                    <ul class="space-y-4 text-sm">
                        <li class="flex justify-between"><span class="text-slate-400">Manage Threads</span><span class="text-emerald-400 font-bold">Essential</span></li>
                        <li class="flex justify-between"><span class="text-slate-400">Manage Messages</span><span class="text-emerald-400 font-bold">Essential</span></li>
                        <li class="flex justify-between"><span class="text-slate-400">Embed Links & Send in Threads</span><span class="text-emerald-400 font-bold">Essential</span></li>
                        <li class="flex justify-between"><span class="text-slate-400">Add Reactions</span><span class="text-emerald-400 font-bold">Essential</span></li>
                    </ul>
                    <p class="text-[10px] text-slate-500 mt-6 italic">Manage Messages is used only to cleanly remove 🔗 reactions after DM delivery.</p>
                </div>

                <div class="bg-slate-900/60 backdrop-blur-md border border-slate-800 rounded-2xl p-8">
                    <h3 class="text-cyan-400 font-black uppercase tracking-widest mb-6">Privacy & Security</h3>
                    <ul class="space-y-4 text-sm text-slate-400">
                        <li>• No personal data stored — OAuth only verifies role access</li>
                        <li>• Dashboard data loaded real-time, nothing cached</li>
                        <li>• Full audit logs for all bot actions</li>
                        <li>• Open-source friendly — self-hostable</li>
                    </ul>
                </div>
            </div>

            <!-- CTA -->
            <div class="text-center mb-16">
                <a href="${inviteUrl}" target="_blank" class="inline-block bg-gradient-to-r from-[#FFAA00] to-amber-400 text-black px-16 py-6 rounded-2xl font-black text-2xl uppercase tracking-widest shadow-2xl hover:shadow-[#FFAA00]/50 hover:scale-105 transition-all">
                    Deploy Impulse OS
                </a>
                <p class="text-slate-500 text-sm mt-6 uppercase tracking-wider">One-click authorization • Instant setup with /setup</p>
            </div>

            <!-- Footer Links -->
            <div class="text-center text-[10px] font-bold text-slate-600 uppercase tracking-widest space-y-2 pb-8">
                <p>Dashboard: <a href="https://impulse.gztexh.com" class="text-[#FFAA00] hover:underline">impulse.gztexh.com</a></p>
                <div class="flex items-center justify-center gap-6">
                    <a href="/" class="hover:text-[#FFAA00] transition-colors">← Terminal Access</a>
                    <span>•</span>
                    <span>Version 2.4.0 • Stable Release</span>
                </div>
            </div>
        </div>
    </body>
    </html>
  `);
});

app.get("/snippets", async (req, res) => {
  if (!req.isAuthenticated()) return res.redirect("/auth/discord");

  // 1. Get IDs of guilds where the user has permission
  const allowedGuildIds = db
    .prepare(`SELECT guild_id FROM guild_settings`)
    .all()
    .map((g) => g.guild_id)
    .filter((gid) => {
      const guild = client.guilds.cache.get(gid);
      if (!guild) return false;
      const member = guild.members.cache.get(req.user.id);
      return (
        member &&
        (member.permissions.has(PermissionFlagsBits.Administrator) ||
          hasHelperRole(member, getSettings(gid)))
      );
    });

  // Handle case where user has no access to any servers
  if (allowedGuildIds.length === 0) {
    return res.send(
      `<html>${getHead(
        "Snippets"
      )} <body class="bg-[#0b0f1a] text-white p-8">${getNav(
        "snippets",
        req.user
      )} <p>No snippets found or no server access.</p></body></html>`
    );
  }

  // 2. Fetch snippets for those guilds
  const snippets = db
    .prepare(
      `
        SELECT * FROM snippets
        WHERE guild_id IN (${allowedGuildIds.map(() => "?").join(",")})
        ORDER BY updated_at DESC
    `
    )
    .all(...allowedGuildIds);

  res.send(`
    <html>
    ${getHead("Impulse | Snippets")}
    <body class="bg-[#0b0f1a] text-slate-200 p-6">
        <div class="max-w-5xl mx-auto">
            ${getNav("snippets", req.user)}

            <div class="flex justify-between items-center mb-6">
                <h1 class="text-2xl font-black text-white uppercase">Snippets</h1>
                <a href="/snippets/new" class="bg-[#FFAA00] text-black px-4 py-2 rounded-lg text-[10px] font-black uppercase">
                    + Create Snippet
                </a>
            </div>

            <div class="space-y-3">
                ${snippets
                  .map((s) => {
                    // Look up the guild name for better UI
                    const guild = client.guilds.cache.get(s.guild_id);
                    return `
                    <div class="bg-slate-900/40 p-4 rounded-xl border border-slate-800 flex justify-between items-center">
                        <div>
                            <div class="flex items-center gap-2">
                                <p class="font-bold text-white">${sanitize(s.name)}</p>
                                <span class="text-[9px] bg-slate-800 px-2 py-0.5 rounded text-slate-500">${
                                  guild ? guild.name : "Unknown Server"
                                }</span>
                            </div>
                            <p class="text-[10px] text-slate-500">ID: ${
                              s.created_by
                            }</p>
                            <p class="text-xs text-slate-400">${
                              s.title || "No title"
                            }</p>
                        </div>
                        <div class="flex items-center gap-3">
                            <a href="/snippets/toggle/${
                              s.id
                            }" class="text-[9px] uppercase font-black ${
                      s.enabled ? "text-emerald-400" : "text-rose-500"
                    } hover:underline">
                                ${s.enabled ? "Enabled" : "Disabled"}
                            </a>
                            <a href="/snippets/edit/${
                              s.id
                            }" class="text-xs text-sky-400 hover:underline">Edit</a>
                            <a href="/snippets/delete/${
                              s.id
                            }" class="text-xs text-rose-500 hover:underline" onclick="return confirm('Delete this snippet?')">Delete</a>
                        </div>
                    </div>
                `;
                  })
                  .join("")}
            </div>
        </div>
    </body>
    </html>
    `);
});

app.get("/snippets/new", (req, res) => {
  if (!req.isAuthenticated()) return res.redirect("/auth/discord");

  const guilds = db
    .prepare(`SELECT guild_id, guild_name FROM guild_settings`)
    .all()
    .filter((g) => {
      const guild = client.guilds.cache.get(g.guild_id);
      if (!guild) return false;
      const member = guild.members.cache.get(req.user.id);
      return (
        member &&
        (member.permissions.has(PermissionFlagsBits.Administrator) ||
          hasHelperRole(member, getSettings(g.guild_id)))
      );
    });

  res.send(`
    <html>
    ${getHead("Impulse | Create Snippet")}
    <style>
        #preTitle:empty, #preDesc:empty, #preFooter:empty, #preImage:not([src]), #preThumb:not([src]) { display: none; }
        .markdown-hint { color: #5865F2; cursor: help; border-bottom: 1px dashed #5865F2; }
    </style>
    <body class="bg-[#0b0f1a] text-slate-200 p-6">
        <div class="max-w-7xl mx-auto">
            ${getNav("snippets", req.user)}
            
            <div class="mb-8 flex justify-between items-end">
                <div>
                    <h1 class="text-3xl font-black text-white uppercase tracking-tighter">Create <span class="text-[#FFAA00]">Snippet</span></h1>
                    <p class="text-xs text-slate-500 uppercase font-bold tracking-widest mt-1">
                        Supports <span class="markdown-hint" title="**Bold**, *Italics*, [Links](url), <@User>">Discord Markdown</span>
                    </p>
                </div>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-2 gap-12">
                <form id="snippetForm" method="POST" action="/snippets/new" class="space-y-4">
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div class="bg-slate-900/50 p-4 rounded-xl border border-slate-800">
                            <label class="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2 block">Target Server</label>
                            <select name="guild_id" required class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs font-bold text-white focus:border-[#FFAA00] outline-none">
                                <option value="" disabled selected>Choose server...</option>
                                ${guilds
                                  .map(
                                    (g) =>
                                      `<option value="${g.guild_id}">${g.guild_name}</option>`
                                  )
                                  .join("")}
                            </select>
                        </div>
                        <div class="bg-slate-900/50 p-4 rounded-xl border border-slate-800">
                            <label class="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2 block">Trigger Name</label>
                            <input name="name" required placeholder="e.g. welcome" class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs font-bold text-white focus:border-[#FFAA00] outline-none">
                        </div>
                    </div>

                    <div class="bg-slate-900/50 p-6 rounded-xl border border-slate-800 space-y-4">
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label class="text-[9px] font-black text-slate-500 uppercase mb-1 block">Title</label>
                                <input id="inTitle" name="title" placeholder="Embed Title" class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white focus:border-[#FFAA00] outline-none">
                            </div>
                            <div>
                                <label class="text-[9px] font-black text-slate-500 uppercase mb-1 block">Title Link (URL)</label>
                                <input id="inUrl" name="url" placeholder="https://..." class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white focus:border-[#FFAA00] outline-none">
                            </div>
                        </div>
                        
                        <div>
                            <div class="flex justify-between items-end mb-2">
                                <label class="text-[9px] font-black text-slate-500 uppercase tracking-widest">Description</label>
                                <div class="flex gap-2">
                                    <span class="text-[8px] font-bold bg-slate-800 text-amber-500 px-2 py-0.5 rounded border border-amber-500/20 cursor-help" title="Mentions the user who ran the command">{user}</span>
                                    <span class="text-[8px] font-bold bg-slate-800 text-amber-500 px-2 py-0.5 rounded border border-amber-500/20 cursor-help" title="The name of the Discord Server">{server}</span>
                                    <span class="text-[8px] font-bold bg-slate-800 text-amber-500 px-2 py-0.5 rounded border border-amber-500/20 cursor-help" title="The current channel">{channel}</span>
                                    <span class="text-[8px] font-bold bg-slate-800 text-amber-500 px-2 py-0.5 rounded border border-amber-500/20 cursor-help" title="Inserts a line break">{br}</span>
                                </div>
                            </div>
                            <textarea id="inDesc" name="description" placeholder="Hello {user}, welcome to {server}!" class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white h-32 focus:border-[#FFAA00] outline-none resize-none"></textarea>
                            <p class="text-[9px] text-slate-500 mt-1 italic font-medium">✨ Supports Discord Markdown (**bold**, [links](url), etc)</p>
                        </div>
                    </div>

                    <div class="bg-slate-900/50 p-6 rounded-xl border border-slate-800 space-y-4">
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label class="text-[9px] font-black text-slate-500 uppercase mb-1 block">Main Image URL</label>
                                <input id="inImage" name="image_url" placeholder="https://.../banner.png" class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white focus:border-[#FFAA00] outline-none">
                            </div>
                            <div>
                                <label class="text-[9px] font-black text-slate-500 uppercase mb-1 block">Thumbnail URL</label>
                                <input id="inThumb" name="thumbnail_url" placeholder="https://.../icon.png" class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white focus:border-[#FFAA00] outline-none">
                            </div>
                        </div>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div class="md:col-span-2">
                             <input id="inFooter" name="footer" placeholder="Footer text" class="w-full bg-slate-900/50 p-4 rounded-xl border border-slate-800 text-xs text-white focus:border-[#FFAA00] outline-none">
                        </div>
                        <div class="bg-slate-900/50 p-4 rounded-xl border border-slate-800 flex items-center justify-between">
                            <input id="inColor" name="color" type="color" value="#FFAA00" class="bg-transparent border-none w-8 h-8 cursor-pointer">
                            <span class="text-[10px] font-mono text-slate-500" id="hexVal">#FFAA00</span>
                        </div>
                    </div>

                    <button type="submit" class="w-full bg-[#FFAA00] text-black py-4 rounded-xl font-black uppercase text-[10px] tracking-widest hover:bg-[#FFC040] transition-all">
                        Create Snippet
                    </button>

                    <div class="flex gap-4">
                        <a href="/snippets" class="flex-1 bg-slate-800 text-slate-400 py-4 rounded-xl font-black uppercase text-[10px] tracking-widest text-center hover:bg-slate-700 transition-all border border-slate-700">
                            Cancel
                        </a>
                    </div>

                </form>

                <div class="sticky top-6">
                    <div class="bg-[#313338] p-4 rounded-sm shadow-2xl font-['gg_sans',_sans-serif]">
                        <div class="flex items-start gap-4">
                            <img src="${client.user.displayAvatarURL()}" class="w-10 h-10 rounded-full">
                            <div class="flex-1 overflow-hidden">
                                <div class="flex items-center gap-2 mb-1">
                                    <span class="font-medium text-white text-sm">${
                                      client.user.username
                                    }</span>
                                    <span class="bg-[#5865F2] text-white text-[10px] px-1.5 py-0.5 rounded-[3px] font-bold uppercase">App</span>
                                    <span class="text-[#949ba4] text-[10px]">Today at ${new Date().toLocaleTimeString(
                                      [],
                                      { hour: "2-digit", minute: "2-digit" }
                                    )}</span>
                                </div>
                                
                                <div id="preBorder" class="bg-[#2b2d31] border-l-[4px] border-[#FFAA00] rounded-[4px] p-3 mt-1 max-w-[432px] relative">
                                    <img id="preThumb" src="" class="absolute top-3 right-3 w-20 h-20 rounded-md object-cover">
                                    
                                    <div id="preTitle" class="text-white font-bold text-base mb-1"></div>
                                    <div id="preDesc" class="text-[#dbdee1] text-sm leading-[1.375rem] whitespace-pre-wrap"></div>
                                    
                                    <img id="preImage" src="" class="mt-3 rounded-md w-full max-h-80 object-cover">
                                    
                                    <div id="preFooter" class="text-[#b5bac1] text-[10px] mt-2 font-medium"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <script>
            const inputs = {
                title: document.getElementById('inTitle'),
                url: document.getElementById('inUrl'),
                desc: document.getElementById('inDesc'),
                footer: document.getElementById('inFooter'),
                color: document.getElementById('inColor'),
                image: document.getElementById('inImage'),
                thumb: document.getElementById('inThumb')
            };

            const preview = {
                title: document.getElementById('preTitle'),
                desc: document.getElementById('preDesc'),
                footer: document.getElementById('preFooter'),
                border: document.getElementById('preBorder'),
                hex: document.getElementById('hexVal'),
                image: document.getElementById('preImage'),
                thumb: document.getElementById('preThumb')
            };

            // Simulated variable replacement for the dashboard preview
            function simulateVars(text) {
                if (!text) return "";
                let p = text
                    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") // Escape HTML
                    .replace(/{user}/g, '<span class="text-[#5865F2] hover:underline cursor-pointer">@${
                      req.user.username
                    }</span>')
                    .replace(/{server}/g, '<strong>Impulse OS</strong>')
                    .replace(/{channel}/g, '<span class="text-[#5865F2] hover:underline cursor-pointer">#general</span>')
                    .replace(/{br}/g, '<br>')
                    // Discord Markdown Simulation
                    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') // Bold
                    .replace(/\*(.*?)\*/g, '<em>$1</em>') // Italics
                    .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="#" class="text-[#00a8fc] hover:underline">$1</a>'); // Links

                return p;
            }

            function updatePreview() {
                // Handle Title and Title Link
                const rawTitle = inputs.title.value;
                if (inputs.url.value) {
                    preview.title.innerHTML = \`<a href="#" class="text-[#00a8fc] hover:underline">\${simulateVars(rawTitle) || 'Untitled Link'}</a>\`;
                } else {
                    preview.title.innerHTML = simulateVars(rawTitle);
                }

                // Use innerHTML for description so our simulated variable spans work
                preview.desc.innerHTML = simulateVars(inputs.desc.value);
                preview.footer.innerText = simulateVars(inputs.footer.value);
                
                preview.border.style.borderColor = inputs.color.value;
                preview.hex.innerText = inputs.color.value.toUpperCase();
                
                // Handle Images
                preview.image.src = inputs.image.value;
                preview.image.style.display = inputs.image.value ? 'block' : 'none';
                
                preview.thumb.src = inputs.thumb.value;
                preview.thumb.style.display = inputs.thumb.value ? 'block' : 'none';
            }

            Object.values(inputs).forEach(input => {
                input.addEventListener('input', updatePreview);
            });
            updatePreview();
        </script>
    </body>
    </html>
    `);
});

app.post(
  "/snippets/new",
  async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect("/auth/discord");

    const {
      guild_id,
      name,
      title,
      description,
      color,
      footer,
      url,
      image_url,
      thumbnail_url,
    } = req.body;

    try {
      // --- SECURITY VALIDATION ---
      const guild = client.guilds.cache.get(guild_id);
      if (!guild)
        return res.status(403).send("Forbidden: Bot is not in this server.");

      const member = await guild.members.fetch(req.user.id).catch(() => null);
      if (!member)
        return res.status(403).send("Forbidden: You are not in this server.");

      const isAuthorized =
        member.permissions.has(PermissionFlagsBits.Administrator) ||
        hasHelperRole(member, getSettings(guild_id));

      if (!isAuthorized) {
        return res
          .status(403)
          .send(
            getErrorPage(
              "Access Denied",
              "Clearance Level: Administrator or Command Helper required for snippet creation."
            )
          );
      }

      // --- DUPLICATE CHECK ---
      const existing = db
        .prepare(`SELECT id FROM snippets WHERE guild_id = ? AND name = ?`)
        .get(guild_id, name.toLowerCase());
      if (existing) {
        return res.send(`<html>${getHead(
          "Error"
        )}<body class="bg-[#0b0f1a] text-white p-8">
                <h1 class="text-xl font-bold">Duplicate Trigger Name!</h1>
                <p>A snippet named "${name}" already exists for this server.</p>
                <button onclick="window.history.back()" class="mt-4 bg-white text-black px-4 py-2 rounded">Go Back</button>
            </body></html>`);
      }

      // --- DATABASE INSERT ---
      db.prepare(
        `
            INSERT INTO snippets (
                guild_id, name, title, description, color, footer, url, image_url, thumbnail_url, created_by
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        guild_id,
        name.toLowerCase(),
        title,
        description,
        color,
        footer,
        url,
        image_url,
        thumbnail_url,
        req.user.id
      );

      logAction(
        guild_id,
        "SNIPPET_CREATE",
        `Created snippet: ${name}`,
        req.user.id,
        req.user.username,
        `https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png`,
        "/snippet",
        null,
        null
      );

      res.redirect("/snippets");
    } catch (err) {
      console.error("Critical Post Error:", err);
      res.status(500).send("Internal Server Error");
    }
  }
);

app.get("/snippets/edit/:id", async (req, res) => {
  if (!req.isAuthenticated()) return res.redirect("/auth/discord");

  const snippet = db
    .prepare(`SELECT * FROM snippets WHERE id = ?`)
    .get(req.params.id);
  if (!snippet)
    return res
      .status(404)
      .send(
        getErrorPage(
          "Data Missing",
          "The requested snippet ID could not be located in the database.",
          "404"
        )
      );
  if (!(await canManageSnippet(req, snippet.guild_id)))
    return res
      .status(403)
      .send(
        getErrorPage(
          "Access Denied",
          "You don't have the required permissions to manage snippets in this server."
        )
      );

  res.send(`
    <html>
    ${getHead("Impulse | Edit Snippet")}
    <body class="bg-[#0b0f1a] text-slate-200 p-6">
        <div class="max-w-6xl mx-auto">
            ${getNav("snippets", req.user)}
            
            <div class="mb-8">
                <h1 class="text-3xl font-black text-white uppercase tracking-tighter text-[#FFAA00]">Edit Snippet</h1>
                <p class="text-[10px] text-slate-500 uppercase font-bold tracking-widest mt-1">Modifying trigger: /snippet name:${sanitize(snippet.name)}</p>
            </div>

            <form id="editForm" method="POST" action="/snippets/edit/${
              snippet.id
            }" class="grid grid-cols-1 lg:grid-cols-2 gap-12">
                <div class="space-y-6">
                    <div class="bg-slate-900/50 p-4 rounded-xl border border-slate-800">
                        <label class="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2 block">Trigger Name (Command)</label>
                        <input name="name" value="${
                          snippet.name
                        }" required class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs font-bold text-white focus:border-[#FFAA00] outline-none">
                    </div>

                    <div class="bg-slate-900/50 p-6 rounded-xl border border-slate-800 space-y-4">
                        <label class="text-[9px] font-black text-slate-500 uppercase tracking-widest block">Embed Content</label>
                        <input id="inTitle" name="title" value="${
                          snippet.title || ""
                        }" placeholder="Embed Title" class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white focus:border-[#FFAA00] outline-none">
                        <input id="inUrl" name="url" value="${
                          snippet.url || ""
                        }" placeholder="Title Link (URL)" class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white focus:border-[#FFAA00] outline-none">
                        <textarea id="inDesc" name="description" placeholder="Description" class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white h-48 focus:border-[#FFAA00] outline-none resize-none">${
                          snippet.description || ""
                        }</textarea>
                    </div>

                    <div class="bg-slate-900/50 p-6 rounded-xl border border-slate-800 space-y-4">
                        <label class="text-[9px] font-black text-slate-500 uppercase tracking-widest block">Assets & Footer</label>
                        <input id="inFooter" name="footer" value="${
                          snippet.footer || ""
                        }" placeholder="Footer Text" class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white focus:border-[#FFAA00] outline-none">
                        <div class="grid grid-cols-2 gap-4">
                            <input id="inImage" name="image_url" value="${
                              snippet.image_url || ""
                            }" placeholder="Main Image URL" class="bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white">
                            <input id="inThumb" name="thumbnail_url" value="${
                              snippet.thumbnail_url || ""
                            }" placeholder="Thumbnail URL" class="bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white">
                        </div>
                    </div>

                    <button type="submit" class="w-full bg-[#FFAA00] text-black py-4 rounded-xl font-black uppercase text-xs tracking-widest hover:bg-[#FFC040] transition-all shadow-lg shadow-amber-500/10">Save Changes</button>
                    <a href="/snippets" class="block text-center text-slate-500 text-[10px] font-bold uppercase hover:text-white">Cancel & Exit</a>
                </div>

                <div class="sticky top-6">
                    <label class="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-4 block text-center">Live Preview</label>
                    <div class="bg-[#313338] p-4 rounded-sm shadow-2xl font-['gg_sans',_sans-serif]">
                        <div class="flex items-start gap-4">
                            <img src="${client.user.displayAvatarURL()}" class="w-10 h-10 rounded-full">
                            <div class="flex-1 overflow-hidden">
                                <div class="flex items-center gap-2 mb-1">
                                    <span class="font-medium text-white text-sm">${
                                      client.user.username
                                    }</span>
                                    <span class="bg-[#5865F2] text-white text-[10px] px-1.5 py-0.5 rounded-[3px] font-bold uppercase">App</span>
                                    <span class="text-[#949ba4] text-[10px]">Today at ${new Date().toLocaleTimeString(
                                      [],
                                      { hour: "2-digit", minute: "2-digit" }
                                    )}</span>
                                </div>
                                
                                <div id="preBorder" class="bg-[#2b2d31] border-l-[4px] border-[#FFAA00] rounded-[4px] p-3 mt-1 max-w-[432px] relative">
                                    <img id="preThumb" src="" class="absolute top-3 right-3 w-20 h-20 rounded-md object-cover">
                                    <div id="preTitle" class="text-white font-bold text-base mb-1"></div>
                                    <div id="preDesc" class="text-[#dbdee1] text-sm leading-[1.375rem] whitespace-pre-wrap"></div>
                                    <img id="preImage" src="" class="mt-3 rounded-md w-full max-h-80 object-cover">
                                    <div id="preFooter" class="text-[#b5bac1] text-[10px] mt-2 font-medium"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </form>
        </div>

        <script>
            // Reuse your updatePreview script here to keep the experience consistent!
            const inputs = {
                title: document.getElementById('inTitle'),
                desc: document.getElementById('inDesc'),
                footer: document.getElementById('inFooter'),
                url: document.getElementById('inUrl'),
                image: document.getElementById('inImage'),
                thumb: document.getElementById('inThumb')
            };

            const preview = {
                title: document.getElementById('preTitle'),
                desc: document.getElementById('preDesc'),
                footer: document.getElementById('preFooter'),
                image: document.getElementById('preImage'),
                thumb: document.getElementById('preThumb')
            };

            function update() {
                preview.title.innerText = inputs.title.value;
                preview.desc.innerText = inputs.desc.value;
                preview.footer.innerText = inputs.footer.value;
                preview.image.src = inputs.image.value;
                preview.image.style.display = inputs.image.value ? 'block' : 'none';
                preview.thumb.src = inputs.thumb.value;
                preview.thumb.style.display = inputs.thumb.value ? 'block' : 'none';
            }

            Object.values(inputs).forEach(i => i.addEventListener('input', update));
            update();
        </script>
    </body>
    </html>
    `);
});

app.post(
  "/snippets/edit/:id",
  async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect("/auth/discord");

    const snippet = db
      .prepare(`SELECT * FROM snippets WHERE id = ?`)
      .get(req.params.id);
    if (!snippet) return res.redirect("/snippets");

    if (!(await canManageSnippet(req, snippet.guild_id)))
      return res
        .status(403)
        .send(
          getErrorPage(
            "Access Denied",
            "System security prevents unauthorized modification of this snippet."
          )
        );

    const {
      name,
      title,
      description,
      footer,
      color,
      url,
      image_url,
      thumbnail_url,
    } = req.body;

    try {
      db.prepare(
        `
            UPDATE snippets 
            SET name = ?, title = ?, description = ?, footer = ?, color = ?, url = ?, image_url = ?, thumbnail_url = ?
            WHERE id = ?
        `
      ).run(
        name.toLowerCase(),
        title,
        description,
        footer,
        color || "#FFAA00",
        url,
        image_url,
        thumbnail_url,
        req.params.id
      );

      logAction(
        snippet.guild_id,
        "SNIPPET_UPDATE",
        `Updated snippet: ${name}`,
        req.user.id,
        req.user.username,
        `https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png`,
        null,
        null,
        null
      );

      res.redirect("/snippets");
    } catch (err) {
      console.error(err);
      res.status(500).send("Failed to update database.");
    }
  }
);

app.get("/snippets/delete/:id", async (req, res) => {
  if (!req.isAuthenticated()) return res.redirect("/auth/discord");

  const snippet = db
    .prepare(`SELECT * FROM snippets WHERE id = ?`)
    .get(req.params.id);
  if (!snippet) return res.redirect("/snippets");

  if (!(await canManageSnippet(req, snippet.guild_id))) {
    return res
      .status(403)
      .send(
        getErrorPage(
          "Access Denied",
          "Deletion sequence aborted. Required permissions not detected."
        )
      );
  }

  db.prepare(`DELETE FROM snippets WHERE id = ?`).run(req.params.id);

  logAction(
    snippet.guild_id,
    "SNIPPET_DELETE",
    `Deleted snippet: ${snippet.name}`,
    req.user.id,
    req.user.username,
    `https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png`,
    null,
    null
  );

  res.redirect("/snippets");
});

app.get("/snippets/toggle/:id", async (req, res) => {
  if (!req.isAuthenticated()) return res.redirect("/auth/discord");
  const snippet = db
    .prepare(`SELECT * FROM snippets WHERE id = ?`)
    .get(req.params.id);
  if (!snippet || !(await canManageSnippet(req, snippet.guild_id)))
    return res.redirect("/snippets");

  db.prepare(
    `
        UPDATE snippets SET enabled = NOT enabled WHERE id = ?
    `
  ).run(snippet.id);

  res.redirect("/snippets");
});

app.get("/fun", async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect("/auth/discord");
    
    const managedGuilds = getManagedGuilds(req.user.id);
    if (managedGuilds.length === 0) return res.send(getErrorPage("No Access", "Admin/Helper role required."));

    const selectedGuildId = req.query.guild || managedGuilds[0];
    const settings = getSettings(selectedGuildId);
    const triggers = db.prepare("SELECT * FROM reaction_triggers WHERE guild_id = ?").all(selectedGuildId);
    const funEnabled = settings?.fun_features_enabled !== 0;

    const guildNames = managedGuilds.map(id => {
        const g = client.guilds.cache.get(id);
        return { id, name: g ? g.name : id };
    });

    res.send(`
        <html>
        ${getHead("Impulse | Fun Features")}
        <body class="bg-[#0b0f1a] text-slate-200 min-h-screen p-6">
            <div class="max-w-6xl mx-auto">
                ${getNav("fun", req.user)}
                
                <div class="flex items-center justify-between mb-8">
                    <div>
                        <h1 class="text-3xl font-black text-white uppercase tracking-tighter">Fun <span class="text-[#FFAA00]">Features</span></h1>
                        <p class="text-xs text-slate-500 uppercase font-bold tracking-widest">Reaction Triggers & Auto-Replies</p>
                    </div>
                    <div class="flex items-center gap-3">
                        ${guildNames.length > 1 ? `
                        <select onchange="window.location='/fun?guild='+this.value" class="bg-slate-900 border border-slate-700 text-white text-xs font-bold px-3 py-2 rounded-lg outline-none focus:border-[#FFAA00]">
                            ${guildNames.map(g => `<option value="${g.id}" ${g.id === selectedGuildId ? 'selected' : ''}>${g.name}</option>`).join('')}
                        </select>` : `<span class="text-[10px] font-black text-slate-500 uppercase">${guildNames[0]?.name || 'Server'}</span>`}
                        <a href="/fun/toggle?guild=${selectedGuildId}" class="flex items-center gap-3 bg-slate-900/50 px-4 py-2 rounded-2xl border border-slate-800 cursor-pointer hover:border-[#FFAA00]/30 transition">
                            <span class="text-[10px] font-black uppercase tracking-widest ${funEnabled ? 'text-emerald-400' : 'text-rose-500'}">
                                ${funEnabled ? '● System Active' : '○ System Offline'}
                            </span>
                        </a>
                    </div>
                </div>

                ${triggers.length === 0 ? `
                <div class="text-center py-20">
                    <p class="text-slate-600 text-sm font-bold uppercase tracking-widest mb-2">No Active Triggers</p>
                    <p class="text-slate-700 text-xs">Use <code class="bg-slate-800 px-2 py-0.5 rounded text-[#FFAA00]">/reactmessage</code> in Discord to create one.</p>
                </div>` : `
                <div class="grid gap-4">
                    ${triggers.map(t => `
                        <div class="bg-slate-900/40 p-5 rounded-xl border border-slate-800 flex items-center justify-between">
                            <div class="flex items-center gap-4">
                                <div class="w-12 h-12 bg-[#FFAA00]/10 rounded-xl flex items-center justify-center text-2xl border border-[#FFAA00]/20">
                                    ${t.reaction_id}
                                </div>
                                <div>
                                    <p class="text-white font-bold text-sm">Target: <span class="text-[#FFAA00] mono"><@${t.target_user_id}></span></p>
                                    <p class="text-[10px] text-slate-400 uppercase font-bold mt-0.5">Threshold: ${t.trigger_count} reactions</p>
                                    <p class="text-xs text-slate-500 mt-1">Reply: <span class="text-slate-300 italic">"${t.response_text}"</span></p>
                                </div>
                            </div>
                            <div class="flex items-center gap-4">
                                <span class="text-[9px] px-2 py-1 rounded border font-black uppercase ${t.enabled ? 'text-emerald-400 border-emerald-500/20 bg-emerald-500/10' : 'text-rose-400 border-rose-500/20 bg-rose-500/10'}">${t.enabled ? 'Enabled' : 'Disabled'}</span>
                                <a href="/fun/delete/${t.id}?guild=${selectedGuildId}" 
                                   onclick="return confirm('Delete this trigger?')"
                                   class="text-rose-500 hover:text-rose-400 text-[10px] font-black uppercase tracking-widest transition">Delete</a>
                            </div>
                        </div>
                    `).join('')}
                </div>`}
            </div>
        </body>
        </html>
    `);
});

app.get("/fun/toggle", (req, res) => {
    if (!req.isAuthenticated()) return res.redirect("/auth/discord");
    const guildId = req.query.guild;
    if (!guildId) return res.redirect("/fun");
    const managedGuilds = getManagedGuilds(req.user.id);
    if (!managedGuilds.includes(guildId)) return res.status(403).send(getErrorPage("Access Denied", "Unauthorized."));
    db.prepare("UPDATE guild_settings SET fun_features_enabled = CASE WHEN fun_features_enabled = 1 THEN 0 ELSE 1 END WHERE guild_id = ?").run(guildId);
    res.redirect(`/fun?guild=${guildId}`);
});

// ============================================================
// ADMIN PANEL ROUTES
// ============================================================

app.get('/admin/login', (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/auth/discord');
    if (req.user.id !== process.env.ADMIN_DISCORD_ID) {
        return res.status(403).send(getErrorPage("Access Denied", "Restricted area.", "403"));
    }

    const error = req.query.error;
    res.send(`
        <html>
        ${getHead("Impulse | Admin Access")}
        <body class="bg-[#0b0f1a] text-white flex items-center justify-center min-h-screen p-6">
            <div class="max-w-sm w-full">
                <div class="text-center mb-8">
                    <div class="inline-flex w-16 h-16 rounded-2xl bg-red-500/20 border border-red-500/40 items-center justify-center mb-4">
                        <svg class="w-8 h-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
                        </svg>
                    </div>
                    <h1 class="text-2xl font-black uppercase tracking-tight">Admin <span class="text-red-400">Verification</span></h1>
                    <p class="text-slate-500 text-[10px] uppercase tracking-widest mt-2">Enter your admin passphrase to continue</p>
                </div>

                <div class="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 shadow-2xl">
                    ${error ? `<div class="bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-bold px-4 py-3 rounded-xl mb-4 uppercase tracking-widest">❌ ${error}</div>` : ''}
                    <form method="POST" action="/admin/login" class="space-y-4">
                        <div>
                            <label class="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2 block">Passphrase</label>
                            <input type="password" name="secret" autofocus
                                class="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-white focus:border-red-500 outline-none font-mono"
                                placeholder="••••••••••••">
                        </div>
                        <button type="submit" class="w-full bg-red-500 hover:bg-red-400 text-white py-3 rounded-xl font-black text-xs uppercase tracking-widest transition-all shadow-lg shadow-red-500/20">
                            Authenticate
                        </button>
                    </form>
                    <p class="text-[9px] text-center text-slate-600 mt-4 uppercase tracking-widest">This session expires after 2 hours of inactivity</p>
                </div>
            </div>
        </body>
        </html>
    `);
});

app.post('/admin/login', (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/auth/discord');
    if (req.user.id !== process.env.ADMIN_DISCORD_ID) return res.status(403).send('Forbidden');

    if (req.body.secret !== process.env.ADMIN_SECRET) {
        return res.redirect('/admin/login?error=Invalid+passphrase');
    }

    const token = require('crypto').randomBytes(32).toString('hex');
    adminSessions.set(token, {
        userId: req.user.id,
        expires: Date.now() + 2 * 60 * 60 * 1000
    });

    res.cookie('admin_token', token, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        maxAge: 2 * 60 * 60 * 1000
    });

    res.redirect('/admin');
});

app.get('/admin/logout', (req, res) => {
    const token = req.cookies?.admin_token;
    if (token) adminSessions.delete(token);
    res.clearCookie('admin_token');
    res.redirect('/');
});

// ADMIN OVERVIEW
app.get('/admin', requireAdmin, (req, res) => {
    const stats = {
        guilds: client.guilds.cache.size,
        users: client.users.cache.size,
        totalLogs: db.prepare("SELECT COUNT(*) as c FROM audit_logs").get().c,
        totalSnippets: db.prepare("SELECT COUNT(*) as c FROM snippets").get().c,
        totalThreads: db.prepare("SELECT COUNT(*) as c FROM thread_tracking").get().c,
        pendingLocks: db.prepare("SELECT COUNT(*) as c FROM pending_locks").get().c,
        blockedUsers: db.prepare("SELECT COUNT(*) as c FROM blocked_users").get().c,
        bannedUsers: db.prepare("SELECT COUNT(*) as c FROM banned_users").get().c,
        suspendedUsers: db.prepare("SELECT COUNT(*) as c FROM suspended_users WHERE expires_at > ?").get(Date.now()).c,
        recentErrors: db.prepare("SELECT COUNT(*) as c FROM audit_logs WHERE action = 'ERROR' AND timestamp > datetime('now', '-24 hours')").get().c,
    };

    const recentLogs = db.prepare("SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 20").all();
    const allGuilds = db.prepare("SELECT * FROM guild_settings").all();

    res.send(`
        <html>
        ${getHead("Impulse | Admin Control Panel")}
        <body class="bg-[#0b0f1a] text-slate-200 min-h-screen p-6 md:p-8">
        <div class="max-w-7xl mx-auto">
            ${getAdminNav('overview')}

            <div class="mb-8">
                <h1 class="text-3xl font-black text-white uppercase tracking-tighter">Global <span class="text-red-400">Overview</span></h1>
                <p class="text-xs text-slate-500 uppercase font-bold tracking-widest">Full system visibility • Root access</p>
            </div>

            <!-- Stats Grid -->
            <div class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
                ${[
                    { label: 'Servers', value: stats.guilds, color: 'amber' },
                    { label: 'Cached Users', value: stats.users, color: 'blue' },
                    { label: 'Total Logs', value: stats.totalLogs, color: 'slate' },
                    { label: 'Active Threads', value: stats.totalThreads, color: 'emerald' },
                    { label: 'Pending Locks', value: stats.pendingLocks, color: 'orange' },
                    { label: 'Blocked Users', value: stats.blockedUsers, color: 'red' },
                    { label: 'Banned Users', value: stats.bannedUsers, color: 'red' },
                    { label: 'Suspended', value: stats.suspendedUsers, color: 'yellow' },
                    { label: 'Snippets', value: stats.totalSnippets, color: 'purple' },
                    { label: 'Errors (24h)', value: stats.recentErrors, color: stats.recentErrors > 0 ? 'red' : 'slate' },
                ].map(s => `
                    <div class="bg-slate-900/40 border border-slate-800 rounded-xl p-4">
                        <p class="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">${s.label}</p>
                        <p class="text-2xl font-black text-white">${s.value}</p>
                    </div>
                `).join('')}
            </div>

            <!-- Per-server breakdown -->
            <div class="bg-slate-900/40 border border-slate-800 rounded-2xl overflow-hidden mb-8">
                <div class="p-5 border-b border-slate-800">
                    <h2 class="text-sm font-black text-white uppercase tracking-tight">All Configured Servers</h2>
                </div>
                <div class="overflow-x-auto">
                    <table class="w-full text-left">
                        <thead class="bg-slate-900/60 border-b border-slate-800">
                            <tr>
                                ${['Server', 'Guild ID', 'Forum', 'Snippets', 'Threads Tracked', 'Pending Locks', 'Blocked Users'].map(h =>
                                    `<th class="p-4 text-[9px] font-black uppercase text-slate-500 tracking-widest">${h}</th>`
                                ).join('')}
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-slate-800/40">
                            ${allGuilds.map(g => {
                                const guild = client.guilds.cache.get(g.guild_id);
                                const snippets = db.prepare("SELECT COUNT(*) as c FROM snippets WHERE guild_id = ?").get(g.guild_id).c;
                                const threads = db.prepare("SELECT COUNT(*) as c FROM thread_tracking WHERE guild_id = ?").get(g.guild_id).c;
                                const locks = db.prepare("SELECT COUNT(*) as c FROM pending_locks WHERE guild_id = ?").get(g.guild_id).c;
                                const blocked = db.prepare("SELECT COUNT(*) as c FROM blocked_users WHERE guild_id = ?").get(g.guild_id).c;
                                return `
                                <tr class="hover:bg-white/5 transition">
                                    <td class="p-4 text-sm font-bold text-white">${g.guild_name}</td>
                                    <td class="p-4 text-[10px] mono text-slate-500">${g.guild_id}</td>
                                    <td class="p-4 text-[10px] mono text-slate-500">${g.forum_id}</td>
                                    <td class="p-4 text-sm text-slate-300">${snippets}</td>
                                    <td class="p-4 text-sm text-slate-300">${threads}</td>
                                    <td class="p-4 text-sm ${locks > 0 ? 'text-emerald-400' : 'text-slate-500'}">${locks}</td>
                                    <td class="p-4 text-sm ${blocked > 0 ? 'text-red-400' : 'text-slate-500'}">${blocked}</td>
                                </tr>`;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- Recent logs -->
            <div class="bg-slate-900/40 border border-slate-800 rounded-2xl overflow-hidden">
                <div class="p-5 border-b border-slate-800 flex justify-between items-center">
                    <h2 class="text-sm font-black text-white uppercase tracking-tight">Recent Activity (Global)</h2>
                    <a href="/admin/errors" class="text-red-400 text-[9px] font-black uppercase tracking-widest hover:underline">Errors Only →</a>
                </div>
                <div class="divide-y divide-slate-800/40">
                    ${recentLogs.map(l => `
                        <div class="p-4 hover:bg-white/5 transition flex items-center gap-4">
                            <span class="px-2 py-0.5 rounded text-[8px] font-black ${getActionColor(l.action)} border shrink-0">${l.action}</span>
                            <p class="text-xs text-slate-400 flex-1 truncate">${l.details}</p>
                            <span class="text-[9px] text-slate-600 mono shrink-0">${new Date(l.timestamp).toLocaleString()}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>
        </body></html>
    `);
});

// ADMIN USERS PAGE
app.get('/admin/users', requireAdmin, (req, res) => {
    const blockedUsers = db.prepare("SELECT bu.*, gs.guild_name FROM blocked_users bu LEFT JOIN guild_settings gs ON bu.guild_id = gs.guild_id ORDER BY bu.blocked_at DESC").all();
    const bannedUsers = db.prepare("SELECT * FROM banned_users ORDER BY banned_at DESC").all();
    const suspendedUsers = db.prepare("SELECT su.*, gs.guild_name FROM suspended_users su LEFT JOIN guild_settings gs ON su.guild_id = gs.guild_id WHERE su.expires_at > ? ORDER BY su.suspended_at DESC").all(Date.now());

    res.send(`
        <html>
        ${getHead("Impulse Admin | Users")}
        <body class="bg-[#0b0f1a] text-slate-200 min-h-screen p-6 md:p-8">
        <div class="max-w-7xl mx-auto">
            ${getAdminNav('users')}

            <div class="mb-8">
                <h1 class="text-3xl font-black text-white uppercase tracking-tighter">User <span class="text-red-400">Management</span></h1>
                <p class="text-xs text-slate-500 uppercase font-bold tracking-widest">Global view of all restricted users</p>
            </div>

            <!-- Banned Users -->
            <div class="bg-slate-900/40 border border-red-900/30 rounded-2xl overflow-hidden mb-6">
                <div class="p-5 border-b border-red-900/30 bg-red-900/10">
                    <h2 class="text-sm font-black text-red-400 uppercase tracking-tight">🔨 Globally Banned (${bannedUsers.length})</h2>
                </div>
                ${bannedUsers.length === 0 ? '<p class="text-center text-slate-600 py-8 text-xs italic">No globally banned users</p>' : `
                <div class="divide-y divide-slate-800/40">
                    ${bannedUsers.map(u => `
                        <div class="p-4 flex items-center justify-between hover:bg-white/5 transition">
                            <div>
                                <p class="text-sm font-bold text-white mono">${u.user_id}</p>
                                <p class="text-[10px] text-slate-500">${u.reason || 'No reason given'} • Banned by ${u.banned_by}</p>
                            </div>
                            <div class="flex items-center gap-3">
                                <span class="text-[9px] text-slate-600 mono">${new Date(u.banned_at).toLocaleDateString()}</span>
                                <a href="/admin/unban/${u.user_id}" onclick="return confirm('Unban this user globally?')" 
                                   class="text-[9px] font-black uppercase text-emerald-400 hover:text-emerald-300 transition">Unban</a>
                            </div>
                        </div>
                    `).join('')}
                </div>`}
            </div>

            <!-- Blocked Users -->
            <div class="bg-slate-900/40 border border-slate-800 rounded-2xl overflow-hidden mb-6">
                <div class="p-5 border-b border-slate-800">
                    <h2 class="text-sm font-black text-orange-400 uppercase tracking-tight">🚫 Server Blocked (${blockedUsers.length})</h2>
                </div>
                ${blockedUsers.length === 0 ? '<p class="text-center text-slate-600 py-8 text-xs italic">No blocked users</p>' : `
                <div class="divide-y divide-slate-800/40">
                    ${blockedUsers.map(u => `
                        <div class="p-4 flex items-center justify-between hover:bg-white/5 transition">
                            <div>
                                <p class="text-sm font-bold text-white mono">${u.user_id}</p>
                                <p class="text-[10px] text-slate-500">${u.guild_name || u.guild_id} • ${u.reason || 'No reason'}</p>
                            </div>
                            <div class="flex items-center gap-3">
                                <span class="text-[9px] text-slate-600 mono">${new Date(u.blocked_at).toLocaleDateString()}</span>
                                <a href="/admin/unblock/${u.guild_id}/${u.user_id}" onclick="return confirm('Unblock this user?')"
                                   class="text-[9px] font-black uppercase text-emerald-400 hover:text-emerald-300 transition">Unblock</a>
                            </div>
                        </div>
                    `).join('')}
                </div>`}
            </div>

            <!-- Suspended Users -->
            <div class="bg-slate-900/40 border border-slate-800 rounded-2xl overflow-hidden">
                <div class="p-5 border-b border-slate-800">
                    <h2 class="text-sm font-black text-yellow-400 uppercase tracking-tight">⏸ Auto-Suspended (${suspendedUsers.length})</h2>
                </div>
                ${suspendedUsers.length === 0 ? '<p class="text-center text-slate-600 py-8 text-xs italic">No active suspensions</p>' : `
                <div class="divide-y divide-slate-800/40">
                    ${suspendedUsers.map(u => `
                        <div class="p-4 flex items-center justify-between hover:bg-white/5 transition">
                            <div>
                                <p class="text-sm font-bold text-white mono">${u.user_id}</p>
                                <p class="text-[10px] text-slate-500">${u.guild_name || u.guild_id} • ${u.reason}</p>
                            </div>
                            <div class="flex items-center gap-3">
                                <span class="text-[9px] text-yellow-500 font-bold">Expires <span data-expire="${u.expires_at}">...</span></span>
                                <a href="/admin/unsuspend/${u.guild_id}/${u.user_id}" onclick="return confirm('Lift this suspension?')"
                                   class="text-[9px] font-black uppercase text-emerald-400 hover:text-emerald-300 transition">Lift</a>
                            </div>
                        </div>
                    `).join('')}
                </div>`}
            </div>
        </div>
        <script>
            document.querySelectorAll('[data-expire]').forEach(el => {
                const diff = parseInt(el.getAttribute('data-expire')) - Date.now();
                const m = Math.floor(diff / 60000);
                el.innerText = m + 'm';
            });
        </script>
        </body></html>
    `);
});

// ADMIN ERRORS PAGE
app.get('/admin/errors', requireAdmin, (req, res) => {
    const errors = db.prepare("SELECT * FROM audit_logs WHERE action IN ('ERROR', 'AUTO_SUSPEND', 'AUTO_CLOSE') ORDER BY timestamp DESC LIMIT 100").all();

    res.send(`
        <html>
        ${getHead("Impulse Admin | Errors")}
        <body class="bg-[#0b0f1a] text-slate-200 min-h-screen p-6 md:p-8">
        <div class="max-w-7xl mx-auto">
            ${getAdminNav('errors')}
            <div class="mb-8">
                <h1 class="text-3xl font-black text-white uppercase tracking-tighter">Error <span class="text-red-400">Monitor</span></h1>
                <p class="text-xs text-slate-500 uppercase font-bold tracking-widest">Auto-suspensions, errors, and automated actions</p>
            </div>

            <div class="bg-slate-900/40 border border-slate-800 rounded-2xl overflow-hidden">
                ${errors.length === 0 ? '<p class="text-center text-slate-600 py-16 text-sm italic">No errors or automated events logged. All clear!</p>' : `
                <div class="divide-y divide-slate-800/40">
                    ${errors.map(e => `
                        <div class="p-4 hover:bg-white/5 transition flex items-start gap-4">
                            <span class="px-2 py-0.5 rounded text-[8px] font-black ${getActionColor(e.action)} border shrink-0 mt-0.5">${e.action}</span>
                            <div class="flex-1 min-w-0">
                                <p class="text-xs text-slate-300 font-medium">${e.details}</p>
                                ${e.user_name ? `<p class="text-[10px] text-slate-600 mt-0.5">User: ${e.user_name} (${e.user_id})</p>` : ''}
                            </div>
                            <span class="text-[9px] text-slate-600 mono shrink-0">${new Date(e.timestamp).toLocaleString()}</span>
                        </div>
                    `).join('')}
                </div>`}
            </div>
        </div>
        </body></html>
    `);
});

// ADMIN DATABASE PAGE
app.get('/admin/database', requireAdmin, (req, res) => {
    const tables = ['guild_settings', 'thread_tracking', 'pending_locks', 'audit_logs', 'snippets', 'thread_links', 'reaction_triggers', 'blocked_users', 'banned_users', 'suspended_users', 'command_cooldowns'];
    const tableCounts = tables.map(t => ({
        name: t,
        count: db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get().c
    }));
    const dbSize = (() => { try { return require('fs').statSync('database.db').size; } catch(e) { return 0; } })();

    res.send(`
        <html>
        ${getHead("Impulse Admin | Database")}
        <body class="bg-[#0b0f1a] text-slate-200 min-h-screen p-6 md:p-8">
        <div class="max-w-7xl mx-auto">
            ${getAdminNav('database')}
            <div class="mb-8">
                <h1 class="text-3xl font-black text-white uppercase tracking-tighter">Database <span class="text-red-400">Inspector</span></h1>
                <p class="text-xs text-slate-500 uppercase font-bold tracking-widest">Table row counts • DB size • Health check</p>
            </div>

            <div class="bg-slate-900/40 border border-slate-800 rounded-xl p-5 mb-6 flex items-center justify-between">
                <div>
                    <p class="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Database File Size</p>
                    <p class="text-2xl font-black text-white">${(dbSize / 1024).toFixed(1)} <span class="text-sm text-slate-500">KB</span></p>
                </div>
                <div>
                    <p class="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Total Tables</p>
                    <p class="text-2xl font-black text-white">${tables.length}</p>
                </div>
                <div>
                    <p class="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Total Rows</p>
                    <p class="text-2xl font-black text-white">${tableCounts.reduce((a, t) => a + t.count, 0).toLocaleString()}</p>
                </div>
                <a href="/admin/database/vacuum" onclick="return confirm('Run VACUUM? This will optimize the database.')"
                   class="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white px-5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition">
                    Run VACUUM
                </a>
            </div>

            <div class="grid grid-cols-2 md:grid-cols-3 gap-4">
                ${tableCounts.map(t => `
                    <div class="bg-slate-900/40 border border-slate-800 rounded-xl p-5">
                        <p class="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2 mono">${t.name}</p>
                        <p class="text-3xl font-black text-white">${t.count.toLocaleString()}</p>
                        <p class="text-[9px] text-slate-600 uppercase font-bold mt-1">rows</p>
                    </div>
                `).join('')}
            </div>
        </div>
        </body></html>
    `);
});

app.get('/admin/database/vacuum', requireAdmin, (req, res) => {
    db.prepare("VACUUM").run();
    res.redirect('/admin/database');
});

// ADMIN SYSTEM PAGE
app.get('/admin/system', requireAdmin, (req, res) => {
    const memUsage = process.memoryUsage();
    const uptimeSeconds = process.uptime();
    const d = Math.floor(uptimeSeconds / 86400);
    const h = Math.floor((uptimeSeconds % 86400) / 3600);
    const m = Math.floor((uptimeSeconds % 3600) / 60);
    const s = Math.floor(uptimeSeconds % 60);
    const uptimeStr = `${d}d ${h}h ${m}m ${s}s`;

    res.send(`
        <html>
        ${getHead("Impulse Admin | System")}
        <body class="bg-[#0b0f1a] text-slate-200 min-h-screen p-6 md:p-8">
        <div class="max-w-7xl mx-auto">
            ${getAdminNav('system')}
            <div class="mb-8">
                <h1 class="text-3xl font-black text-white uppercase tracking-tighter">System <span class="text-red-400">Monitor</span></h1>
                <p class="text-xs text-slate-500 uppercase font-bold tracking-widest">Process health • Memory • Runtime info</p>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div class="bg-slate-900/40 border border-slate-800 rounded-2xl p-6 space-y-4">
                    <h3 class="text-[10px] font-black text-slate-500 uppercase tracking-widest">Process Info</h3>
                    ${[
                        ['Uptime', uptimeStr],
                        ['Node.js Version', process.version],
                        ['Platform', process.platform],
                        ['PID', process.pid],
                        ['Discord.js', require('./node_modules/discord.js/package.json').version],
                    ].map(([k, v]) => `
                        <div class="flex justify-between items-center py-2 border-b border-slate-800/50">
                            <span class="text-[10px] font-black text-slate-500 uppercase tracking-widest">${k}</span>
                            <span class="text-xs font-bold text-white mono">${v}</span>
                        </div>
                    `).join('')}
                </div>

                <div class="bg-slate-900/40 border border-slate-800 rounded-2xl p-6 space-y-4">
                    <h3 class="text-[10px] font-black text-slate-500 uppercase tracking-widest">Memory Usage</h3>
                    ${[
                        ['Heap Used', (memUsage.heapUsed / 1024 / 1024).toFixed(2) + ' MB'],
                        ['Heap Total', (memUsage.heapTotal / 1024 / 1024).toFixed(2) + ' MB'],
                        ['RSS', (memUsage.rss / 1024 / 1024).toFixed(2) + ' MB'],
                        ['External', (memUsage.external / 1024 / 1024).toFixed(2) + ' MB'],
                    ].map(([k, v]) => `
                        <div class="flex justify-between items-center py-2 border-b border-slate-800/50">
                            <span class="text-[10px] font-black text-slate-500 uppercase tracking-widest">${k}</span>
                            <span class="text-xs font-bold text-[#FFAA00] mono">${v}</span>
                        </div>
                    `).join('')}

                    <div class="pt-2">
                        <p class="text-[9px] text-slate-600 uppercase font-bold tracking-widest mb-2">Heap Usage</p>
                        <div class="w-full bg-slate-800 rounded-full h-2">
                            <div class="bg-[#FFAA00] h-2 rounded-full transition-all" style="width: ${Math.min(100, (memUsage.heapUsed / memUsage.heapTotal * 100)).toFixed(1)}%"></div>
                        </div>
                        <p class="text-[9px] text-slate-600 mt-1">${(memUsage.heapUsed / memUsage.heapTotal * 100).toFixed(1)}% used</p>
                    </div>
                </div>

                <div class="bg-slate-900/40 border border-slate-800 rounded-2xl p-6 md:col-span-2">
                    <h3 class="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-4">Discord Client</h3>
                    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                        ${[
                            ['Ping', client.ws.ping + 'ms'],
                            ['Guilds', client.guilds.cache.size],
                            ['Cached Users', client.users.cache.size],
                            ['Cached Channels', client.channels.cache.size],
                        ].map(([k, v]) => `
                            <div class="bg-slate-800/50 rounded-xl p-4">
                                <p class="text-2xl font-black text-white">${v}</p>
                                <p class="text-[9px] text-slate-500 uppercase font-bold tracking-wider mt-1">${k}</p>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>
        </div>
        </body></html>
    `);
});

// ADMIN action routes
app.get('/admin/unban/:userId', requireAdmin, (req, res) => {
    db.prepare("DELETE FROM banned_users WHERE user_id = ?").run(req.params.userId);
    res.redirect('/admin/users');
});

app.get('/admin/unblock/:guildId/:userId', requireAdmin, (req, res) => {
    db.prepare("DELETE FROM blocked_users WHERE guild_id = ? AND user_id = ?").run(req.params.guildId, req.params.userId);
    res.redirect('/admin/users');
});

app.get('/admin/unsuspend/:guildId/:userId', requireAdmin, (req, res) => {
    db.prepare("DELETE FROM suspended_users WHERE guild_id = ? AND user_id = ?").run(req.params.guildId, req.params.userId);
    res.redirect('/admin/users');
});

app.use((req, res) => {
  res
    .status(404)
    .send(
      getErrorPage(
        "Page Not Found",
        "The system module you requested does not exist or has been moved.",
        "404"
      )
    );
});

app.get("/fun/delete/:id", async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect("/auth/discord");

    const trigger = db.prepare("SELECT * FROM reaction_triggers WHERE id = ?").get(req.params.id);
    if (!trigger) return res.redirect("/fun");

    const managedGuilds = getManagedGuilds(req.user.id);
    if (!managedGuilds.includes(trigger.guild_id)) {
        return res.status(403).send(getErrorPage("Access Denied", "You don't have permission to delete this trigger."));
    }

    db.prepare("DELETE FROM reaction_triggers WHERE id = ?").run(req.params.id);
    db.prepare("DELETE FROM triggered_messages WHERE trigger_id = ?").run(req.params.id);

    const redirectGuild = req.query.guild || trigger.guild_id;
    res.redirect(`/fun?guild=${redirectGuild}`);
});

app.listen(3000, "0.0.0.0");

// --- BOT EVENTS ---
const IMPULSE_COLOR = 0xffaa00;

client.once("clientReady", async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);

  // ONE-TIME: Scan and track threads from the last 2 weeks
  console.log("📊 Scanning existing threads from the last 2 weeks...");
  const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const allSettings = db.prepare("SELECT * FROM guild_settings").all();

  for (const settings of allSettings) {
    try {
      const guild = client.guilds.cache.get(settings.guild_id);
      if (!guild) continue;

      const forumChannel = await guild.channels.fetch(settings.forum_id).catch(() => null);
      if (!forumChannel || !forumChannel.isThreadOnly()) continue;

      const threads = await forumChannel.threads.fetchActive();
      const toTrack = [];

      for (const [threadId, thread] of threads.threads) {
        if (!thread.createdTimestamp || thread.createdTimestamp < twoWeeksAgo) continue;
        if (thread.appliedTags.includes(settings.resolved_tag)) continue;
        const existing = db.prepare("SELECT 1 FROM thread_tracking WHERE thread_id = ?").get(threadId);
        if (!existing) toTrack.push({ threadId, thread });
      }

      console.log(`📋 ${guild.name}: ${toTrack.length} new threads to register`);

      // Insert in batches of 50 with a small delay between batches
      for (let i = 0; i < toTrack.length; i += 50) {
        const batch = toTrack.slice(i, i + 50);
        const insert = db.prepare("INSERT INTO thread_tracking (thread_id, guild_id, created_at) VALUES (?, ?, ?)");
        const insertMany = db.transaction((items) => {
          for (const { threadId, thread } of items) {
            insert.run(threadId, settings.guild_id, thread.createdTimestamp || Date.now());
          }
        });
        insertMany(batch);
        if (i + 50 < toTrack.length) await sleep(500);
      }

      console.log(`✅ ${guild.name}: registered ${toTrack.length} threads`);
    } catch (error) {
      console.error(`Error scanning guild ${settings.guild_id}:`, error);
    }
  }
  console.log("✅ Initial thread scan complete!");

  // Timer for locking resolved threads (every 1 minute)
  setInterval(async () => {
    const rows = db
      .prepare("SELECT * FROM pending_locks WHERE lock_at <= ?")
      .all(Date.now());
    for (const row of rows) {
      const settings = getSettings(row.guild_id);
      if (!settings) continue;
      try {
        const thread = await client.channels.fetch(row.thread_id);
        if (thread) {
          await thread.setAppliedTags([settings.resolved_tag]);
          await thread.setLocked(true);

          const lockEmbed = new EmbedBuilder()
            .setTitle("🔒 Thread Locked")
            .setDescription(
              "This thread has been marked as resolved and is now closed. Thank you for using our support forum!"
            )
            .setColor(IMPULSE_COLOR)
            .setTimestamp()
            .setFooter({ text: "Impulse Bot • Automated Lock" });

          await thread.send({ embeds: [lockEmbed] });
          logAction(row.guild_id, "LOCK", `Locked thread: ${thread.name}`);
        }
      } catch (e) {
        console.error("Lock error:", e);
      }
      db.prepare("DELETE FROM pending_locks WHERE thread_id = ?").run(
        row.thread_id
      );
    }
  }, 60000);

  setInterval(async () => {
    await checkStaleThreads();
  }, 6 * 60 * 60 * 1000);

  await checkStaleThreads();
});

// Sends messages in chunks to avoid Discord rate limits
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function processInChunks(items, handler, chunkSize = 5, delayMs = 1500) {
    let processed = 0, failed = 0;
    for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        await Promise.allSettled(chunk.map(async item => {
            try { await handler(item); processed++; }
            catch (e) { console.error('Chunk handler error:', e.message); failed++; }
        }));
        if (i + chunkSize < items.length) await sleep(delayMs);
    }
    return { processed, failed };
}

async function checkStaleThreads() {
    console.log("🔍 Checking for stale threads...");

    const warningThreshold = Date.now() - 24 * 24 * 60 * 60 * 1000;
    const closeThreshold = Date.now() - 30 * 24 * 60 * 60 * 1000;

    const threadsNeedingWarning = db.prepare(`
        SELECT * FROM thread_tracking 
        WHERE created_at <= ? 
        AND stale_warning_sent = 0
        AND (last_renewed_at IS NULL OR last_renewed_at <= ?)
    `).all(warningThreshold, warningThreshold);

    console.log(`⚠️  ${threadsNeedingWarning.length} threads need stale warnings`);

    await processInChunks(threadsNeedingWarning, async (tracked) => {
        const settings = getSettings(tracked.guild_id);
        if (!settings) return;

        const thread = await client.channels.fetch(tracked.thread_id).catch(() => null);
        if (!thread || thread.locked || thread.archived) return;
        if (thread.appliedTags.includes(settings.resolved_tag)) {
            db.prepare("DELETE FROM thread_tracking WHERE thread_id = ?").run(tracked.thread_id);
            return;
        }

        const warningEmbed = new EmbedBuilder()
            .setTitle("⚠️ Thread Inactivity Warning")
            .setDescription(
                `Hey <@${thread.ownerId}>! This thread has been inactive for **24 days** and will be automatically closed in **6 hours**.\n\n` +
                `**To keep this thread open:**\n• Reply to this thread, OR\n• Use \`/cancel\` to renew it\n\n` +
                `If you no longer need help, you can safely ignore this.`
            )
            .setColor(0xf59e0b)
            .setTimestamp()
            .setFooter({ text: "Impulse Bot • Stale Thread Warning" });

        await thread.send({ content: `<@${thread.ownerId}>`, embeds: [warningEmbed] });
        db.prepare("UPDATE thread_tracking SET stale_warning_sent = 1 WHERE thread_id = ?").run(tracked.thread_id);
        logAction(tracked.guild_id, "STALE_WARNING", `Sent stale warning for: ${thread.name}`);
        console.log(`⚠️  Warned: ${thread.name}`);
    }, 5, 1500);

    const threadsToClose = db.prepare(`
        SELECT * FROM thread_tracking 
        WHERE created_at <= ?
        AND stale_warning_sent = 1
        AND (last_renewed_at IS NULL OR last_renewed_at <= ?)
    `).all(closeThreshold, closeThreshold);

    console.log(`🔒 ${threadsToClose.length} threads queued for auto-close`);

    await processInChunks(threadsToClose, async (tracked) => {
        const settings = getSettings(tracked.guild_id);
        if (!settings) return;

        const thread = await client.channels.fetch(tracked.thread_id).catch(() => null);
        if (!thread || thread.locked || thread.archived) {
            db.prepare("DELETE FROM thread_tracking WHERE thread_id = ?").run(tracked.thread_id);
            return;
        }
        if (thread.appliedTags.includes(settings.resolved_tag)) {
            db.prepare("DELETE FROM thread_tracking WHERE thread_id = ?").run(tracked.thread_id);
            return;
        }

        await thread.setLocked(true);
        const autoCloseEmbed = new EmbedBuilder()
            .setTitle("🔒 Thread Auto-Closed")
            .setDescription("This thread has been automatically closed due to 30+ days of inactivity. If you still need help, please create a new thread.")
            .setColor(0x6b7280)
            .setTimestamp()
            .setFooter({ text: "Impulse Bot • Auto-Close" });

        await thread.send({ embeds: [autoCloseEmbed] });
        logAction(tracked.guild_id, "AUTO_CLOSE", `Auto-closed stale thread: ${thread.name}`);
        db.prepare("DELETE FROM thread_tracking WHERE thread_id = ?").run(tracked.thread_id);
        console.log(`🔒 Closed: ${thread.name}`);
    }, 3, 2000);

    console.log("✅ Stale thread check complete!");
}

client.on("threadCreate", async (thread) => {
  const settings = getSettings(thread.guildId);
  if (!settings || thread.parentId !== settings.forum_id) return;

  db.prepare(
    "INSERT OR REPLACE INTO thread_tracking (thread_id, guild_id, created_at) VALUES (?, ?, ?)"
  ).run(thread.id, thread.guildId, Date.now());

  if (settings.unanswered_tag) {
    try {
      const currentTags = thread.appliedTags || [];
      if (!currentTags.includes(settings.unanswered_tag)) {
        await thread.setAppliedTags([...currentTags, settings.unanswered_tag]);
      }
    } catch (e) {
      console.error("Error applying unanswered tag:", e);
    }
  }

  const welcomeEmbed = new EmbedBuilder()
    .setTitle("Welcome to the Command Help Thread!")
    .setDescription(
      `Hey <@${thread.ownerId}>!\n\n` +
        `**What happens next?**\n` +
        `• A command helper will help you soon!\n` +
        `• Use \`/resolved\` when your issue is fixed\n` +
        `• The thread will auto-lock 30 minutes after being marked resolved\n\n` +
        `*Please provide as much detail as possible about your issue!*`
    )
    .setColor(IMPULSE_COLOR)
    .setTimestamp()
    .setFooter({ text: "Impulse Bot • Automated Greeting" });

  await thread.send({ embeds: [welcomeEmbed] });

  logAction(
    thread.guildId,
    "GREET",
    `Welcomed user in ${thread.name}`,
    null,
    null,
    null,
    null,
    thread.id,
    null
  );
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.channel.isThread()) return;

  const settings = getSettings(message.guildId);

  if (!settings || !settings.unanswered_tag) return;
  if (message.channel.parentId !== settings.forum_id) return;

  try {
    const currentTags = message.channel.appliedTags;

    // Only remove unanswered tag if:
    // 1. The thread has the unanswered tag
    // 2. The message is NOT from the thread owner (OP)
    if (
      currentTags.includes(settings.unanswered_tag) &&
      message.author.id !== message.channel.ownerId
    ) {
      const newTags = currentTags.filter(
        (tag) => tag !== settings.unanswered_tag
      );
      await message.channel.setAppliedTags(newTags);
      logAction(
        message.guildId,
        "ANSWERED",
        `Removed unanswered tag from: ${message.channel.name}`
      );
    }
  } catch (e) {
    console.error("Error removing unanswered tag:", e);
  }

  // Reset stale warning if thread owner replies
  if (message.author.id === message.channel.ownerId) {
    db.prepare(
      "UPDATE thread_tracking SET stale_warning_sent = 0, last_renewed_at = ? WHERE thread_id = ?"
    ).run(Date.now(), message.channel.id);
  }
});

// Thread Chain add Link reaction handler
client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;

  if (reaction.partial) await reaction.fetch().catch(() => null);
  if (user.partial) await user.fetch().catch(() => null);

  if (reaction.emoji.name !== "🔗") return;
  if (!reaction.message.channel.isThread()) return;

  const starterMessage = await reaction.message.channel
    .fetchStarterMessage()
    .catch(() => null);
  if (!starterMessage || starterMessage.id !== reaction.message.id) return;

  // Check if this thread has a link
  const threadLink = db
    .prepare("SELECT * FROM thread_links WHERE thread_id = ?")
    .get(reaction.message.channel.id);

  if (!threadLink) return;

  // ONLY remove the reaction if we are actually processing a link delivery
  try {
    await reaction.users.remove(user.id);
  } catch (e) {
    console.warn("Missing 'Manage Messages' permission to remove reaction.");
  }
  // Send DM to user
  try {
    const dmEmbed = new EmbedBuilder()
      .setTitle("🔗 Thread Link")
      .setDescription(
        `You've requested the link from the thread: **${reaction.message.channel.name}**\n\n` +
          `**Link:** ${threadLink.url}\n\n` +
          `⚠️ **Disclaimer:** Impulse Bot is not responsible for this content. It was provided by <@${threadLink.created_by}>.`
      )
      .setColor(0x3b82f6)
      .setTimestamp()
      .setFooter({ text: "Impulse Bot • Link System" });

    await user.send({ embeds: [dmEmbed] });

    logAction(
      threadLink.guild_id,
      "LINK_ACCESSED",
      `${user.username} accessed link in: ${reaction.message.channel.name}`,
      user.id,
      user.username,
      user.displayAvatarURL(),
      "Reaction: 🔗",
      reaction.message.channel.id,
      null
    );
  } catch (error) {
    console.log(`User ${user.tag} has DMs disabled`);
    // Fallback: Notify the user in the thread
    const channel = reaction.message.channel;
    const msg = await channel.send(
      `<@${user.id}>, I couldn't DM you! Please enable DMs in your privacy settings.`
    );
    setTimeout(() => msg.delete().catch(() => {}), 10000);
  }
});

// Reaction Trigger handler LColor
client.on('messageReactionAdd', async (reaction, user) => {
    if (reaction.partial) await reaction.fetch().catch(() => null);
    
    const { message, emoji } = reaction;
    if (!message.guildId) return;

    const settings = getSettings(message.guildId);
    if (!settings?.fun_features_enabled) return;

    const emojiId = emoji.id || emoji.name; // Works for custom and standard emojis
    const authorId = message.author.id;

    const triggers = db.prepare(`
        SELECT * FROM reaction_triggers 
        WHERE guild_id = ? AND target_user_id = ? AND reaction_id = ? AND enabled = 1
    `).all(message.guildId, authorId, emojiId);

    for (const trigger of triggers) {
        if (reaction.count >= trigger.trigger_count) {
            // Check if we've already replied to THIS message for THIS trigger
            const alreadyTriggered = db.prepare(`SELECT 1 FROM triggered_messages WHERE message_id = ? AND trigger_id = ?`)
                .get(message.id, trigger.id);

            if (!alreadyTriggered) {
                db.prepare(`INSERT INTO triggered_messages (message_id, trigger_id) VALUES (?, ?)`).run(message.id, trigger.id);
                await message.reply(trigger.response_text);
            }
        }
    }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const settings = getSettings(interaction.guildId);

  const userId = interaction.user.id;
  const userName = interaction.user.username;
  const userAvatar = interaction.user.displayAvatarURL();

  // Block/ban/suspend check — skip for admin commands
  const adminCommands = ['setup', 'blockuser', 'unblockuser', 'banuser', 'unbanuser'];
  if (!adminCommands.includes(interaction.commandName)) {
    const blockCheck = isUserBlocked(userId, interaction.guildId);
    if (blockCheck.blocked) {
      return interaction.reply({ content: `🚫 ${blockCheck.reason}`, ephemeral: true });
    }

    // Cooldown check for spammable commands
    const cooldownCommands = { snippet: [15, 3], reactmessage: [30, 2], link: [60, 2], duplicate: [30, 3] };
    if (cooldownCommands[interaction.commandName]) {
      const [secs, max] = cooldownCommands[interaction.commandName];
      const cd = checkCooldown(userId, interaction.guildId, interaction.commandName, secs, max);
      if (cd.limited) {
        if (cd.suspended) {
          logAction(interaction.guildId, "AUTO_SUSPEND", `Auto-suspended for spamming /${interaction.commandName}`, userId, userName, userAvatar, `/${interaction.commandName}`, null, null);
        }
        return interaction.reply({ content: cd.message, ephemeral: true });
      }
    }
  }

  if (interaction.commandName === "setup") {
    if (
      !interaction.member.permissions.has(PermissionFlagsBits.Administrator)
    ) {
      return interaction.reply({
        content: "❌ **Access Denied:** Administrator permissions required.",
        ephemeral: true,
      });
    }

    const forum = interaction.options.getChannel("forum");
    const resTag = interaction.options.getString("resolved_tag");
    const dupTag = interaction.options.getString("duplicate_tag");
    const unansTag = interaction.options.getString("unanswered_tag") || null;
    const rawRoles = interaction.options.getString("helper_roles");
    const cleanRoles = rawRoles.replace(/\s+/g, "");

    db.prepare(
      `INSERT OR REPLACE INTO guild_settings (guild_id, guild_name, forum_id, resolved_tag, duplicate_tag, unanswered_tag, helper_role_id) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      interaction.guildId,
      interaction.guild.name,
      forum.id,
      resTag,
      dupTag,
      unansTag,
      cleanRoles
    );

    logAction(
      interaction.guildId,
      "SETUP",
      `Setup updated with Roles: ${cleanRoles}`,
      userId,
      userName,
      userAvatar,
      "/setup",
      null,
      null
    );

    const setupEmbed = new EmbedBuilder()
      .setTitle("✅ Setup Complete!")
      .addFields(
        { name: "Forum Channel", value: `<#${forum.id}>`, inline: true },
        {
          name: "Helper Roles",
          value: cleanRoles
            .split(",")
            .map((id) => `<@&${id}>`)
            .join(" "),
          inline: true,
        },
        {
          name: "Tags Configured",
          value: `Resolved: \`${resTag}\`\nDuplicate: \`${dupTag}\`${
            unansTag ? `\nUnanswered: \`${unansTag}\`` : ""
          }`,
          inline: false,
        }
      )
      .setColor(IMPULSE_COLOR)
      .setTimestamp()
      .setFooter({ text: "Impulse Bot" });

    return interaction.reply({ embeds: [setupEmbed], ephemeral: true });
  }

  if (interaction.commandName === "info") {
    if (!settings) {
      return interaction.reply({
        content:
          "❌ This server hasn't been configured yet. Use `/setup` first.",
        ephemeral: true,
      });
    }

    const timerCount = db
      .prepare("SELECT COUNT(*) as count FROM pending_locks WHERE guild_id = ?")
      .get(interaction.guildId).count;

    const infoEmbed = new EmbedBuilder()
      .setTitle("Bot Configuration Status")
      .addFields(
        {
          name: "Forum Channel",
          value: `<#${settings.forum_id}>`,
          inline: true,
        },
        {
          name: "Helper Roles",
          value: settings.helper_role_id
            .split(",")
            .map((id) => `<@&${id}>`)
            .join(", "),
          inline: true,
        },
        { name: "Active Timers", value: timerCount.toString(), inline: true },
        {
          name: "Resolved Tag",
          value: `\`${settings.resolved_tag}\``,
          inline: true,
        },
        {
          name: "Duplicate Tag",
          value: `\`${settings.duplicate_tag}\``,
          inline: true,
        }
      )
      .setColor(IMPULSE_COLOR)
      .setTimestamp()
      .setFooter({ text: "Impulse Bot" });

    return interaction.reply({ embeds: [infoEmbed] });
  }

  if (!settings) {
    return interaction.reply({
      content: "❌ Please run `/setup` first.",
      ephemeral: true,
    });
  }

  if (interaction.commandName === "resolved") {
    const lockTime = Date.now() + 30 * 60 * 1000; // Hardcoded 30 mins

    db.prepare(
      "INSERT OR REPLACE INTO pending_locks (thread_id, guild_id, lock_at) VALUES (?, ?, ?)"
    ).run(interaction.channelId, interaction.guildId, lockTime);

    const resolvedEmbed = new EmbedBuilder()
      .setTitle("✅ Thread Marked as Resolved")
      .setDescription(
        `This thread will automatically lock <t:${Math.floor(
          lockTime / 1000
        )}:R>.`
      )
      .setColor(0x10b981)
      .setTimestamp()
      .setFooter({ text: "Impulse Bot • Timer: 30m" });

    const reply = await interaction.reply({
      embeds: [resolvedEmbed],
      fetchReply: true,
    });

    logAction(
      interaction.guildId,
      "RESOLVED",
      `Marked thread for locking (30m): ${interaction.channel.name}`,
      userId,
      userName,
      userAvatar,
      "/resolved",
      interaction.channelId,
      reply.id
    );
  }

  if (interaction.commandName === "cancel") {
    const settings = getSettings(interaction.guildId);
    if (!settings)
      return interaction.reply({
        content: "❌ Not configured.",
        ephemeral: true,
      });

    const existing = db
      .prepare("SELECT * FROM pending_locks WHERE thread_id = ?")
      .get(interaction.channelId);

    if (existing) {
      db.prepare("DELETE FROM pending_locks WHERE thread_id = ?").run(
        interaction.channelId
      );

      const reply = await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("🔓 Lock Timer Cancelled")
            .setDescription("The automatic lock has been cancelled.")
            .setColor(0xf59e0b),
        ],
        fetchReply: true,
      });

      logAction(
        interaction.guildId,
        "CANCEL",
        `Cancelled lock timer: ${interaction.channel.name}`,
        userId,
        userName,
        userAvatar,
        "/cancel",
        interaction.channelId,
        reply.id
      );
      return; // Exit after handling
    }

    const tracked = db
      .prepare("SELECT * FROM thread_tracking WHERE thread_id = ?")
      .get(interaction.channelId);

    if (tracked && tracked.stale_warning_sent === 1) {
      db.prepare(
        "UPDATE thread_tracking SET stale_warning_sent = 0, last_renewed_at = ? WHERE thread_id = ?"
      ).run(Date.now(), interaction.channelId);

      const reply = await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("♻️ Thread Renewed")
            .setDescription("The 30-day inactivity timer has been reset.")
            .setColor(0x10b981),
        ],
        fetchReply: true,
      });

      logAction(
        interaction.guildId,
        "THREAD_RENEWED",
        `Thread renewed: ${interaction.channel.name}`,
        userId,
        userName,
        userAvatar,
        "/cancel",
        interaction.channelId,
        reply.id
      );
    } else {
      return interaction.reply({
        content:
          "❌ There is no pending lock timer or stale warning for this thread.",
        ephemeral: true,
      });
    }
  }

  if (interaction.commandName === "duplicate") {
    const isAdmin = interaction.member.permissions.has(
      PermissionFlagsBits.Administrator
    );
    const isHelper = hasHelperRole(interaction.member, settings);

    if (!isAdmin && !isHelper) {
      return interaction.reply({
        content: "❌ **Access Denied**",
        ephemeral: true,
      });
    }

    const link = interaction.options.getString("link");

    try {
      const currentTags = interaction.channel.appliedTags || [];
      const newTags = [
        ...currentTags.filter((t) => t !== settings.unanswered_tag),
        settings.duplicate_tag,
      ];
      await interaction.channel.setAppliedTags(newTags);

      const duplicateEmbed = new EmbedBuilder()
        .setTitle("🔄 Thread Closed: Duplicate")
        .setDescription(`Original Thread: ${link}`)
        .setColor(0x0ea5e9);

      const reply = await interaction.reply({
        embeds: [duplicateEmbed],
        fetchReply: true,
      });
      await interaction.channel.setLocked(true);

      logAction(
        interaction.guildId,
        "DUPLICATE",
        `Closed duplicate: ${interaction.channel.name}`,
        userId,
        userName,
        userAvatar,
        `/duplicate link:${link}`,
        interaction.channelId,
        reply.id
      );
    } catch (e) {
      console.error(e);
      if (!interaction.replied)
        await interaction.reply({
          content: "⚠️ Permission error.",
          ephemeral: true,
        });
    }
  }

  if (interaction.commandName === "snippet") {
    const userId = interaction.user.id;
    const userName = interaction.user.username;
    const userAvatar = `https://cdn.discordapp.com/avatars/${userId}/${interaction.user.avatar}.png`;

    const name = interaction.options.getString("name");
    const snippet = db
      .prepare(
        `SELECT * FROM snippets WHERE guild_id = ? AND name = ? AND enabled = 1`
      )
      .get(interaction.guildId, name.toLowerCase());

    if (!snippet) {
      return interaction.reply({
        content:
          "❌ We couldn't find the snippet you're looking for. It may have been deleted.",
        ephemeral: true,
      });
    }

    try {
      const embed = new EmbedBuilder()
        .setTitle(parseVars(snippet.title, interaction))
        .setURL(snippet.url || null)
        .setDescription(parseVars(snippet.description, interaction))
        .setColor(snippet.color || "#FFAA00")
        .setTimestamp();

      if (snippet.image_url && snippet.image_url.startsWith("http"))
        embed.setImage(snippet.image_url);
      if (snippet.thumbnail_url && snippet.thumbnail_url.startsWith("http"))
        embed.setThumbnail(snippet.thumbnail_url);
      if (snippet.footer)
        embed.setFooter({ text: parseVars(snippet.footer, interaction) });

      // Parse Fields
      try {
        const fields = JSON.parse(snippet.fields || "[]");
        if (fields.length > 0) {
          embed.addFields(
            fields.map((f) => ({
              name: parseVars(f.name, interaction),
              value: parseVars(f.value, interaction),
              inline: f.inline,
            }))
          );
        }
      } catch (e) {
        /* silent fail on fields */
      }

      logAction(
        interaction.guildId,
        "SNIPPET",
        `Used snippet: ${name}`,
        userId,
        userName,
        userAvatar,
        `/snippet name:${name}`,
        interaction.channelId,
        null
      );

      return interaction.reply({ embeds: [embed] });
    } catch (error) {
      console.error("Snippet Command Error:", error);
      return interaction.reply({
        content: "❌ There was an error rendering this snippet.",
        ephemeral: true,
      });
    }
  }

  if (interaction.commandName === "link") {
    if (!interaction.channel.isThread()) {
      return interaction.reply({
        content: "❌ This command can only be used in threads.",
        ephemeral: true,
      });
    }

    if (interaction.user.id !== interaction.channel.ownerId) {
      return interaction.reply({
        content: "❌ Only the thread owner can add links to their thread.",
        ephemeral: true,
      });
    }

    const url = interaction.options.getString("url");

    try {
      new URL(url);
    } catch (e) {
      return interaction.reply({
        content:
          "❌ Invalid URL format. Please provide a valid URL (e.g., https://example.com)",
        ephemeral: true,
      });
    }

    const existing = db
      .prepare("SELECT * FROM thread_links WHERE thread_id = ?")
      .get(interaction.channelId);

    if (existing) {
      return interaction.reply({
        content:
          "❌ This thread already has a link attached. Use `/removelink` to remove it first.",
        ephemeral: true,
      });
    }

    // Save to database
    db.prepare(
      `INSERT OR REPLACE INTO thread_links (thread_id, guild_id, url, created_by, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(
      interaction.channelId,
      interaction.guildId,
      url,
      interaction.user.id,
      Date.now()
    );

    // Send embed message
    const linkEmbed = new EmbedBuilder()
      .setTitle("🔗 Link Attached to Thread")
      .setDescription(
        `A link has been attached to this thread by <@${interaction.user.id}>.\n\n` +
          `**React with 🔗 on the thread's starter message to receive the link via DM.**\n\n` +
          `⚠️ **Warning:** The bot is not responsible for where this link leads. ` +
          `Only click if you trust the thread owner.\n\n` +
          `*Moderators can use \`/removelink\` to remove this link.*`
      )
      .setColor(0x3b82f6)
      .setTimestamp()
      .setFooter({ text: "Impulse Bot • Link System" });

    await interaction.reply({ embeds: [linkEmbed] });

    try {
      const starterMessage = await interaction.channel.fetchStarterMessage();
      if (starterMessage) {
        await starterMessage.react("🔗");
      }
    } catch (error) {
      console.error("Error reacting to starter message:", error);
      await interaction.followUp({
        content:
          "⚠️ Link added but could not add reaction to thread starter message.",
        ephemeral: true,
      });
    }

    logAction(
      interaction.guildId,
      "LINK_ADDED",
      `Link added to thread: ${interaction.channel.name}`,
      interaction.user.id,
      interaction.user.username,
      interaction.user.displayAvatarURL(),
      `/link url:${url}`,
      interaction.channelId,
      null
    );
  }

  if (interaction.commandName === "removelink") {
    const settings = getSettings(interaction.guildId);
    if (!settings)
      return interaction.reply({
        content: "❌ Not configured.",
        ephemeral: true,
      });
    if (!interaction.channel.isThread())
      return interaction.reply({
        content: "❌ Threads only.",
        ephemeral: true,
      });

    const isOwner = interaction.user.id === interaction.channel.ownerId;
    const isAdmin = interaction.member.permissions.has(
      PermissionFlagsBits.Administrator
    );
    const isHelper = hasHelperRole(interaction.member, settings);

    if (!isOwner && !isAdmin && !isHelper) {
      return interaction.reply({
        content:
          "❌ You don't have permission. Only the thread owner or staff can remove links.",
        ephemeral: true,
      });
    }

    const link = db
      .prepare("SELECT * FROM thread_links WHERE thread_id = ?")
      .get(interaction.channelId);
    if (!link)
      return interaction.reply({
        content: "❌ No link attached to this thread.",
        ephemeral: true,
      });

    db.prepare("DELETE FROM thread_links WHERE thread_id = ?").run(
      interaction.channelId
    );

    // Remove the system reaction from the starter message
    try {
      const starterMessage = await interaction.channel.fetchStarterMessage();
      const reaction = starterMessage.reactions.cache.get("🔗");
      if (reaction) await reaction.remove();
    } catch (e) {
      /* ignore cleanup errors */
    }

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🔗 Link Removed")
          .setDescription(
            `The link has been removed by ${
              isOwner ? "the thread owner" : "staff"
            }.`
          )
          .setColor(0xef4444),
      ],
    });
  }

  if (interaction.commandName === 'reactmessage') {
      const targetUser = interaction.options.getUser('user');
      const count = interaction.options.getInteger('count');
      const reaction = interaction.options.getString('reaction');
      const text = interaction.options.getString('message');

      db.prepare(`INSERT INTO reaction_triggers (guild_id, target_user_id, reaction_id, trigger_count, response_text) VALUES (?, ?, ?, ?, ?)`).run(
          interaction.guildId, targetUser.id, reaction, count, text
      );

      logAction(
        interaction.guildId,
        "TRIGGER_CREATE",
        `Reaction trigger set for ${targetUser.username}: ${count}x ${reaction} → "${text}"`,
        interaction.user.id,
        interaction.user.username,
        interaction.user.displayAvatarURL(),
        `/reactmessage`,
        null,
        null
    );
    return interaction.reply({ content: `✅ Trigger set! When **${targetUser.username}**'s message gets ${count}x ${reaction}, I'll reply: "${text}"`, ephemeral: true });
  }

  if (interaction.commandName === 'blockuser') {
    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || null;
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
    const isHelper = hasHelperRole(interaction.member, settings);
    if (!isAdmin && !isHelper) return interaction.reply({ content: '❌ Access Denied.', ephemeral: true });

    db.prepare("INSERT OR REPLACE INTO blocked_users (guild_id, user_id, reason, blocked_by, blocked_at) VALUES (?, ?, ?, ?, ?)").run(
        interaction.guildId, target.id, reason, userId, Date.now()
    );
    logAction(interaction.guildId, "USER_BLOCKED", `${target.username} blocked${reason ? `: ${reason}` : ''}`, userId, userName, userAvatar, `/blockuser`, null, null);
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('🚫 User Blocked').setDescription(`**${target.username}** has been blocked from using bot commands in this server.${reason ? `\n**Reason:** ${reason}` : ''}`).setColor(0xef4444).setTimestamp()], ephemeral: true });
  }

  if (interaction.commandName === 'unblockuser') {
    const target = interaction.options.getUser('user');
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
    const isHelper = hasHelperRole(interaction.member, settings);
    if (!isAdmin && !isHelper) return interaction.reply({ content: '❌ Access Denied.', ephemeral: true });

    db.prepare("DELETE FROM blocked_users WHERE guild_id = ? AND user_id = ?").run(interaction.guildId, target.id);
    db.prepare("DELETE FROM suspended_users WHERE guild_id = ? AND user_id = ?").run(interaction.guildId, target.id);
    logAction(interaction.guildId, "USER_UNBLOCKED", `${target.username} unblocked`, userId, userName, userAvatar, `/unblockuser`, null, null);
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('✅ User Unblocked').setDescription(`**${target.username}** can now use bot commands again.`).setColor(0x10b981).setTimestamp()], ephemeral: true });
  }

  if (interaction.commandName === 'banuser') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: '❌ Administrator only.', ephemeral: true });
    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || null;

    db.prepare("INSERT OR REPLACE INTO banned_users (user_id, reason, banned_by, banned_at) VALUES (?, ?, ?, ?)").run(target.id, reason, userId, Date.now());
    logAction(interaction.guildId, "USER_BANNED", `${target.username} globally banned${reason ? `: ${reason}` : ''}`, userId, userName, userAvatar, `/banuser`, null, null);
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('🔨 User Globally Banned').setDescription(`**${target.username}** is banned from using this bot in all servers.${reason ? `\n**Reason:** ${reason}` : ''}`).setColor(0x7f1d1d).setTimestamp()], ephemeral: true });
  }

  if (interaction.commandName === 'unbanuser') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: '❌ Administrator only.', ephemeral: true });
    const target = interaction.options.getUser('user');

    db.prepare("DELETE FROM banned_users WHERE user_id = ?").run(target.id);
    logAction(interaction.guildId, "USER_UNBANNED", `${target.username} globally unbanned`, userId, userName, userAvatar, `/unbanuser`, null, null);
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('✅ User Unbanned').setDescription(`**${target.username}** can now use this bot again.`).setColor(0x10b981).setTimestamp()], ephemeral: true });
  }

  if (interaction.commandName === 'closethreads') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '❌ Administrator only.', ephemeral: true });
    }
    if (!settings) {
        return interaction.reply({ content: '❌ Run `/setup` first.', ephemeral: true });
    }

    const days = interaction.options.getInteger('days');
    const sendWarn = interaction.options.getBoolean('warn') ?? false;
    const dryRun = interaction.options.getBoolean('dry_run') ?? false;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    try {
        const forumChannel = await client.channels.fetch(settings.forum_id).catch(() => null);
        if (!forumChannel) return interaction.reply({ content: '❌ Could not fetch the configured forum channel. Has `/setup` been run?', ephemeral: true });

        await interaction.deferReply({ ephemeral: true });
        if (!forumChannel) {
            return interaction.editReply('❌ Could not fetch the configured forum channel.');
        }

        // Fetch all active threads from Discord directly
        const fetchedThreads = await forumChannel.threads.fetchActive();
        const candidates = [];

        for (const [, thread] of fetchedThreads.threads) {
            if (!thread.createdTimestamp || thread.createdTimestamp > cutoff) continue;
            if (thread.locked || thread.archived) continue;
            if (thread.appliedTags.includes(settings.resolved_tag)) continue;
            candidates.push(thread);
        }

        if (dryRun) {
            const embed = new EmbedBuilder()
                .setTitle('🔍 Dry Run — Bulk Close Preview')
                .setDescription(
                    `**${candidates.length}** threads would be closed.\n\n` +
                    `**Parameters:**\n` +
                    `• Older than: **${days} days**\n` +
                    `• Send warning message: **${sendWarn ? 'Yes' : 'No'}**\n\n` +
                    `Run the command again without \`dry_run\` to execute.`
                )
                .setColor(0x3b82f6)
                .setTimestamp()
                .setFooter({ text: 'Impulse Bot • Dry Run' });

            if (candidates.length > 0 && candidates.length <= 20) {
                embed.addFields({
                    name: 'Affected Threads',
                    value: candidates.map(t => `• ${t.name}`).join('\n')
                });
            } else if (candidates.length > 20) {
                embed.addFields({
                    name: 'Sample (first 20)',
                    value: candidates.slice(0, 20).map(t => `• ${t.name}`).join('\n')
                });
            }

            return interaction.editReply({ embeds: [embed] });
        }

        if (candidates.length === 0) {
            return interaction.editReply(`✅ No threads found older than **${days} days**. Nothing to close.`);
        }

        // Acknowledge immediately so the interaction doesn't time out
        await interaction.editReply(
            `⏳ Processing **${candidates.length}** threads in chunks. This may take a while — you'll get a follow-up when done.`
        );

        let closed = 0, warned = 0, failed = 0;

        await processInChunks(candidates, async (thread) => {
            try {
                if (sendWarn) {
                    const warnEmbed = new EmbedBuilder()
                        .setTitle('⚠️ Thread Being Closed by Staff')
                        .setDescription(
                            `Hey <@${thread.ownerId}>! This thread is being closed by a moderator as part of a bulk cleanup of threads older than **${days} days**.\n\n` +
                            `If you still need help, please create a new thread.`
                        )
                        .setColor(0xf59e0b)
                        .setTimestamp()
                        .setFooter({ text: 'Impulse Bot • Staff Bulk Close' });

                    await thread.send({ content: `<@${thread.ownerId}>`, embeds: [warnEmbed] });
                    warned++;
                    await sleep(500); // small extra delay after warning before locking
                }

                await thread.setLocked(true);

                const closeEmbed = new EmbedBuilder()
                    .setTitle('🔒 Thread Closed')
                    .setDescription(
                        sendWarn
                            ? 'This thread has been closed as part of a staff cleanup. Create a new thread if you still need help.'
                            : `This thread has been closed by staff — it was older than **${days} days** with no activity.`
                    )
                    .setColor(0x6b7280)
                    .setTimestamp()
                    .setFooter({ text: `Impulse Bot • Bulk Close by ${interaction.user.username}` });

                await thread.send({ embeds: [closeEmbed] });

                // Remove from tracking if present
                db.prepare("DELETE FROM thread_tracking WHERE thread_id = ?").run(thread.id);
                logAction(
                    interaction.guildId, "BULK_CLOSE",
                    `Bulk closed: ${thread.name} (${days}d cutoff)`,
                    userId, userName, userAvatar,
                    `/closethreads days:${days} warn:${sendWarn}`,
                    thread.id, null
                );
                closed++;
            } catch (e) {
                console.error(`Failed to close thread ${thread.name}:`, e.message);
                failed++;
            }
        }, 3, 2000); // 3 at a time, 2s between chunks

        const resultEmbed = new EmbedBuilder()
            .setTitle('✅ Bulk Close Complete')
            .addFields(
                { name: 'Closed', value: closed.toString(), inline: true },
                { name: sendWarn ? 'Warned' : 'Silent', value: (sendWarn ? warned : closed).toString(), inline: true },
                { name: 'Failed', value: failed.toString(), inline: true },
                { name: 'Cutoff', value: `${days} days`, inline: true },
            )
            .setColor(failed > 0 ? 0xf59e0b : 0x10b981)
            .setTimestamp()
            .setFooter({ text: `Impulse Bot • Executed by ${interaction.user.username}` });

        await interaction.followUp({ embeds: [resultEmbed], ephemeral: true });

    } catch (err) {
        console.error('closethreads error:', err);
        await interaction.editReply('❌ An error occurred during bulk close. Check the logs.');
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
