require('dotenv').config();
const { Client, GatewayIntentBits, PermissionFlagsBits, EmbedBuilder, Partials } = require('discord.js');
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
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages
    ],
    partials: [
        Partials.Message, 
        Partials.Reaction, 
        Partials.User
    ]
});

// --- DATABASE INITIALIZATION ---
db.prepare(`CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    guild_name TEXT,
    forum_id TEXT,
    resolved_tag TEXT,
    duplicate_tag TEXT,
    unanswered_tag TEXT,
    helper_role_id TEXT
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS thread_tracking (
    thread_id TEXT PRIMARY KEY,
    guild_id TEXT,
    created_at INTEGER,
    stale_warning_sent INTEGER DEFAULT 0,
    last_renewed_at INTEGER
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
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    thread_id TEXT,
    message_id TEXT
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
    url TEXT,
    image_url TEXT,
    thumbnail_url TEXT,
    UNIQUE(guild_id, name)
)
`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS thread_links (
    thread_id TEXT PRIMARY KEY,
    guild_id TEXT,
    url TEXT,
    created_by TEXT,
    created_at INTEGER
)`).run();

// --- HELPERS ---
const getSettings = (guildId) => db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId);

function getNav(activePage, user) {
    const current = activePage === 'home' ? 'overview' : activePage;
    const pages = ['overview', 'snippets', 'threads', 'logs'];
    const profileSection = user ? `
        <div class="flex items-center gap-4 bg-slate-900/80 px-4 py-2 rounded-full border border-slate-800 shadow-xl">
            <div class="text-right hidden sm:block">
                <p class="text-[10px] font-black text-white uppercase leading-none">${user.username}</p>
                <a href="/logout" class="text-[8px] font-bold text-rose-500 uppercase hover:text-rose-400 transition-colors">Terminate Session</a>
            </div>
            <img src="https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png" class="w-8 h-8 rounded-full border-2 border-[#FFAA00]">
        </div>` : '';

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
            ${pages.map(p => `
                <a href="/${p === 'overview' ? '' : p}" 
                   class="px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${current === p ? 'bg-[#FFAA00] text-black shadow-lg shadow-amber-500/10' : 'text-slate-500 hover:text-white'}">
                    ${p}
                </a>
            `).join('')}
        </div>
        ${profileSection}
    </nav>`;
}

const logAction = (guildId, action, details, userId = null, userName = null, userAvatar = null, command = null, threadId = null, messageId = null) => {
    db.prepare('INSERT INTO audit_logs (guild_id, action, details, user_id, user_name, user_avatar, command_used, thread_id, message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        guildId, action, details, userId, userName, userAvatar, command, threadId, messageId
    );
};

function hasHelperRole(member, settings) {
    if (!settings || !settings.helper_role_id) return false;
    const roleIDs = settings.helper_role_id.split(',').map(id => id.trim());
    return member.roles.cache.some(role => roleIDs.includes(role.id));
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
    processed = processed.replace(/{br}/g, '\n');
    return processed.length > 4000 ? processed.substring(0, 4000) + "..." : processed;
}

function getErrorPage(title, message, code = "403") {
    return `<html>${getHead('Impulse | ' + title)}<body class="bg-[#0b0f1a] text-slate-200 min-h-screen flex items-center justify-center p-6"><div class="max-w-md w-full text-center space-y-6"><h1 class="text-9xl font-black text-white/5 tracking-tighter">${code}</h1><h2 class="text-2xl font-black text-white uppercase">${title}</h2><p class="text-slate-500">${message}</p><a href="/" class="inline-block bg-slate-900 text-white px-8 py-3 rounded-xl border border-slate-800 text-xs font-black uppercase">Return Dashboard</a></div></body></html>`;
}

function getDiscordLink(guildId, channelId, messageId = null) {
    return messageId ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}` : `https://discord.com/channels/${guildId}/${channelId}`;
}

function getReadableName(channelId, guildId) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return `Channel ${channelId.slice(-4)}`;
    const channel = guild.channels.cache.get(channelId);
    return channel ? channel.name : `Channel ${channelId.slice(-4)}`;
}

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
        </style>
    </head>`;

async function canManageSnippet(req, guild_id) {
    try {
        let guild = client.guilds.cache.get(guild_id) || await client.guilds.fetch(guild_id);
        const member = await guild.members.fetch(req.user.id);
        const settings = getSettings(guild_id);
        return member.permissions.has(PermissionFlagsBits.Administrator) || hasHelperRole(member, settings);
    } catch (e) { return false; }
}

const getActionColor = (action) => {
    const colors = {
        'SNIPPET_CREATE': 'bg-blue-500/10 text-blue-400 border-blue-500/20',
        'SNIPPET_UPDATE': 'bg-blue-500/10 text-blue-400 border-blue-500/20',
        'SNIPPET_DELETE': 'bg-rose-500/10 text-rose-400 border-rose-500/20',
        'LOCK': 'bg-amber-500/10 text-amber-500 border-amber-500/20',
        'CANCEL': 'bg-orange-500/10 text-orange-500 border-orange-500/20',
        'GREET': 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
        'DUPLICATE': 'bg-sky-500/10 text-sky-500 border-sky-500/20',
        'SETUP': 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
        'RESOLVED': 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
        'ANSWERED': 'bg-green-500/10 text-green-500 border-green-500/20',
        'AUTO_CLOSE': 'bg-gray-500/10 text-gray-500 border-gray-500/20',
        'STALE_WARNING': 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
        'THREAD_RENEWED': 'bg-cyan-500/10 text-cyan-500 border-cyan-500/20',
        'LINK_ADDED': 'bg-blue-600/10 text-blue-600 border-blue-600/20',
        'LINK_ACCESSED': 'bg-purple-500/10 text-purple-500 border-purple-500/20',
        'LINK_REMOVED': 'bg-red-500/10 text-red-500 border-red-500/20'
    };
    return colors[action] || 'bg-slate-800 text-slate-400 border-slate-700';
};

// --- PASSPORT / OAUTH2 ---
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));
passport.use(new Strategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.REDIRECT_URI,
    scope: ['identify', 'guilds', 'guilds.members.read']
}, (accessToken, refreshToken, profile, done) => done(null, profile)));

app.use(session({
    store: new SQLiteStore({ db: 'database.db', table: 'sessions', dir: './' }),
    secret: process.env.SESSION_SECRET || 'keyboard cat',
    resave: false, saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());

// --- WEB ROUTES ---
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/logout', (req, res) => req.logout(() => res.redirect('/')));

app.get('/', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.send(`<html>${getHead('Impulse | Access')} <body class="bg-[#0b0f1a] text-white flex items-center justify-center min-h-screen p-6"><div class="max-w-md w-full text-center"><h1 class="text-4xl font-black mb-4">Impulse <span class="text-[#FFAA00]">OS</span></h1><a href="/auth/discord" class="bg-[#FFAA00] text-black px-8 py-4 rounded-xl font-black uppercase block">Establish Connection</a></div></body></html>`);
    }

    const authorizedGuilds = [];
    const allSettings = db.prepare(`SELECT * FROM guild_settings`).all();
    for (const s of allSettings) {
        const guild = client.guilds.cache.get(s.guild_id);
        if (!guild) continue;
        try {
            const member = await guild.members.fetch(req.user.id);
            if (member.permissions.has(PermissionFlagsBits.Administrator) || hasHelperRole(member, s)) {
                const timers = db.prepare('SELECT thread_id, lock_at FROM pending_locks WHERE guild_id = ?').all(s.guild_id);
                const snippetCount = db.prepare('SELECT COUNT(*) as count FROM snippets WHERE guild_id = ?').get(s.guild_id).count;
                authorizedGuilds.push({ ...s, timers, snippetCount });
            }
        } catch (e) {}
    }

    const recentLogs = db.prepare(`SELECT audit_logs.*, guild_settings.guild_name FROM audit_logs LEFT JOIN guild_settings ON audit_logs.guild_id = guild_settings.guild_id ORDER BY timestamp DESC LIMIT 5`).all();
    const totalSnippets = db.prepare('SELECT COUNT(*) as count FROM snippets').get().count;
    const totalLocks = db.prepare('SELECT COUNT(*) as count FROM pending_locks').get().count;

    res.send(`
    <html>
    ${getHead('Impulse | Dashboard')}
    <body class="bg-[#0b0f1a] text-slate-200 min-h-screen p-8">
        <div class="max-w-6xl mx-auto">
            ${getNav('overview', req.user)}
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
                <div class="bg-slate-900/40 p-6 rounded-2xl border border-slate-800">
                    <h3 class="text-[10px] font-black text-slate-500 uppercase">Servers</h3>
                    <p class="text-4xl font-black text-white">${authorizedGuilds.length}</p>
                </div>
                <div class="bg-slate-900/40 p-6 rounded-2xl border border-slate-800">
                    <h3 class="text-[10px] font-black text-slate-500 uppercase">Locks</h3>
                    <p class="text-4xl font-black text-white">${totalLocks}</p>
                </div>
                <div class="bg-slate-900/40 p-6 rounded-2xl border border-slate-800">
                    <h3 class="text-[10px] font-black text-slate-500 uppercase">Snippets</h3>
                    <p class="text-4xl font-black text-white">${totalSnippets}</p>
                </div>
            </div>

            <div class="bg-slate-900/40 rounded-2xl border border-slate-800 overflow-hidden">
                <div class="p-6 border-b border-slate-800">Recent Activity</div>
                <div class="divide-y divide-slate-800/40">
                    ${recentLogs.map(l => `
                        <div class="p-4 flex items-center gap-4">
                            <span class="text-[10px] mono text-slate-500" data-timestamp="${l.timestamp}">Loading...</span>
                            <span class="px-2 py-0.5 rounded text-[8px] font-black ${getActionColor(l.action)}">${l.action}</span>
                            <p class="text-xs flex-1">${l.details}</p>
                        </div>`).join('')}
                </div>
            </div>
            <div class="mt-6 text-center text-xs text-slate-600 font-mono">
                Showing ${recentLogs.length} entries • Updated: ${new Date().toLocaleTimeString()}
            </div>
        </div>
        <script>
            function updateTimestamps() {
                document.querySelectorAll('[data-timestamp]').forEach(el => {
                    const raw = el.getAttribute('data-timestamp');
                    if (!raw || raw === "null") return;
                    const isoString = raw.replace(' ', 'T') + 'Z';
                    const date = new Date(isoString);
                    if (!isNaN(date.getTime())) el.innerText = date.toLocaleString(undefined, {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
                });
            }
            window.onload = updateTimestamps;
        </script>
    </body></html>`);
});

app.get('/logs', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/auth/discord');
    const allSettings = db.prepare(`SELECT * FROM guild_settings`).all();
    const managedGuildIds = [];
    for (const s of allSettings) {
        const guild = client.guilds.cache.get(s.guild_id);
        if (!guild) continue;
        try {
            const member = await guild.members.fetch(req.user.id);
            if (member.permissions.has(PermissionFlagsBits.Administrator) || hasHelperRole(member, s)) managedGuildIds.push(s.guild_id);
        } catch (e) {}
    }
    if (managedGuildIds.length === 0) return res.send(getErrorPage("No Access", "Permission Denied"));

    const rawLogs = db.prepare(`SELECT * FROM audit_logs WHERE guild_id IN (${managedGuildIds.map(()=>'?').join(',')}) ORDER BY timestamp DESC LIMIT 100`).all(...managedGuildIds);
    const logs = rawLogs.map(log => ({ ...log, displayName: client.guilds.cache.get(log.guild_id)?.name || 'Server', actionStyle: getActionColor(log.action) }));

    res.send(`<html>${getHead('Impulse | Logs')} <body class="bg-[#0b0f1a] text-slate-200 p-8"><div class="max-w-6xl mx-auto">${getNav('logs', req.user)}<table class="w-full text-left">
        ${logs.map(l => `<tr><td class="p-4 text-[10px]" data-timestamp="${l.timestamp}">Loading...</td><td class="p-4"><span class="px-2 py-1 rounded text-[9px] ${l.actionStyle}">${l.action}</span></td><td class="p-4 text-xs">${l.details}</td></tr>`).join('')}
    </table></div><script>function updateTimestamps(){document.querySelectorAll('[data-timestamp]').forEach(el=>{const r=el.getAttribute('data-timestamp');if(!r||r==="null")return;const i=r.replace(' ','T')+'Z';const d=new Date(i);if(!isNaN(d.getTime()))el.innerText=d.toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true});});}window.onload=updateTimestamps;</script></body></html>`);
});

app.get('/snippets/new', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/auth/discord');
    const allowedGuilds = [];
    const allSettings = db.prepare(`SELECT guild_id, guild_name FROM guild_settings`).all();
    for (const s of allSettings) {
        const guild = client.guilds.cache.get(s.guild_id);
        if (!guild) continue;
        try {
            const member = await guild.members.fetch(req.user.id);
            if (member.permissions.has(PermissionFlagsBits.Administrator) || hasHelperRole(member, s)) allowedGuilds.push(s);
        } catch (e) {}
    }
    res.send(`
    <html>${getHead('Impulse | Create Snippet')}
    <body class="bg-[#0b0f1a] text-slate-200 p-6"><div class="max-w-7xl mx-auto">${getNav('snippets', req.user)}
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-12">
        <form method="POST" action="/snippets/new" class="space-y-4">
            <select name="guild_id" required class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs font-bold text-white">${allowedGuilds.map(g=>`<option value="${g.guild_id}">${g.guild_name}</option>`).join('')}</select>
            <input name="name" required placeholder="Trigger Name" class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white">
            <input id="inTitle" name="title" placeholder="Embed Title" class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white">
            <input id="inUrl" name="url" placeholder="Title Link (URL)" class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white">
            <textarea id="inDesc" name="description" placeholder="Description" class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white h-32"></textarea>
            <input id="inImage" name="image_url" placeholder="Main Image URL" class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white">
            <input id="inThumb" name="thumbnail_url" placeholder="Thumbnail URL" class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white">
            <input id="inFooter" name="footer" placeholder="Footer text" class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white">
            <input id="inColor" name="color" type="color" value="#FFAA00">
            <div class="flex gap-4"><button type="submit" class="flex-[2] bg-[#FFAA00] text-black py-4 rounded-xl font-black uppercase text-xs">Create</button><a href="/snippets" class="flex-1 bg-slate-800 text-slate-400 py-4 rounded-xl font-black uppercase text-xs text-center">Cancel</a></div>
        </form>
        <div id="preBorder" class="bg-[#2b2d31] border-l-[4px] border-[#FFAA00] p-3 max-w-[432px]">
            <img id="preThumb" src="" class="w-20 h-20 rounded-md float-right" style="display:none">
            <div id="preTitle" class="text-white font-bold mb-1"></div>
            <div id="preDesc" class="text-[#dbdee1] text-sm whitespace-pre-wrap"></div>
            <img id="preImage" src="" class="mt-3 rounded-md w-full" style="display:none">
            <div id="preFooter" class="text-[#b5bac1] text-[10px] mt-2"></div>
        </div>
    </div>
    <script>
        const i={t:document.getElementById('inTitle'),u:document.getElementById('inUrl'),d:document.getElementById('inDesc'),f:document.getElementById('inFooter'),c:document.getElementById('inColor'),im:document.getElementById('inImage'),th:document.getElementById('inThumb')};
        const p={t:document.getElementById('preTitle'),d:document.getElementById('preDesc'),f:document.getElementById('preFooter'),b:document.getElementById('preBorder'),im:document.getElementById('preImage'),th:document.getElementById('preThumb')};
        function sim(t){if(!t)return "";return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/{user}/g,'<span class="text-[#5865F2]">@User</span>').replace(/{br}/g,'<br>').replace(/\\*\\*(.*?)\\*\\*/g,'<strong>$1</strong>').replace(/\\*(.*?)\\*/g,'<em>$1</em>').replace(/\`(.*?)\`/g,'<code class="bg-[#1e1f22] px-1 rounded">$1</code>').replace(/\\[(.*?)\\]\\((.*?)\\)/g,'<a href="#" class="text-[#00a8fc]">$1</a>');}
        function upd(){p.t.innerHTML=i.u.value?'<a href="#" class="text-[#00a8fc]">'+sim(i.t.value)+'</a>':sim(i.t.value);p.d.innerHTML=sim(i.d.value);p.f.innerText=i.f.value;p.b.style.borderColor=i.c.value;p.im.src=i.im.value;p.im.style.display=i.im.value?'block':'none';p.th.src=i.th.value;p.th.style.display=i.th.value?'block':'none';}
        Object.values(i).forEach(el=>el.addEventListener('input',upd));upd();
    </script>
    </body></html>`);
});

app.get('/snippets/edit/:id', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/auth/discord');
    const snippet = db.prepare(`SELECT * FROM snippets WHERE id = ?`).get(req.params.id);
    if (!snippet) return res.send(getErrorPage("Missing", "Snippet Not Found", "404"));
    
    const allowedGuilds = [];
    const allSettings = db.prepare(`SELECT guild_id, guild_name FROM guild_settings`).all();
    for (const s of allSettings) {
        const guild = client.guilds.cache.get(s.guild_id);
        if (!guild) continue;
        try {
            const member = await guild.members.fetch(req.user.id);
            if (member.permissions.has(PermissionFlagsBits.Administrator) || hasHelperRole(member, s)) allowedGuilds.push(s);
        } catch (e) {}
    }
    if (!allowedGuilds.some(g=>g.guild_id === snippet.guild_id)) return res.send(getErrorPage("Access Denied", "No Permission"));

    res.send(`<html>${getHead('Impulse | Edit Snippet')}<body class="bg-[#0b0f1a] text-slate-200 p-6"><div class="max-w-6xl mx-auto">${getNav('snippets', req.user)}<form method="POST" action="/snippets/edit/${snippet.id}" class="grid grid-cols-1 lg:grid-cols-2 gap-12"><div><input name="name" value="${snippet.name}" required class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white mb-4"><input id="inTitle" name="title" value="${snippet.title||''}" class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white mb-4"><textarea id="inDesc" name="description" class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white h-48 mb-4">${snippet.description||''}</textarea><input id="inImage" name="image_url" value="${snippet.image_url||''}" class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white mb-4"><input id="inThumb" name="thumbnail_url" value="${snippet.thumbnail_url||''}" class="w-full bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs text-white mb-4"><div class="flex gap-4"><button type="submit" class="flex-[2] bg-[#FFAA00] text-black py-4 rounded-xl font-black uppercase text-xs">Save</button><a href="/snippets" class="flex-1 bg-slate-800 text-slate-400 py-4 rounded-xl font-black uppercase text-xs text-center">Cancel</a></div></div><div id="preBorder" class="bg-[#2b2d31] border-l-[4px] border-[#FFAA00] p-3"><div id="preTitle" class="text-white font-bold"></div><div id="preDesc" class="text-[#dbdee1] text-sm whitespace-pre-wrap"></div></div></form></div><script>const i={t:document.getElementById('inTitle'),d:document.getElementById('inDesc')};const p={t:document.getElementById('preTitle'),d:document.getElementById('preDesc')};function upd(){p.t.innerText=i.t.value;p.d.innerText=i.d.value;}Object.values(i).forEach(el=>el.addEventListener('input',upd));upd();</script></body></html>`);
});

app.post('/snippets/new', express.urlencoded({ extended: true }), async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/auth/discord');
    const { guild_id, name, title, description, color, footer, url, image_url, thumbnail_url } = req.body;
    try {
        const guild = client.guilds.cache.get(guild_id);
        const member = await guild.members.fetch(req.user.id);
        if (!member.permissions.has(PermissionFlagsBits.Administrator) && !hasHelperRole(member, getSettings(guild_id))) return res.status(403).send("No Permission");
        db.prepare(`INSERT INTO snippets (guild_id, name, title, description, color, footer, url, image_url, thumbnail_url, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(guild_id, name.toLowerCase(), title, description, color, footer, url, image_url, thumbnail_url, req.user.id);
        logAction(guild_id, 'SNIPPET_CREATE', `Created snippet: ${name}`, req.user.id, req.user.username, `https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png`, '/snippet', null, null);
        res.redirect('/snippets');
    } catch (err) { res.status(500).send("Error"); }
});

app.post('/snippets/edit/:id', express.urlencoded({ extended: true }), async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/auth/discord');
    const snippet = db.prepare(`SELECT * FROM snippets WHERE id = ?`).get(req.params.id);
    if (!snippet || !(await canManageSnippet(req, snippet.guild_id))) return res.status(403).send("No Permission");
    const { name, title, description, footer, color, url, image_url, thumbnail_url } = req.body;
    db.prepare(`UPDATE snippets SET name=?, title=?, description=?, footer=?, color=?, url=?, image_url=?, thumbnail_url=? WHERE id=?`).run(name.toLowerCase(), title, description, footer, color, url, image_url, thumbnail_url, req.params.id);
    logAction(snippet.guild_id, 'SNIPPET_UPDATE', `Updated snippet: ${name}`, req.user.id, req.user.username, `https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png`, null, null);
    res.redirect('/snippets');
});

app.get('/snippets/delete/:id', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/auth/discord');
    const snippet = db.prepare(`SELECT * FROM snippets WHERE id = ?`).get(req.params.id);
    if (!snippet || !(await canManageSnippet(req, snippet.guild_id))) return res.status(403).send("No Permission");
    db.prepare(`DELETE FROM snippets WHERE id = ?`).run(req.params.id);
    logAction(snippet.guild_id, 'SNIPPET_DELETE', `Deleted snippet: ${snippet.name}`, req.user.id, req.user.username, `https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png`, null, null);
    res.redirect('/snippets');
});

app.get('/snippets/toggle/:id', async (req, res) => {
    const snippet = db.prepare(`SELECT * FROM snippets WHERE id = ?`).get(req.params.id);
    if (snippet && await canManageSnippet(req, snippet.guild_id)) db.prepare(`UPDATE snippets SET enabled = NOT enabled WHERE id = ?`).run(snippet.id);
    res.redirect('/snippets');
});

app.use((req, res) => res.status(404).send(getErrorPage("Not Found", "System Route Offline", "404")));

app.listen(3000, '0.0.0.0');

// --- BOT EVENTS ---
const IMPULSE_COLOR = 0xFFAA00;

client.once('ready', async (c) => {
    console.log(`✅ Logged in as ${c.user.tag}`);
    const twoWeeksAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
    const allSettings = db.prepare('SELECT * FROM guild_settings').all();
    for (const settings of allSettings) {
        try {
            const guild = client.guilds.cache.get(settings.guild_id);
            if (!guild) continue;
            const forumChannel = await guild.channels.fetch(settings.forum_id).catch(() => null);
            if (!forumChannel || !forumChannel.isThreadOnly()) continue;
            const threads = await forumChannel.threads.fetchActive();
            for (const [threadId, thread] of threads.threads) {
                if (thread.createdTimestamp && thread.createdTimestamp >= twoWeeksAgo) {
                    if (thread.appliedTags.includes(settings.resolved_tag)) continue;
                    const existing = db.prepare('SELECT * FROM thread_tracking WHERE thread_id = ?').get(threadId);
                    if (!existing) db.prepare('INSERT INTO thread_tracking (thread_id, guild_id, created_at) VALUES (?, ?, ?)').run(threadId, settings.guild_id, thread.createdTimestamp || Date.now());
                }
            }
        } catch (error) {}
    }
    setInterval(async () => {
        const rows = db.prepare('SELECT * FROM pending_locks WHERE lock_at <= ?').all(Date.now());
        for (const row of rows) {
            const settings = getSettings(row.guild_id);
            try {
                const thread = await client.channels.fetch(row.thread_id);
                if (thread) {
                    await thread.setAppliedTags([settings.resolved_tag]);
                    await thread.setLocked(true);
                    await thread.send({ embeds: [new EmbedBuilder().setTitle("🔒 Thread Locked").setDescription("This thread is now closed.").setColor(IMPULSE_COLOR)] });
                    logAction(row.guild_id, 'LOCK', `Locked thread: ${thread.name}`);
                }
            } catch (e) {}
            db.prepare('DELETE FROM pending_locks WHERE thread_id = ?').run(row.thread_id);
        }
    }, 60000);
    setInterval(checkStaleThreads, 6 * 60 * 60 * 1000);
    checkStaleThreads();
});

async function checkStaleThreads() {
    const warningThreshold = Date.now() - (24 * 24 * 60 * 60 * 1000);
    const closeThreshold = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const threadsNeedingWarning = db.prepare(`SELECT * FROM thread_tracking WHERE created_at <= ? AND stale_warning_sent = 0 AND (last_renewed_at IS NULL OR last_renewed_at <= ?)`).all(warningThreshold, warningThreshold);
    for (const tracked of threadsNeedingWarning) {
        try {
            const thread = await client.channels.fetch(tracked.thread_id).catch(() => null);
            if (!thread || thread.locked || thread.archived) continue;
            await thread.send({ content: `<@${thread.ownerId}>`, embeds: [new EmbedBuilder().setTitle("⚠️ Stale Warning").setDescription("Closing in 6 hours due to inactivity.").setColor(0xF59E0B)] });
            db.prepare('UPDATE thread_tracking SET stale_warning_sent = 1 WHERE thread_id = ?').run(tracked.thread_id);
        } catch (error) {}
    }
    const threadsToClose = db.prepare(`SELECT * FROM thread_tracking WHERE created_at <= ? AND stale_warning_sent = 1 AND (last_renewed_at IS NULL OR last_renewed_at <= ?)`).all(closeThreshold, closeThreshold);
    for (const tracked of threadsToClose) {
        try {
            const thread = await client.channels.fetch(tracked.thread_id).catch(() => null);
            if (thread && !thread.locked) {
                await thread.setLocked(true);
                await thread.send({ embeds: [new EmbedBuilder().setTitle("🔒 Closed").setDescription("Closed due to 30+ days of inactivity.").setColor(0x6B7280)] });
                logAction(tracked.guild_id, 'AUTO_CLOSE', `Closed stale thread: ${thread.name}`);
            }
            db.prepare('DELETE FROM thread_tracking WHERE thread_id = ?').run(tracked.thread_id);
        } catch (error) {}
    }
}

client.on('threadCreate', async (thread) => {
    const settings = getSettings(thread.guildId);
    if (!settings || thread.parentId !== settings.forum_id) return;
    db.prepare('INSERT OR REPLACE INTO thread_tracking (thread_id, guild_id, created_at) VALUES (?, ?, ?)').run(thread.id, thread.guildId, Date.now());
    if (settings.unanswered_tag) {
        try {
            const currentTags = thread.appliedTags || [];
            if (!currentTags.includes(settings.unanswered_tag)) await thread.setAppliedTags([...currentTags, settings.unanswered_tag]);
        } catch (e) {}
    }
    await thread.send({ embeds: [new EmbedBuilder().setTitle("Welcome!").setDescription("A helper will assist you shortly.").setColor(IMPULSE_COLOR)] });
});

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.channel.isThread()) return;
    const settings = getSettings(message.guildId);
    if (!settings || message.channel.parentId !== settings.forum_id) return;
    try {
        const currentTags = message.channel.appliedTags;
        if (currentTags.includes(settings.unanswered_tag) && message.author.id !== message.channel.ownerId) {
            await message.channel.setAppliedTags(currentTags.filter(tag => tag !== settings.unanswered_tag));
        }
    } catch (e) {}
    if (message.author.id === message.channel.ownerId) db.prepare('UPDATE thread_tracking SET stale_warning_sent = 0, last_renewed_at = ? WHERE thread_id = ?').run(Date.now(), message.channel.id);
});

client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch().catch(() => null);
    if (user.partial) await user.fetch().catch(() => null);
    if (reaction.emoji.name !== '🔗' || !reaction.message.channel.isThread()) return;
    const threadLink = db.prepare('SELECT * FROM thread_links WHERE thread_id = ?').get(reaction.message.channel.id);
    if (!threadLink) return;
    try { await reaction.users.remove(user.id); } catch (e) {}
    try {
        await user.send({ embeds: [new EmbedBuilder().setTitle("🔗 Link").setDescription(`Link: ${threadLink.url}`).setColor(0x3B82F6)] });
        logAction(threadLink.guild_id, 'LINK_ACCESSED', `${user.username} accessed link`, user.id, user.username, user.displayAvatarURL(), '🔗', reaction.message.channel.id, null);
    } catch (e) {
        const m = await reaction.message.channel.send(`<@${user.id}>, enable DMs!`);
        setTimeout(() => m.delete().catch(() => {}), 10000);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const settings = getSettings(interaction.guildId);
    const userId = interaction.user.id;
    const userName = interaction.user.username;
    const userAvatar = interaction.user.displayAvatarURL();

    if (interaction.commandName === 'setup') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: "❌ No Admin", ephemeral: true });
        const forum = interaction.options.getChannel('forum');
        const resTag = interaction.options.getString('resolved_tag');
        const dupTag = interaction.options.getString('duplicate_tag');
        const unansTag = interaction.options.getString('unanswered_tag') || null;
        const cleanRoles = interaction.options.getString('helper_roles').replace(/\s+/g, '');
        db.prepare(`INSERT OR REPLACE INTO guild_settings (guild_id, guild_name, forum_id, resolved_tag, duplicate_tag, unanswered_tag, helper_role_id) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(interaction.guildId, interaction.guild.name, forum.id, resTag, dupTag, unansTag, cleanRoles);
        logAction(interaction.guildId, 'SETUP', `Updated`, userId, userName, userAvatar, '/setup', null, null);
        return interaction.reply({ content: "✅ Setup Complete", ephemeral: true });
    }

    if (interaction.commandName === 'resolved') {
        const lockTime = Date.now() + (30 * 60 * 1000);
        db.prepare('INSERT OR REPLACE INTO pending_locks (thread_id, guild_id, lock_at) VALUES (?, ?, ?)').run(interaction.channelId, interaction.guildId, lockTime);
        const reply = await interaction.reply({ embeds: [new EmbedBuilder().setTitle("✅ Resolved").setDescription(`Locking <t:${Math.floor(lockTime/1000)}:R>`).setColor(0x10B981)], fetchReply: true });
        logAction(interaction.guildId, 'RESOLVED', `Marked resolved`, userId, userName, userAvatar, '/resolved', interaction.channelId, reply.id);
    }

    if (interaction.commandName === 'cancel') {
        const existing = db.prepare('SELECT * FROM pending_locks WHERE thread_id = ?').get(interaction.channelId);
        if (existing) {
            db.prepare('DELETE FROM pending_locks WHERE thread_id = ?').run(interaction.channelId);
            const reply = await interaction.reply({ content: "🔓 Cancelled", fetchReply: true });
            logAction(interaction.guildId, 'CANCEL', `Cancelled lock`, userId, userName, userAvatar, '/cancel', interaction.channelId, reply.id);
        } else {
            const tracked = db.prepare('SELECT * FROM thread_tracking WHERE thread_id = ?').get(interaction.channelId);
            if (tracked && tracked.stale_warning_sent === 1) {
                db.prepare('UPDATE thread_tracking SET stale_warning_sent = 0, last_renewed_at = ? WHERE thread_id = ?').run(Date.now(), interaction.channelId);
                const reply = await interaction.reply({ content: "♻️ Renewed", fetchReply: true });
                logAction(interaction.guildId, 'THREAD_RENEWED', `Renewed`, userId, userName, userAvatar, '/cancel', interaction.channelId, reply.id);
            } else return interaction.reply({ content: "❌ Nothing to cancel", ephemeral: true });
        }
    }

    if (interaction.commandName === 'duplicate') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator) && !hasHelperRole(interaction.member, settings)) return interaction.reply({ content: "❌ Denied", ephemeral: true });
        const link = interaction.options.getString('link');
        try {
            const tags = interaction.channel.appliedTags || [];
            await interaction.channel.setAppliedTags([...tags.filter(t=>t!==settings.unanswered_tag), settings.duplicate_tag]);
            const reply = await interaction.reply({ embeds: [new EmbedBuilder().setTitle("🔄 Duplicate").setDescription(`Original: ${link}`).setColor(0x0EA5E9)], fetchReply: true });
            await interaction.channel.setLocked(true);
            logAction(interaction.guildId, 'DUPLICATE', `Duplicate closed`, userId, userName, userAvatar, `/duplicate`, interaction.channelId, reply.id);
        } catch (e) { interaction.reply({ content: "⚠️ Error", ephemeral: true }); }
    }

    if (interaction.commandName === 'snippet') {
        const name = interaction.options.getString('name');
        const snippet = db.prepare(`SELECT * FROM snippets WHERE guild_id = ? AND name = ? AND enabled = 1`).get(interaction.guildId, name.toLowerCase());
        if (!snippet) return interaction.reply({ content: "❌ Not Found", ephemeral: true });
        const embed = new EmbedBuilder().setTitle(parseVars(snippet.title, interaction)).setDescription(parseVars(snippet.description, interaction)).setColor(snippet.color || "#FFAA00");
        if (snippet.image_url) embed.setImage(snippet.image_url);
        if (snippet.thumbnail_url) embed.setThumbnail(snippet.thumbnail_url);
        if (snippet.footer) embed.setFooter({ text: parseVars(snippet.footer, interaction) });
        logAction(interaction.guildId, 'SNIPPET', `Used ${name}`, userId, userName, userAvatar, `/snippet`, interaction.channelId, null);
        return interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === 'link') {
        if (!interaction.channel.isThread() || interaction.user.id !== interaction.channel.ownerId) return interaction.reply({ content: "❌ Owner only", ephemeral: true });
        const url = interaction.options.getString('url');
        db.prepare(`INSERT OR REPLACE INTO thread_links (thread_id, guild_id, url, created_by, created_at) VALUES (?, ?, ?, ?, ?)`).run(interaction.channelId, interaction.guildId, url, interaction.user.id, Date.now());
        await interaction.reply({ content: "🔗 Link added" });
        const sm = await interaction.channel.fetchStarterMessage();
        if (sm) await sm.react('🔗');
        logAction(interaction.guildId, 'LINK_ADDED', `Added link`, userId, userName, userAvatar, `/link`, interaction.channelId, null);
    }
});

client.login(process.env.DISCORD_TOKEN);