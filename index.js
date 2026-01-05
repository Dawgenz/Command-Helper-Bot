require('dotenv').config();
const { Client, GatewayIntentBits, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const Database = require('better-sqlite3');
const express = require('express');
const passport = require('passport');
const { Strategy } = require('passport-discord');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

const db = new Database('database.db');
const app = express();
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});
db.prepare(`CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    guild_name TEXT,
    forum_id TEXT,
    resolved_tag TEXT,
    duplicate_tag TEXT,
    helper_role_id TEXT
)`).run();
db.prepare('CREATE TABLE IF NOT EXISTS pending_locks (thread_id TEXT PRIMARY KEY, guild_id TEXT, lock_at INTEGER)').run();
db.prepare(`CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, 
    guild_id TEXT, 
    action TEXT, 
    details TEXT, 
    user_id TEXT,
    user_name TEXT,
    user_avatar TEXT,
    command_used TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`).run();
db.prepare(`
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
`).run();

// --- HELPERS ---
const getSettings = (guildId) => db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId);
const getNav = (active) => `
<nav class="flex gap-4 text-[10px] font-black uppercase tracking-widest mb-8">
    <a href="/" class="${active === 'home' ? 'text-[#FFAA00]' : 'text-slate-500 hover:text-white'}">Overview</a>
    <a href="/threads" class="${active === 'threads' ? 'text-[#FFAA00]' : 'text-slate-500 hover:text-white'}">Threads</a>
    <a href="/snippets" class="${active === 'snippets' ? 'text-[#FFAA00]' : 'text-slate-500 hover:text-white'}">Snippets</a>
    <a href="/logs" class="${active === 'logs' ? 'text-[#FFAA00]' : 'text-slate-500 hover:text-white'}">Logs</a>
</nav>
`;
const logAction = (guildId, action, details, userId = null, userName = null, userAvatar = null, command = null) => {
    db.prepare('INSERT INTO audit_logs (guild_id, action, details, user_id, user_name, user_avatar, command_used) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        guildId, 
        action, 
        details, 
        userId, 
        userName, 
        userAvatar, 
        command
    );
};

function hasHelperRole(member, settings) {
    if (!settings.helper_role_id) return false;
    const roleIDs = settings.helper_role_id.split(',').map(id => id.trim());
    return member.roles.cache.some(role => roleIDs.includes(role.id));
}

// --- PASSPORT / OAUTH2 CONFIG ---
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new Strategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.REDIRECT_URI,
    scope: ['identify', 'guilds', 'guilds.members.read']
}, (accessToken, refreshToken, profile, done) => {
    process.nextTick(() => done(null, profile));
}));

app.use(session({
    store: new SQLiteStore({ db: 'database.db', table: 'sessions', dir: './' }),
    secret: process.env.SESSION_SECRET || 'keyboard cat',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());

// --- ROUTES ---
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
});

// HELPER: Shared Header/Favicon HTML
const getHead = (title) => `
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"> 
        <title>${title}</title>
        <link rel="icon" type="image/png" href="${client.user.displayAvatarURL()}">
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

function canManageSnippet(req, snippet) {
    const guild = client.guilds.cache.get(snippet.guild_id);
    if (!guild) return false;

    const member = guild.members.cache.get(req.user.id);
    if (!member) return false;

    return (
        member.permissions.has(PermissionFlagsBits.Administrator) ||
        hasHelperRole(member, getSettings(snippet.guild_id))
    );
}

const getActionColor = (action) => {
    const colors = {
        'SETUP': 'bg-amber-500/10 text-amber-500 border-amber-500/20',
        'DUPLICATE': 'bg-sky-500/10 text-sky-500 border-sky-500/20',
        'RESOLVED': 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
        'LOCK': 'bg-rose-500/10 text-rose-500 border-rose-500/20',
        'GREET': 'bg-slate-500/10 text-slate-400 border-slate-500/20',
        'CANCEL': 'bg-orange-500/10 text-orange-500 border-orange-500/20',
        'ANSWERED': 'bg-green-500/10 text-green-500 border-green-500/20',
        'AUTO_CLOSE': 'bg-gray-500/10 text-gray-500 border-gray-500/20'
    };
    return colors[action] || 'bg-slate-800 text-slate-400 border-slate-700';
};

app.get('/', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.send(`
        <html>
        ${getHead('Impulse | Terminal Access')}
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
    const userAvatar = `https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png`;
    const allSettings = db.prepare(`SELECT * FROM guild_settings`).all();
    const authorizedGuilds = [];

    for (const settings of allSettings) {
        const guild = client.guilds.cache.get(settings.guild_id);
        if (!guild) continue;
        try {
            const member = await guild.members.fetch(req.user.id);
            if (member.permissions.has(PermissionFlagsBits.Administrator) || hasHelperRole(member, settings)) {
                const timers = db.prepare('SELECT thread_id, lock_at FROM pending_locks WHERE guild_id = ?').all(settings.guild_id);
                authorizedGuilds.push({ ...settings, timers });
            }
        } catch (e) {}
    }

    const logs = db.prepare(`
        SELECT audit_logs.*, guild_settings.guild_name 
        FROM audit_logs 
        LEFT JOIN guild_settings ON audit_logs.guild_id = guild_settings.guild_id 
        ORDER BY timestamp DESC LIMIT 10
    `).all();

    res.send(`
    <html>
    ${getHead('Impulse | Bot Dashboard')}
    <body class="bg-[#0b0f1a] text-slate-200 min-h-screen p-4 md:p-8">
        <div class="max-w-6xl mx-auto">
            <header class="flex flex-col md:flex-row justify-between items-center mb-10 gap-6">
                <div class="flex items-center gap-4">
                    <img src="${botAvatar}" class="w-12 h-12 md:w-14 md:h-14 rounded-full border-2 border-[#FFAA00] shadow-[0_0_15px_rgba(255,170,0,0.4)]">
                    <div>
                        <h1 class="text-2xl md:text-3xl font-extrabold text-white tracking-tighter leading-none">IMPULSE</h1>
                        <span class="text-[#FFAA00] text-[10px] md:text-xs font-mono tracking-[0.3em] uppercase">Bot Dashboard</span>
                    </div>
                </div>
                <div class="flex items-center gap-3">
                    <a href="/invite" class="w-10 h-10 md:w-11 md:h-11 rounded-full bg-slate-900/80 border-2 border-[#FFAA00]/30 hover:border-[#FFAA00] hover:bg-slate-800 transition flex items-center justify-center group" title="Add Bot">
                        <svg class="w-5 h-5 text-[#FFAA00] group-hover:scale-110 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
                        </svg>
                    </a>
                    <div class="flex items-center gap-3 bg-slate-900/80 p-2 pr-5 rounded-full border border-slate-800">
                        <img src="${userAvatar}" class="w-8 h-8 md:w-10 md:h-10 rounded-full border border-[#FFAA00]/50">
                        <div class="flex flex-col">
                            <span class="text-xs md:text-sm font-bold text-white leading-none">${req.user.username}</span>
                            <a href="/logout" class="text-[9px] text-rose-500 hover:underline uppercase font-bold tracking-widest mt-1">Disconnect</a>
                        </div>
                    </div>
                </div>
            </header>

            ${getNav('home')}

            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-10">
                ${authorizedGuilds.map(s => `
                    <div class="bg-slate-900/40 backdrop-blur-md p-6 rounded-2xl border border-slate-800/50 hover:border-[#FFAA00]/30 transition shadow-lg">
                        <h3 class="text-[#FFAA00] uppercase text-[10px] font-black mb-4 tracking-widest opacity-80 truncate">${s.guild_name}</h3>
                        <div class="space-y-2">
                            ${s.timers.length > 0 ? s.timers.map(t => `
                                <div class="flex justify-between items-center bg-black/40 p-3 rounded-lg border border-slate-800/50">
                                    <span class="text-[10px] mono text-slate-500">ID:${t.thread_id.slice(-5)}</span>
                                    <span class="text-xs font-bold text-emerald-400 mono" data-expire="${t.lock_at}">--:--</span>
                                </div>
                            `).join('') : '<div class="text-slate-600 text-xs py-2 italic text-center">No active lockdown timers</div>'}
                        </div>
                    </div>`).join('')}
            </div>

            <div class="bg-slate-900/40 rounded-2xl border border-slate-800 overflow-hidden shadow-2xl">
                <div class="p-6 border-b border-slate-800 flex justify-between items-center bg-slate-900/20">
                    <h2 class="text-md md:text-lg font-bold text-white flex items-center gap-2 uppercase tracking-tight">
                        <span class="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
                        Live Feed
                    </h2>
                    <a href="/logs" class="text-[#FFAA00] text-[9px] font-black tracking-widest hover:bg-[#FFAA00] hover:text-black transition px-4 py-2 rounded-lg border border-[#FFAA00]/20 uppercase">Audit Log</a>
                </div>
                <div class="divide-y divide-slate-800/40">
                    ${logs.map(l => {
                        return `
                        <div class="p-4 hover:bg-[#FFAA00]/5 transition flex items-center gap-4">
                            <div class="hidden md:block text-[10px] mono text-slate-600 w-20 text-right shrink-0" data-timestamp="${l.timestamp}">
                                --:--:--
                            </div>
                            <div class="w-20 flex items-center justify-center shrink-0">
                                <span class="px-2 py-0.5 rounded text-[8px] font-black mono ${getActionColor(l.action)} inline-block text-center min-w-[70px]">
                                    ${l.action}
                                </span>
                            </div>
                            <div class="flex-1 min-w-0">
                                <p class="text-xs text-slate-300 truncate font-medium">${l.details}</p>
                            </div>
                            <div class="text-[9px] font-black text-slate-600 uppercase tracking-widest shrink-0 w-24 text-right">
                                ${l.guild_name || 'System'}
                            </div>
                        </div>
                    `}).join('')}
                </div>
            </div>

            <!-- INFO FOOTER -->
            <footer class="mt-12 pt-8 border-t border-slate-800/50">
                <div class="max-w-3xl mx-auto text-center space-y-4">
                    <div class="flex items-center justify-center gap-3 mb-4">
                        <img src="${botAvatar}" class="w-8 h-8 rounded-full border border-[#FFAA00]/30">
                        <h3 class="text-sm font-black text-[#FFAA00] uppercase tracking-widest">Impulse Dashboard</h3>
                    </div>
                    
                    <div class="bg-slate-900/40 border border-slate-800 rounded-xl p-6 backdrop-blur-sm">
                        <p class="text-xs text-slate-400 leading-relaxed mb-3">
                            <span class="text-[#FFAA00] font-bold">Privacy Notice:</span> This dashboard does not store, collect, or use any personal user data. 
                            It only accesses Discord OAuth2 to verify your server membership and display relevant information from servers where the bot is installed.
                        </p>
                        <p class="text-[10px] text-slate-500 italic">
                            All data is pulled in real-time and nothing is cached or saved beyond your active session.
                        </p>
                    </div>

                    <div class="flex items-center justify-center gap-6 text-[9px] text-slate-600 uppercase tracking-wider font-bold">
                        <span>Built for Gups Command Central</span>
                        <span class="text-slate-800">•</span>
                        <span>Powered by Discord.js</span>
                    </div>
                </div>
            </footer>
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
            
            // Update timestamps to user's local timezone
            function updateTimestamps() {
                document.querySelectorAll('[data-timestamp]').forEach(el => {
                    const timestamp = el.getAttribute('data-timestamp');
                    const date = new Date(timestamp + 'Z'); // Ensure UTC
                    const timeStr = date.toLocaleTimeString('en-US', {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: false
                    }).replace(',', '');
                    el.innerText = timeStr;
                });
            }
            
            setInterval(updateTimers, 1000); 
            updateTimers();
            updateTimestamps();
        </script>
    </body></html>`);
});

app.get('/logs', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/auth/discord');
    
    const allLogs = db.prepare(`
        SELECT audit_logs.*, guild_settings.guild_name 
        FROM audit_logs 
        LEFT JOIN guild_settings ON audit_logs.guild_id = guild_settings.guild_id 
        ORDER BY timestamp DESC LIMIT 100
    `).all();
    
    const uniqueServers = [...new Set(allLogs.map(l => l.guild_name).filter(Boolean))];

    res.send(`
    <html>
    ${getHead('Impulse | Audit Logs')}
    <body class="bg-[#0b0f1a] text-slate-200 p-4 md:p-8">
        <div class="max-w-5xl mx-auto">
            <div class="flex flex-col md:flex-row md:justify-between md:items-end mb-8 gap-4">
                <div>
                    <a href="/" class="text-[#FFAA00] text-[9px] font-black tracking-[0.2em] hover:underline uppercase">← Terminal Hub</a>
                    <h1 class="text-3xl md:text-4xl font-black text-white mt-1 leading-none uppercase italic">Data Archive</h1>
                </div>
                <div class="relative w-full md:w-64">
                    <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>
                    </svg>
                    <input type="text" id="logSearch" placeholder="Search archive..." class="w-full bg-slate-900 border border-slate-700 rounded-lg pl-10 pr-4 py-2 text-sm focus:outline-none focus:border-[#FFAA00] transition">
                </div>
            </div>

            <div class="space-y-6 mb-8">
                <div>
                    <p class="text-[8px] uppercase font-black text-slate-600 mb-2 tracking-[0.2em]">Filter: Action</p>
                    <div class="flex gap-2 overflow-x-auto pb-2 no-scrollbar">
                        <button onclick="filterType('ALL', this)" class="type-btn shrink-0 bg-[#FFAA00] text-black px-4 py-1.5 rounded-full text-[9px] font-black uppercase tracking-tighter">ALL</button>
                        <button onclick="filterType('SETUP', this)" class="type-btn shrink-0 bg-slate-800 text-slate-400 px-4 py-1.5 rounded-full text-[9px] font-black uppercase hover:text-white tracking-tighter">SETUP</button>
                        <button onclick="filterType('LOCK', this)" class="type-btn shrink-0 bg-slate-800 text-slate-400 px-4 py-1.5 rounded-full text-[9px] font-black uppercase hover:text-white tracking-tighter">LOCK</button>
                        <button onclick="filterType('RESOLVED', this)" class="type-btn shrink-0 bg-slate-800 text-slate-400 px-4 py-1.5 rounded-full text-[9px] font-black uppercase hover:text-white tracking-tighter">RESOLVED</button>
                        <button onclick="filterType('DUPLICATE', this)" class="type-btn shrink-0 bg-slate-800 text-slate-400 px-4 py-1.5 rounded-full text-[9px] font-black uppercase hover:text-white tracking-tighter">DUPLICATE</button>
                        <button onclick="filterType('GREET', this)" class="type-btn shrink-0 bg-slate-800 text-slate-400 px-4 py-1.5 rounded-full text-[9px] font-black uppercase hover:text-white tracking-tighter">GREET</button>
                        <button onclick="filterType('CANCEL', this)" class="type-btn shrink-0 bg-slate-800 text-slate-400 px-4 py-1.5 rounded-full text-[9px] font-black uppercase hover:text-white tracking-tighter">CANCEL</button>
                        <button onclick="filterType('ANSWERED', this)" class="type-btn shrink-0 bg-slate-800 text-slate-400 px-4 py-1.5 rounded-full text-[9px] font-black uppercase hover:text-white tracking-tighter">ANSWERED</button>
                        <button onclick="filterType('AUTO_CLOSE', this)" class="type-btn shrink-0 bg-slate-800 text-slate-400 px-4 py-1.5 rounded-full text-[9px] font-black uppercase hover:text-white tracking-tighter">AUTO_CLOSE</button>
                    </div>
                </div>

                <div>
                    <p class="text-[8px] uppercase font-black text-slate-600 mb-2 tracking-[0.2em]">Filter: Server</p>
                    <div class="flex gap-2 overflow-x-auto pb-2 no-scrollbar">
                        <button onclick="filterServer('ALL', this)" class="srv-btn shrink-0 bg-[#FFAA00] text-black px-4 py-1.5 rounded-full text-[9px] font-black uppercase tracking-tighter">ALL SOURCES</button>
                        ${uniqueServers.map(srv => `
                            <button onclick="filterServer('${srv}', this)" class="srv-btn shrink-0 bg-slate-800 text-slate-400 px-4 py-1.5 rounded-full text-[9px] font-black uppercase hover:text-white tracking-tighter">${srv}</button>
                        `).join('')}
                    </div>
                </div>
            </div>

            <div class="bg-slate-900/40 border border-slate-800 rounded-2xl overflow-hidden backdrop-blur-sm shadow-xl">
                <table class="w-full text-left border-collapse">
                    <thead class="bg-black/40 text-[9px] uppercase font-black tracking-widest text-slate-500">
                        <tr>
                            <th class="p-4 border-b border-slate-800 w-32">Origin</th>
                            <th class="p-4 border-b border-slate-800 w-28 text-center">Action</th>
                            <th class="p-4 border-b border-slate-800">Details</th>
                            <th class="p-4 border-b border-slate-800 w-40">Timestamp</th>
                            <th class="p-4 border-b border-slate-800 w-12"></th>
                        </tr>
                    </thead>
                    <tbody id="logTableBody" class="mono text-[11px]">
                        ${allLogs.map((l, idx) => {
                            const date = new Date(l.timestamp + 'Z'); // Ensure UTC
                            const dateStr = date.toLocaleDateString('en-US', { 
                                weekday: 'long',
                                month: 'long', 
                                day: 'numeric',
                                year: 'numeric'
                            });
                            const timeStr = date.toLocaleTimeString('en-US', {
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit',
                                hour12: true
                            });
                            
                            const hasUserInfo = l.user_id && l.user_name;
                            
                            return `
                            <tr class="log-row border-b border-slate-800/40 hover:bg-[#FFAA00]/5 transition" data-action="${l.action}" data-server="${l.guild_name || 'System'}">
                                <td class="p-4 text-slate-500 font-bold uppercase text-[10px]">${l.guild_name || 'System'}</td>
                                <td class="p-4 text-center">
                                    <span class="${getActionColor(l.action)} px-3 py-1 rounded font-black uppercase text-[9px] inline-block min-w-[80px]">
                                        ${l.action}
                                    </span>
                                </td>
                                <td class="p-4 text-slate-300 font-sans">${l.details}</td>
                                <td class="p-4 text-[10px] text-slate-600">
                                    <div class="font-bold">${dateStr}</div>
                                    <div class="text-slate-700 mt-0.5">${timeStr}</div>
                                </td>
                                <td class="p-4">
                                    ${hasUserInfo ? `
                                        <button onclick="toggleExpand(${idx})" class="expand-btn text-slate-500 hover:text-[#FFAA00] transition">
                                            <svg class="w-5 h-5 transition-transform" id="icon-${idx}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                                            </svg>
                                        </button>
                                    ` : ''}
                                </td>
                            </tr>
                            ${hasUserInfo ? `
                            <tr class="expanded-row hidden border-b border-slate-800/40" id="expand-${idx}" data-action="${l.action}" data-server="${l.guild_name || 'System'}">
                                <td colspan="5" class="p-0">
                                    <div class="bg-black/20 p-6 border-t border-slate-800/30">
                                        <div class="flex items-start gap-4">
                                            <img src="${l.user_avatar || 'https://cdn.discordapp.com/embed/avatars/0.png'}" class="w-12 h-12 rounded-full border-2 border-[#FFAA00]/30">
                                            <div class="flex-1">
                                                <div class="flex items-center gap-3 mb-2">
                                                    <span class="text-sm font-bold text-white">${l.user_name || 'Unknown User'}</span>
                                                    <span class="text-[9px] text-slate-600 font-mono">ID: ${l.user_id || 'N/A'}</span>
                                                </div>
                                                <div class="bg-slate-900/40 rounded-lg p-3 border border-slate-800">
                                                    <p class="text-[10px] uppercase text-slate-500 font-black mb-1 tracking-wider">Command Executed</p>
                                                    <code class="text-xs text-[#FFAA00] font-mono">${l.command_used || 'N/A'}</code>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </td>
                            </tr>
                            ` : ''}
                        `}).join('')}
                    </tbody>
                </table>
            </div>
        </div>
        <script>
            let currentType = 'ALL';
            let currentServer = 'ALL';
            const search = document.getElementById('logSearch');
            const rows = document.querySelectorAll('.log-row');

            function toggleExpand(idx) {
                const expandRow = document.getElementById('expand-' + idx);
                const icon = document.getElementById('icon-' + idx);
                
                if (expandRow.classList.contains('hidden')) {
                    expandRow.classList.remove('hidden');
                    icon.style.transform = 'rotate(180deg)';
                } else {
                    expandRow.classList.add('hidden');
                    icon.style.transform = 'rotate(0deg)';
                }
            }

            function applyFilters() {
                const term = search.value.toLowerCase();
                const allRows = document.querySelectorAll('.log-row, .expanded-row');
                
                allRows.forEach(row => {
                    if (row.classList.contains('expanded-row')) {
                        // Handle expanded rows separately - they follow their parent
                        return;
                    }
                    
                    const typeMatch = currentType === 'ALL' || row.getAttribute('data-action') === currentType;
                    const serverMatch = currentServer === 'ALL' || row.getAttribute('data-server') === currentServer;
                    const textMatch = row.innerText.toLowerCase().includes(term);
                    const shouldShow = typeMatch && serverMatch && textMatch;
                    
                    row.style.display = shouldShow ? '' : 'none';
                    
                    // Also hide corresponding expanded row if main row is hidden
                    const rowId = Array.from(document.querySelectorAll('.log-row')).indexOf(row);
                    const expandedRow = document.getElementById('expand-' + rowId);
                    if (expandedRow) {
                        expandedRow.style.display = shouldShow ? '' : 'none';
                    }
                });
            }

            search.addEventListener('keyup', applyFilters);

            function filterType(type, btn) {
                currentType = type;
                document.querySelectorAll('.type-btn').forEach(b => {
                    b.className = "type-btn shrink-0 bg-slate-800 text-slate-400 px-4 py-1.5 rounded-full text-[9px] font-black uppercase hover:text-white tracking-tighter";
                });
                btn.className = "type-btn shrink-0 bg-[#FFAA00] text-black px-4 py-1.5 rounded-full text-[9px] font-black uppercase tracking-tighter";
                applyFilters();
            }

            function filterServer(srv, btn) {
                currentServer = srv;
                document.querySelectorAll('.srv-btn').forEach(b => {
                    b.className = "srv-btn shrink-0 bg-slate-800 text-slate-400 px-4 py-1.5 rounded-full text-[9px] font-black uppercase hover:text-white tracking-tighter";
                });
                btn.className = "srv-btn shrink-0 bg-[#FFAA00] text-black px-4 py-1.5 rounded-full text-[9px] font-black uppercase tracking-tighter";
                applyFilters();
            }
        </script>
    </body></html>`);
});

app.get('/invite', (req, res) => {
    const permissions = '274881134080';
    const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${process.env.CLIENT_ID}&permissions=${permissions}&scope=bot%20applications.commands`;
    
    const botAvatar = client.user.displayAvatarURL();
    
    res.send(`
    <html>
    ${getHead('Impulse | Add to Server')}
    <body class="bg-[#0b0f1a] text-white min-h-screen flex items-start justify-center p-6 overflow-y-auto">
        <div class="max-w-2xl w-full mt-8 mb-8">
            <div class="text-center mb-8">
                <div class="inline-flex items-center justify-center p-4 rounded-full bg-[#FFAA00]/10 border-2 border-[#FFAA00] shadow-[0_0_30px_rgba(255,170,0,0.4)] mb-6">
                    <img src="${botAvatar}" class="w-16 h-16 rounded-full">
                </div>
                <h1 class="text-4xl md:text-5xl font-black tracking-tighter text-white uppercase mb-2">Impulse <span class="text-[#FFAA00]">Bot</span></h1>
                <p class="text-slate-400 text-sm">Automated Forum Thread Management</p>
            </div>
            
            <div class="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 md:p-8 shadow-2xl backdrop-blur-md mb-6">
                <h2 class="text-lg md:text-xl font-bold text-[#FFAA00] mb-4 uppercase tracking-tight">What does Impulse do?</h2>
                
                <div class="space-y-3 mb-6">
                    <div class="flex items-start gap-3 text-sm text-slate-300">
                        <span class="text-[#FFAA00] text-lg shrink-0">✓</span>
                        <p><strong class="text-white">Auto-welcomes</strong> users in forum threads</p>
                    </div>
                    <div class="flex items-start gap-3 text-sm text-slate-300">
                        <span class="text-[#FFAA00] text-lg shrink-0">✓</span>
                        <p><strong class="text-white">Auto-locks</strong> resolved threads after customizable time</p>
                    </div>
                    <div class="flex items-start gap-3 text-sm text-slate-300">
                        <span class="text-[#FFAA00] text-lg shrink-0">✓</span>
                        <p><strong class="text-white">Auto-closes</strong> threads inactive for 30+ days</p>
                    </div>
                    <div class="flex items-start gap-3 text-sm text-slate-300">
                        <span class="text-[#FFAA00] text-lg shrink-0">✓</span>
                        <p><strong class="text-white">Duplicate detection</strong> to close repeat questions</p>
                    </div>
                    <div class="flex items-start gap-3 text-sm text-slate-300">
                        <span class="text-[#FFAA00] text-lg shrink-0">✓</span>
                        <p><strong class="text-white">Unanswered tracking</strong> with automatic tag management</p>
                    </div>
                    <div class="flex items-start gap-3 text-sm text-slate-300">
                        <span class="text-[#FFAA00] text-lg shrink-0">✓</span>
                        <p><strong class="text-white">Web dashboard</strong> for viewing logs and analytics</p>
                    </div>
                </div>

                <div class="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mb-6">
                    <p class="text-xs text-amber-200 leading-relaxed">
                        <strong class="text-amber-400">⚠️ Required Permissions:</strong> 
                        View Channels, Send Messages, Manage Threads, Embed Links, Read Message History, Use Slash Commands
                    </p>
                </div>

                <a href="${inviteUrl}" target="_blank" class="block w-full text-center bg-[#FFAA00] hover:bg-[#ffbb33] text-black py-4 rounded-xl font-black text-sm uppercase tracking-widest transition-all shadow-[0_0_20px_rgba(255,170,0,0.3)] hover:shadow-[0_0_30px_rgba(255,170,0,0.5)]">
                    Add to Server
                </a>
            </div>

            <div class="bg-slate-900/40 border border-slate-800/50 rounded-xl p-6 backdrop-blur-sm">
                <h3 class="text-sm font-black text-[#FFAA00] mb-3 uppercase tracking-wider">Quick Setup Guide</h3>
                <ol class="space-y-2 text-xs text-slate-400">
                    <li class="flex gap-3">
                        <span class="text-[#FFAA00] font-bold shrink-0">1.</span>
                        <span>Click "Add to Server" and select your server</span>
                    </li>
                    <li class="flex gap-3">
                        <span class="text-[#FFAA00] font-bold shrink-0">2.</span>
                        <span>Run <code class="bg-black/40 px-2 py-0.5 rounded text-[#FFAA00] font-mono">/setup</code> in your server</span>
                    </li>
                    <li class="flex gap-3">
                        <span class="text-[#FFAA00] font-bold shrink-0">3.</span>
                        <span>Configure your forum channel, helper roles, and tags</span>
                    </li>
                    <li class="flex gap-3">
                        <span class="text-[#FFAA00] font-bold shrink-0">4.</span>
                        <span>You're all set! The bot will start monitoring threads automatically</span>
                    </li>
                </ol>
            </div>

            <div class="text-center mt-8">
                <a href="/" class="text-slate-500 text-xs hover:text-[#FFAA00] transition uppercase tracking-widest font-bold">← Back to Dashboard</a>
            </div>
        </div>
    </body></html>`);
});

app.get('/snippets', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/auth/discord');

    // 1. Get IDs of guilds where the user has permission
    const allowedGuildIds = db.prepare(`SELECT guild_id FROM guild_settings`).all()
      .map(g => g.guild_id)
      .filter(gid => {
          const guild = client.guilds.cache.get(gid);
          if (!guild) return false;
          const member = guild.members.cache.get(req.user.id);
          return member && (
              member.permissions.has(PermissionFlagsBits.Administrator) ||
              hasHelperRole(member, getSettings(gid))
          );
      });

    // Handle case where user has no access to any servers
    if (allowedGuildIds.length === 0) {
        return res.send(`<html>${getHead('Snippets')} <body class="bg-[#0b0f1a] text-white p-8">${getNav('snippets')} <p>No snippets found or no server access.</p></body></html>`);
    }

    // 2. Fetch snippets for those guilds
    const snippets = db.prepare(`
        SELECT * FROM snippets
        WHERE guild_id IN (${allowedGuildIds.map(() => '?').join(',')})
        ORDER BY updated_at DESC
    `).all(...allowedGuildIds);

    res.send(`
    <html>
    ${getHead('Impulse | Snippets')}
    <body class="bg-[#0b0f1a] text-slate-200 p-6">
        <div class="max-w-5xl mx-auto">
            ${getNav('snippets')}

            <div class="flex justify-between items-center mb-6">
                <h1 class="text-2xl font-black text-white uppercase">Snippets</h1>
                <a href="/snippets/new" class="bg-[#FFAA00] text-black px-4 py-2 rounded-lg text-[10px] font-black uppercase">
                    + Create Snippet
                </a>
            </div>

            <div class="space-y-3">
                ${snippets.map(s => {
                    // Look up the guild name for better UI
                    const guild = client.guilds.cache.get(s.guild_id);
                    return `
                    <div class="bg-slate-900/40 p-4 rounded-xl border border-slate-800 flex justify-between items-center">
                        <div>
                            <div class="flex items-center gap-2">
                                <p class="font-bold text-white">${s.name}</p>
                                <span class="text-[9px] bg-slate-800 px-2 py-0.5 rounded text-slate-500">${guild ? guild.name : 'Unknown Server'}</span>
                            </div>
                            <p class="text-[10px] text-slate-500">ID: ${s.created_by}</p>
                            <p class="text-xs text-slate-400">${s.title || 'No title'}</p>
                        </div>
                        <div class="flex items-center gap-3">
                            <a href="/snippets/toggle/${s.id}" class="text-[9px] uppercase font-black ${s.enabled ? 'text-emerald-400' : 'text-rose-500'} hover:underline">
                                ${s.enabled ? 'Enabled' : 'Disabled'}
                            </a>
                            <a href="/snippets/edit/${s.id}" class="text-xs text-sky-400 hover:underline">Edit</a>
                            <a href="/snippets/delete/${s.id}" class="text-xs text-rose-500 hover:underline" onclick="return confirm('Delete this snippet?')">Delete</a>
                        </div>
                    </div>
                `}).join('')}
            </div>
        </div>
    </body>
    </html>
    `);
});

app.get('/snippets/new', (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/auth/discord');

    const guilds = db.prepare(`SELECT guild_id, guild_name FROM guild_settings`).all()
        .filter(g => {
            const guild = client.guilds.cache.get(g.guild_id);
            if (!guild) return false;
            const member = guild.members.cache.get(req.user.id);
            return member && (member.permissions.has(PermissionFlagsBits.Administrator) || hasHelperRole(member, getSettings(g.guild_id)));
        });

    res.send(`
    <html>
    ${getHead('Impulse | Create Snippet')}
    <body class="bg-[#0b0f1a] text-slate-200 p-6">
        <div class="max-w-6xl mx-auto">
            ${getNav('snippets')}
            
            <div class="mb-8">
                <h1 class="text-3xl font-black text-white uppercase tracking-tighter">Create <span class="text-[#FFAA00]">Snippet</span></h1>
                <p class="text-xs text-slate-500 uppercase font-bold tracking-widest mt-1">Live Preview Mode</p>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-2 gap-12">
                <form id="snippetForm" method="POST" action="/snippets/new" class="space-y-6">
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div class="bg-slate-900/50 p-4 rounded-xl border border-slate-800">
                            <label class="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2 block">Target Server</label>
                            <select name="guild_id" required class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs font-bold text-white focus:border-[#FFAA00] outline-none">
                                <option value="" disabled selected>Choose server...</option>
                                ${guilds.map(g => `<option value="${g.guild_id}">${g.guild_name}</option>`).join('')}
                            </select>
                        </div>
                        <div class="bg-slate-900/50 p-4 rounded-xl border border-slate-800">
                            <label class="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2 block">Trigger Name</label>
                            <input name="name" required placeholder="rules" class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs font-bold text-white focus:border-[#FFAA00] outline-none">
                        </div>
                    </div>

                    <div class="bg-slate-900/50 p-6 rounded-xl border border-slate-800 space-y-4">
                        <input id="inTitle" name="title" placeholder="Embed Title" class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white focus:border-[#FFAA00] outline-none">
                        <textarea id="inDesc" name="description" placeholder="Embed Description" class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white h-32 focus:border-[#FFAA00] outline-none resize-none"></textarea>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <input id="inFooter" name="footer" placeholder="Footer text" class="md:col-span-2 w-full bg-slate-900/50 p-4 rounded-xl border border-slate-800 text-xs text-white focus:border-[#FFAA00] outline-none">
                        <div class="bg-slate-900/50 p-4 rounded-xl border border-slate-800 flex items-center justify-between">
                            <label class="text-[9px] font-black text-slate-500 uppercase tracking-widest">Color</label>
                            <input id="inColor" name="color" type="color" value="#FFAA00" class="bg-transparent border-none w-8 h-8 cursor-pointer">
                        </div>
                    </div>

                    <button type="submit" class="w-full bg-[#FFAA00] text-black py-4 rounded-xl font-black uppercase text-xs tracking-widest hover:bg-[#FFC040] transition-all">Save Snippet</button>
                </form>

                <div class="sticky top-6">
                    <label class="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-4 block text-center">Discord Preview</label>
                    <div class="bg-[#313338] p-4 rounded-sm shadow-xl font-['gg_sans',_sans-serif]">
                        <div class="flex items-start gap-4">
                            <img src="${client.user.displayAvatarURL()}" class="w-10 h-10 rounded-full">
                            <div class="flex-1">
                                <div class="flex items-center gap-2 mb-1">
                                    <span class="font-medium text-white text-sm hover:underline cursor-pointer">${client.user.username}</span>
                                    <span class="bg-[#5865F2] text-white text-[10px] px-1 rounded-sm font-bold">BOT</span>
                                    <span class="text-[#949ba4] text-[10px]">Today at ${new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                                </div>
                                
                                <div id="preBorder" class="bg-[#2b2d31] border-l-4 border-[#FFAA00] rounded-sm p-3 mt-1 max-w-[432px]">
                                    <div id="preTitle" class="text-white font-bold text-sm mb-1 empty:hidden"></div>
                                    <div id="preDesc" class="text-[#dbdee1] text-xs leading-5 whitespace-pre-wrap empty:hidden"></div>
                                    <div id="preFooter" class="text-[#b5bac1] text-[10px] mt-2 font-medium empty:hidden"></div>
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
                desc: document.getElementById('inDesc'),
                footer: document.getElementById('inFooter'),
                color: document.getElementById('inColor')
            };

            const preview = {
                title: document.getElementById('preTitle'),
                desc: document.getElementById('preDesc'),
                footer: document.getElementById('preFooter'),
                border: document.getElementById('preBorder')
            };

            function updatePreview() {
                preview.title.innerText = inputs.title.value;
                preview.desc.innerText = inputs.desc.value;
                preview.footer.innerText = inputs.footer.value;
                preview.border.style.borderColor = inputs.color.value;
            }

            // Listen for any typing or color picking
            Object.values(inputs).forEach(input => {
                input.addEventListener('input', updatePreview);
            });

            // Initialize on load
            updatePreview();
        </script>
    </body>
    </html>
    `);
});

app.post('/snippets/new', express.urlencoded({ extended: true }), (req, res) => {
    const { guild_id, name, title, description, color, footer, fields } = req.body;

    db.prepare(`
        INSERT INTO snippets (
            guild_id, name, title, description, color, fields, footer, created_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        guild_id,
        name.toLowerCase(),
        title,
        description,
        color,
        fields || '[]',
        footer,
        req.user.id
    );

    logAction(
        guild_id,
        'SNIPPET_CREATE',
        `Created snippet: ${name}`,
        req.user.id,
        req.user.username,
        `https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png`,
        '/snippet'
    );

    res.redirect('/snippets');
});

app.get('/snippets/edit/:id', (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/auth/discord');

    const snippet = db.prepare(`SELECT * FROM snippets WHERE id = ?`).get(req.params.id);
    if (!snippet) return res.redirect('/snippets');

    if (!canManageSnippet(req, snippet)) { 
        return res.status(403).send("Forbidden");
    }

    res.send(`
        <html>
        ${getHead('Edit Snippet')}
        <body class="bg-[#0b0f1a] text-slate-200 p-6">
            <div class="max-w-4xl mx-auto">
                ${getNav('snippets')}
                <h1 class="text-2xl font-black text-white mb-6 uppercase">Edit Snippet</h1>

                <form method="POST" action="/snippets/edit/${snippet.id}">
                    <input name="title" value="${snippet.title || ''}" class="w-full bg-slate-900 p-3 mb-3 rounded border border-slate-800 text-sm focus:border-[#FFAA00] outline-none">
                    <textarea name="description" class="w-full bg-slate-900 p-3 mb-3 rounded border border-slate-800 text-sm h-32 focus:border-[#FFAA00] outline-none">${snippet.description || ''}</textarea>
                    <div class="flex items-center gap-4 mb-4">
                        <label class="text-[10px] font-black uppercase text-slate-500">Embed Color</label>
                        <input name="color" type="color" value="${snippet.color || '#FFAA00'}" class="bg-transparent border-none w-10 h-10 cursor-pointer">
                    </div>
                    <input name="footer" value="${snippet.footer || ''}" class="w-full bg-slate-900 p-3 rounded border border-slate-800 text-sm focus:border-[#FFAA00] outline-none">
                    <button class="bg-[#FFAA00] text-black px-6 py-3 mt-6 rounded-xl font-black uppercase text-xs hover:bg-[#ffbb33] transition-all shadow-[0_0_15px_rgba(255,170,0,0.2)]">
                        Update Snippet
                    </button>
                </form>
            </div>
        </body>
        </html>
    `);
});

app.post('/snippets/edit/:id', express.urlencoded({ extended: true }), (req, res) => {
    const { title, description, color, footer } = req.body;

    db.prepare(`
        UPDATE snippets
        SET title = ?, description = ?, color = ?, footer = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(title, description, color, footer, req.params.id);

    res.redirect('/snippets');
});

app.get('/snippets/delete/:id', (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/auth/discord');

    const snippet = db.prepare(`SELECT * FROM snippets WHERE id = ?`).get(req.params.id);
    if (!snippet) return res.redirect('/snippets');

    if (!canManageSnippet(req, snippet)) { 
        return res.status(403).send("Forbidden");
    }

    db.prepare(`DELETE FROM snippets WHERE id = ?`).run(req.params.id);

    logAction(
        snippet.guild_id,
        'SNIPPET_DELETE',
        `Deleted snippet: ${snippet.name}`,
        req.user.id,
        req.user.username,
        `https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png`
    );

    res.redirect('/snippets');
});

app.get('/snippets/toggle/:id', (req, res) => {
    const snippet = db.prepare(`SELECT * FROM snippets WHERE id = ?`).get(req.params.id);
    if (!snippet || !canManageSnippet(req, snippet)) return res.redirect('/snippets');

    db.prepare(`
        UPDATE snippets SET enabled = NOT enabled WHERE id = ?
    `).run(snippet.id);

    res.redirect('/snippets');
});



app.listen(3000, '0.0.0.0');

// --- BOT EVENTS ---
const IMPULSE_COLOR = 0xFFAA00;

client.once('clientReady', (c) => {
    console.log(`✅ Logged in as ${c.user.tag}`);
    
    // Timer for locking resolved threads
    setInterval(async () => {
        const rows = db.prepare('SELECT * FROM pending_locks WHERE lock_at <= ?').all(Date.now());
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
                        .setDescription("This thread has been marked as resolved and is now closed. Thank you for using our support forum!")
                        .setColor(IMPULSE_COLOR)
                        .setTimestamp()
                        .setFooter({ text: "Impulse Bot • Automated Lock" });
                    
                    await thread.send({ embeds: [lockEmbed] });
                    logAction(row.guild_id, 'LOCK', `Locked thread: ${thread.name}`);
                }
            } catch (e) { console.error("Lock error:", e); }
            db.prepare('DELETE FROM pending_locks WHERE thread_id = ?').run(row.thread_id);
        }
    }, 60000);

    // Timer for auto-closing threads older than 30 days
    setInterval(async () => {
        const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
        const oldThreads = db.prepare('SELECT * FROM thread_tracking WHERE created_at <= ?').all(thirtyDaysAgo);
        
        for (const tracked of oldThreads) {
            const settings = getSettings(tracked.guild_id);
            if (!settings) continue;
            
            try {
                const thread = await client.channels.fetch(tracked.thread_id);
                if (thread && !thread.locked) {
                    await thread.setLocked(true);
                    
                    const autoCloseEmbed = new EmbedBuilder()
                        .setTitle("🔒 Thread Auto-Closed")
                        .setDescription("This thread has been automatically closed due to 30+ days of inactivity. If you still need help, please create a new thread.")
                        .setColor(0x6B7280)
                        .setTimestamp()
                        .setFooter({ text: "Impulse Bot • Auto-Close" });
                    
                    await thread.send({ embeds: [autoCloseEmbed] });
                    logAction(tracked.guild_id, 'AUTO_CLOSE', `Auto-closed old thread: ${thread.name}`);
                }
            } catch (e) { 
                console.error("Auto-close error:", e); 
            }
            
            db.prepare('DELETE FROM thread_tracking WHERE thread_id = ?').run(tracked.thread_id);
        }
    }, 6 * 60 * 60 * 1000); // Check every 6 hours
});

client.on('threadCreate', async (thread) => {
    const settings = getSettings(thread.guildId);
    if (!settings || thread.parentId !== settings.forum_id) return;

    // Track thread creation time for auto-closing
    db.prepare('INSERT OR REPLACE INTO thread_tracking (thread_id, guild_id, created_at) VALUES (?, ?, ?)').run(
        thread.id,
        thread.guildId,
        Date.now()
    );

    // Apply unanswered tag if configured
    if (settings.unanswered_tag) {
        try {
            await thread.setAppliedTags([settings.unanswered_tag]);
        } catch (e) {
            console.error("Error applying unanswered tag:", e);
        }
    }

    const welcomeEmbed = new EmbedBuilder()
        .setTitle("Welcome to Support!")
        .setDescription(
            `Hey <@${thread.ownerId}>!\n\n` +
            `**What happens next?**\n` +
            `• A command helper will assist you shortly\n` +
            `• Use \`/resolved\` when your issue is fixed\n` +
            `• The thread will auto-lock 30 minutes after being marked resolved\n\n` +
            `*Please provide as much detail as possible about your issue!*`
        )
        .setColor(IMPULSE_COLOR)
        .setTimestamp()
        .setFooter({ text: "Impulse Bot • Automated Greeting" });

    await thread.send({ embeds: [welcomeEmbed] });
    logAction(thread.guildId, 'GREET', `Welcomed user in ${thread.name}`);
});

// Remove unanswered tag when a non-bot user replies
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.channel.isThread()) return;

    const settings = getSettings(message.guildId);
    if (!settings || !settings.unanswered_tag) return;
    if (message.channel.parentId !== settings.forum_id) return;

    try {
        const currentTags = message.channel.appliedTags;
        if (currentTags.includes(settings.unanswered_tag)) {
            const newTags = currentTags.filter(tag => tag !== settings.unanswered_tag);
            await message.channel.setAppliedTags(newTags);
            logAction(message.guildId, 'ANSWERED', `Removed unanswered tag from: ${message.channel.name}`);
        }
    } catch (e) {
        console.error("Error removing unanswered tag:", e);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const settings = getSettings(interaction.guildId);

    const userId = interaction.user.id;
    const userName = interaction.user.username;
    const userAvatar = interaction.user.displayAvatarURL();

    if (interaction.commandName === 'setup') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ 
                content: "❌ **Access Denied:** Administrator permissions required.", 
                ephemeral: true 
            });
        }
        
        const forum = interaction.options.getChannel('forum');
        const resTag = interaction.options.getString('resolved_tag');
        const dupTag = interaction.options.getString('duplicate_tag');
        const unansTag = interaction.options.getString('unanswered_tag') || null;
        const rawRoles = interaction.options.getString('helper_roles');
        const cleanRoles = rawRoles.replace(/\s+/g, ''); 

        db.prepare(`INSERT OR REPLACE INTO guild_settings (guild_id, guild_name, forum_id, resolved_tag, duplicate_tag, unanswered_tag, helper_role_id) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
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
            'SETUP', 
            `Setup updated with Roles: ${cleanRoles}`,
            userId,
            userName,
            userAvatar,
            '/setup'
        );
        
        const setupEmbed = new EmbedBuilder()
            .setTitle("✅ Setup Complete!")
            .addFields(
                { name: "Forum Channel", value: `<#${forum.id}>`, inline: true },
                { name: "Helper Roles", value: cleanRoles.split(',').map(id => `<@&${id}>`).join(' '), inline: true },
                { name: "Tags Configured", value: `Resolved: \`${resTag}\`\nDuplicate: \`${dupTag}\`${unansTag ? `\nUnanswered: \`${unansTag}\`` : ''}`, inline: false }
            )
            .setColor(IMPULSE_COLOR)
            .setTimestamp()
            .setFooter({ text: "Impulse Bot" });
        
        return interaction.reply({ embeds: [setupEmbed], ephemeral: true });
    }

    if (interaction.commandName === 'info') {
        if (!settings) {
            return interaction.reply({ 
                content: "❌ This server hasn't been configured yet. Use `/setup` first.", 
                ephemeral: true 
            });
        }
        
        const timerCount = db.prepare('SELECT COUNT(*) as count FROM pending_locks WHERE guild_id = ?').get(interaction.guildId).count;
        
        const infoEmbed = new EmbedBuilder()
            .setTitle("Bot Configuration Status")
            .addFields(
                { name: "Forum Channel", value: `<#${settings.forum_id}>`, inline: true },
                { name: "Helper Roles", value: settings.helper_role_id.split(',').map(id => `<@&${id}>`).join(', '), inline: true },
                { name: "Active Timers", value: timerCount.toString(), inline: true },
                { name: "Resolved Tag", value: `\`${settings.resolved_tag}\``, inline: true },
                { name: "Duplicate Tag", value: `\`${settings.duplicate_tag}\``, inline: true }
            )
            .setColor(IMPULSE_COLOR)
            .setTimestamp()
            .setFooter({ text: "Impulse Bot" });
        
        return interaction.reply({ embeds: [infoEmbed] });
    }

    if (!settings) {
        return interaction.reply({ 
            content: "❌ Please run `/setup` first.", 
            ephemeral: true 
        });
    }

    if (interaction.commandName === 'resolved') {
        const customMinutes = interaction.options.getInteger('minutes') || 30;
        const lockTime = Date.now() + (customMinutes * 60 * 1000);
        
        db.prepare('INSERT OR REPLACE INTO pending_locks (thread_id, guild_id, lock_at) VALUES (?, ?, ?)').run(
            interaction.channelId, 
            interaction.guildId, 
            lockTime
        );
        
        logAction(
            interaction.guildId, 
            'RESOLVED', 
            `Marked thread for locking in ${customMinutes}m: ${interaction.channel.name}`,
            userId,
            userName,
            userAvatar,
            `/resolved minutes:${customMinutes}`
        );
        
        const resolvedEmbed = new EmbedBuilder()
            .setTitle("✅ Thread Marked as Resolved")
            .setDescription(
                `This thread will automatically lock <t:${Math.floor(lockTime / 1000)}:R>.\n\n` +
                `If you need to reopen this thread or have additional questions, use \`/cancel\` before it locks or contact a moderator.`
            )
            .setColor(0x10B981)
            .setTimestamp()
            .setFooter({ text: `Impulse Bot • Locks at ${new Date(lockTime).toLocaleTimeString()}` });
        
        await interaction.reply({ embeds: [resolvedEmbed] });
    }

    if (interaction.commandName === 'cancel') {
        const existing = db.prepare('SELECT * FROM pending_locks WHERE thread_id = ?').get(interaction.channelId);
        
        if (!existing) {
            return interaction.reply({ 
                content: "❌ There is no pending lock timer for this thread.", 
                ephemeral: true 
            });
        }
        
        db.prepare('DELETE FROM pending_locks WHERE thread_id = ?').run(interaction.channelId);
        
        logAction(
            interaction.guildId,
            'CANCEL',
            `Cancelled lock timer for: ${interaction.channel.name}`,
            userId,
            userName,
            userAvatar,
            '/cancel'
        );
        
        const cancelEmbed = new EmbedBuilder()
            .setTitle("🔓 Lock Timer Cancelled")
            .setDescription("The automatic lock has been cancelled. This thread will remain open.")
            .setColor(0xF59E0B)
            .setTimestamp()
            .setFooter({ text: "Impulse Bot" });
        
        await interaction.reply({ embeds: [cancelEmbed] });
    }

    if (interaction.commandName === 'duplicate') {
        const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
        const isHelper = hasHelperRole(interaction.member, settings);

        if (!isAdmin && !isHelper) {
            return interaction.reply({ 
                content: "❌ **Access Denied:** You need a Command Helper Role or Administrator permissions.", 
                ephemeral: true 
            });
        }

        const link = interaction.options.getString('link');
        
        try {
            await interaction.channel.setAppliedTags([settings.duplicate_tag]);
            
            const duplicateEmbed = new EmbedBuilder()
                .setTitle("🔄 Thread Closed: Duplicate")
                .setDescription(
                    `This topic has already been addressed in another thread.\n\n` +
                    `**Original Thread:** ${link}\n\n` +
                    `Please refer to the linked thread for the solution. This thread will now be locked.`
                )
                .setColor(0x0EA5E9)
                .setTimestamp()
                .setFooter({ text: "Impulse Bot • Duplicate Detection" });
            
            await interaction.reply({ embeds: [duplicateEmbed] });
            await interaction.channel.setLocked(true);
            
            logAction(
                interaction.guildId, 
                'DUPLICATE', 
                `Closed duplicate: ${interaction.channel.name}`,
                userId,
                userName,
                userAvatar,
                `/duplicate link:${link}`
            );
        } catch (e) {
            console.error(e);
            interaction.followUp({ 
                content: "⚠️ Failed to apply tags/lock. Check bot permissions.", 
                ephemeral: true 
            });
        }
    }

    if (interaction.commandName === 'snippet') {
        const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
        const isHelper = hasHelperRole(interaction.member, settings);

        if (!isAdmin && !isHelper) {
            return interaction.reply({
                content: "❌ **Access Denied:** You need a Command Helper Role or Administrator permissions.",
                ephemeral: true
            });
        }

        const name = interaction.options.getString('name');

        const snippet = db.prepare(`
            SELECT * FROM snippets
            WHERE guild_id = ? AND name = ? AND enabled = 1
        `).get(interaction.guildId, name);

        if (!snippet) {
            return interaction.reply({
                content: "❌ Snippet not found or disabled.",
                ephemeral: true
            });
        }

        const embed = new EmbedBuilder()
            .setTitle(snippet.title || null)
            .setDescription(snippet.description || null)
            .setColor(snippet.color || IMPULSE_COLOR)
            .setTimestamp();

        if (snippet.footer) {
            embed.setFooter({ text: snippet.footer });
        }

        // Optional fields
        try {
            const fields = JSON.parse(snippet.fields || '[]');
            if (Array.isArray(fields) && fields.length) {
                embed.addFields(fields);
            }
        } catch (err) {
            console.error("Invalid snippet fields JSON:", err);
        }

        logAction(
            interaction.guildId,
            'SNIPPET',
            `Used snippet: ${name}`,
            userId,
            userName,
            userAvatar,
            `/snippet name:${name}`
        );

        return interaction.reply({ embeds: [embed] });
    }

});

client.login(process.env.DISCORD_TOKEN);