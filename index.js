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
db.prepare('CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, action TEXT, details TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)').run();

// --- HELPERS ---
const getSettings = (guildId) => db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId);
const logAction = (guildId, action, details) => db.prepare('INSERT INTO audit_logs (guild_id, action, details) VALUES (?, ?, ?)').run(guildId, action, details);

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
        <meta name="viewport" content="width=device-width, initial-scale=1.0"> <title>${title}</title>
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

const getActionColor = (action) => {
    const colors = {
        'SETUP': 'bg-amber-500/10 text-amber-500 border-amber-500/20',
        'DUPLICATE': 'bg-sky-500/10 text-sky-500 border-sky-500/20',
        'RESOLVED': 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
        'LOCK': 'bg-rose-500/10 text-rose-500 border-rose-500/20',
        'GREET': 'bg-slate-500/10 text-slate-400 border-slate-500/20'
    };
    return colors[action] || 'bg-slate-800 text-slate-400 border-slate-700';
};

// MAIN DASHBOARD
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
                            <p class="text-xs text-slate-400 font-mono"><span class="text-[#FFAA00]">SECURE:</span> OAuth2 Protocol active. Mission Control requires Admin or Helper clearance.</p>
                        </div>
                    </div>

                    <a href="/auth/discord" class="w-full text-center bg-[#FFAA00] hover:bg-[#ffbb33] text-black py-4 rounded-xl font-black text-xs uppercase tracking-widest transition-all shadow-[0_0_15px_rgba(255,170,0,0.2)] block">
                        Establish Connection
                    </a>
                    
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

    const logs = db.prepare(`SELECT audit_logs.*, guild_settings.guild_name FROM audit_logs JOIN guild_settings ON audit_logs.guild_id = guild_settings.guild_id ORDER BY timestamp DESC LIMIT 10`).all();

    res.send(`
    <html>
    ${getHead('Impulse | Mission Control')}
    <body class="bg-[#0b0f1a] text-slate-200 min-h-screen p-4 md:p-8">
        <div class="max-w-6xl mx-auto">
            <header class="flex flex-col md:flex-row justify-between items-center mb-10 gap-6">
                <div class="flex items-center gap-4">
                    <img src="${botAvatar}" class="w-12 h-12 md:w-14 md:h-14 rounded-full border-2 border-[#FFAA00] shadow-[0_0_15px_rgba(255,170,0,0.4)]">
                    <div>
                        <h1 class="text-2xl md:text-3xl font-extrabold text-white tracking-tighter leading-none">IMPULSE</h1>
                        <span class="text-[#FFAA00] text-[10px] md:text-xs font-mono tracking-[0.3em] uppercase">Mission Control</span>
                    </div>
                </div>
                <div class="flex items-center gap-3 bg-slate-900/80 p-2 pr-5 rounded-full border border-slate-800">
                    <img src="${userAvatar}" class="w-8 h-8 md:w-10 md:h-10 rounded-full border border-[#FFAA00]/50">
                    <div class="flex flex-col">
                        <span class="text-xs md:text-sm font-bold text-white leading-none">${req.user.username}</span>
                        <a href="/logout" class="text-[9px] text-rose-500 hover:underline uppercase font-bold tracking-widest mt-1">Disconnect</a>
                    </div>
                </div>
            </header>

            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-10">
                ${authorizedGuilds.map(s => `
                    <div class="bg-slate-900/40 backdrop-blur-md p-6 rounded-2xl border border-amber glow-amber">
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
                    ${logs.map(l => `
                        <div class="p-4 hover:bg-[#FFAA00]/5 transition flex items-center gap-3">
                            <div class="hidden md:block text-[10px] mono text-slate-600 w-16 text-right">${new Date(l.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</div>
                            <div class="px-2 py-0.5 rounded text-[8px] font-black mono ${getActionColor(l.action)} border shrink-0">${l.action}</div>
                        </div>
                    `).join('')}
                </div>
            </div>
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
            setInterval(updateTimers, 1000); updateTimers();
        </script>
    </body></html>`);
});

// FULL LOGS PAGE WITH SEARCH, FILTER, AND SERVER SORT
// LOGS PAGE WITH RESPONSIVE TABLE :D
app.get('/logs', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/auth/discord');
    const allLogs = db.prepare(`SELECT audit_logs.*, guild_settings.guild_name FROM audit_logs LEFT JOIN guild_settings ON audit_logs.guild_id = guild_settings.guild_id ORDER BY timestamp DESC LIMIT 100`).all();
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
                <input type="text" id="logSearch" placeholder="Search archive..." class="bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-[#FFAA00] transition w-full md:w-64">
            </div>

            <div class="space-y-6 mb-8">
                <div>
                    <p class="text-[8px] uppercase font-black text-slate-600 mb-2 tracking-[0.2em]">Filter: Action</p>
                    <div class="flex gap-2 overflow-x-auto pb-2 no-scrollbar">
                        <button onclick="filterType('ALL')" class="type-btn shrink-0 bg-[#FFAA00] text-black px-4 py-1.5 rounded-full text-[9px] font-black uppercase tracking-tighter">ALL</button>
                        <button onclick="filterType('SETUP')" class="type-btn shrink-0 bg-slate-800 text-slate-400 px-4 py-1.5 rounded-full text-[9px] font-black uppercase hover:text-white tracking-tighter">SETUP</button>
                        <button onclick="filterType('LOCK')" class="type-btn shrink-0 bg-slate-800 text-slate-400 px-4 py-1.5 rounded-full text-[9px] font-black uppercase hover:text-white tracking-tighter">LOCK</button>
                        <button onclick="filterType('DUPLICATE')" class="type-btn shrink-0 bg-slate-800 text-slate-400 px-4 py-1.5 rounded-full text-[9px] font-black uppercase hover:text-white tracking-tighter">DUPLICATE</button>
                    </div>
                </div>

                <div>
                    <p class="text-[8px] uppercase font-black text-slate-600 mb-2 tracking-[0.2em]">Filter: Server</p>
                    <div class="flex gap-2 overflow-x-auto pb-2 no-scrollbar">
                        <button onclick="filterServer('ALL')" class="srv-btn shrink-0 bg-[#FFAA00] text-black px-4 py-1.5 rounded-full text-[9px] font-black uppercase tracking-tighter">ALL SOURCES</button>
                        ${uniqueServers.map(srv => `
                            <button onclick="filterServer('${srv}')" class="srv-btn shrink-0 bg-slate-800 text-slate-400 px-4 py-1.5 rounded-full text-[9px] font-black uppercase hover:text-white tracking-tighter">${srv}</button>
                        `).join('')}
                    </div>
                </div>
            </div>

            <div class="bg-slate-900/40 border border-slate-800 rounded-2xl overflow-x-auto backdrop-blur-sm shadow-xl">
                <table class="w-full text-left border-collapse min-w-[600px] md:min-w-0">
                    <thead class="bg-black/40 text-[9px] uppercase font-black tracking-widest text-slate-500">
                        <tr>
                            <th class="p-4 border-b border-slate-800">Origin</th>
                            <th class="p-4 border-b border-slate-800">Action</th>
                            <th class="p-4 border-b border-slate-800">Details</th>
                            <th class="p-4 border-b border-slate-800">Time</th>
                        </tr>
                    </thead>
                    <tbody id="logTableBody" class="divide-y divide-slate-800/40 mono text-[11px]">
                        ${allLogs.map(l => `
                            <tr class="log-row hover:bg-[#FFAA00]/5 transition" data-action="${l.action}" data-server="${l.guild_name}">
                                <td class="p-4 text-slate-300 font-sans font-bold">${l.guild_name || 'N/A'}</td>
                                <td class="p-4">
                                    <span class="${getActionColor(l.action)} px-2 py-0.5 rounded border font-black uppercase text-[10px]">
                                        ${l.action}
                                    </span>
                                </td>
                                <td class="p-4 text-slate-400 font-sans truncate max-w-[200px] md:max-w-none">${l.details}</td>
                                <td class="p-4 text-[10px] text-slate-600">${new Date(l.timestamp).toLocaleDateString([], {month:'short', day:'numeric'})}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
        <script>
            let currentType = 'ALL';
            let currentServer = 'ALL';
            const search = document.getElementById('logSearch');
            const rows = document.querySelectorAll('.log-row');

            function applyFilters() {
                const term = search.value.toLowerCase();
                rows.forEach(row => {
                    const typeMatch = currentType === 'ALL' || row.getAttribute('data-action') === currentType;
                    const serverMatch = currentServer === 'ALL' || row.getAttribute('data-server') === currentServer;
                    const textMatch = row.innerText.toLowerCase().includes(term);
                    
                    row.style.display = (typeMatch && serverMatch && textMatch) ? '' : 'none';
                });
            }

            search.addEventListener('keyup', applyFilters);

            function filterType(type) {
                currentType = type;
                document.querySelectorAll('.type-btn').forEach(b => b.classList.replace('bg-[#FFAA00]', 'bg-slate-800'));
                document.querySelectorAll('.type-btn').forEach(b => b.classList.replace('text-black', 'text-slate-400'));
                event.target.classList.replace('bg-slate-800', 'bg-[#FFAA00]');
                event.target.classList.replace('text-slate-400', 'text-black');
                applyFilters();
            }

            function filterServer(srv) {
                currentServer = srv;
                document.querySelectorAll('.srv-btn').forEach(b => b.classList.replace('bg-[#FFAA00]', 'bg-slate-800'));
                document.querySelectorAll('.srv-btn').forEach(b => b.classList.replace('text-black', 'text-slate-400'));
                event.target.classList.replace('bg-slate-800', 'bg-[#FFAA00]');
                event.target.classList.replace('text-slate-400', 'text-black');
                applyFilters();
            }
        </script>
    </body></html>`);
});

app.listen(3000, '0.0.0.0');

// --- BOT EVENTS ---
client.once('clientReady', (c) => {
    console.log(`✅ Logged in as ${c.user.tag}`);
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
                    await thread.send("🔒 **Post Locked.** This thread is now closed.");
                    logAction(row.guild_id, 'LOCK', `Locked thread: ${thread.name}`);
                }
            } catch (e) { console.error("Lock error:", e); }
            db.prepare('DELETE FROM pending_locks WHERE thread_id = ?').run(row.thread_id);
        }
    }, 60000);
});

client.on('threadCreate', async (thread) => {
    const settings = getSettings(thread.guildId);
    if (!settings || thread.parentId !== settings.forum_id) return;

    await thread.send({
        content: `Welcome <@${thread.ownerId}>!`,
        embeds: [new EmbedBuilder().setTitle("Help Guidelines").setDescription("A helper will be with you soon. Use **/resolved** when done.").setColor(0x5865F2)]
    });
    logAction(thread.guildId, 'GREET', `Welcomed user in ${thread.name}`);
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const settings = getSettings(interaction.guildId);

    if (interaction.commandName === 'setup') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply("Admins only.");
            
            const forum = interaction.options.getChannel('forum');
            const resTag = interaction.options.getString('resolved_tag');
            const dupTag = interaction.options.getString('duplicate_tag');
            
            // CLEANING LOGIC: This removes all spaces and ensures it's just IDs and commas
            const rawRoles = interaction.options.getString('helper_roles');
            const cleanRoles = rawRoles.replace(/\s+/g, ''); 

            db.prepare(`INSERT OR REPLACE INTO guild_settings (guild_id, guild_name, forum_id, resolved_tag, duplicate_tag, helper_role_id) VALUES (?, ?, ?, ?, ?, ?)`).run(
                interaction.guildId, 
                interaction.guild.name, 
                forum.id, 
                resTag, 
                dupTag, 
                cleanRoles
            );

            logAction(interaction.guildId, 'SETUP', `Setup updated with Roles: ${cleanRoles}`);
            
            return interaction.reply({ 
                content: `✅ **Setup Complete!**\nMonitoring: <#${forum.id}>\nHelpers: ${cleanRoles.split(',').map(id => `<@&${id}>`).join(' ')}`, 
                ephemeral: true 
            });
    }

    if (interaction.commandName === 'info') {
        if (!settings) return interaction.reply("❌ This server is not set up.");
        const embed = new EmbedBuilder().setTitle("Bot Configuration Status").addFields({ name: "Forum Channel", value: `<#${settings.forum_id}>`, inline: true }, { name: "Helper Roles", value: settings.helper_role_id.split(',').map(id => `<@&${id}>`).join(', '), inline: true }, { name: "Active Timers", value: db.prepare('SELECT COUNT(*) as count FROM pending_locks WHERE guild_id = ?').get(interaction.guildId).count.toString(), inline: true }).setColor(0x38BDF8);
        return interaction.reply({ embeds: [embed] });
    }

    if (!settings) return interaction.reply({ content: "Please run \`/setup\` first.", ephemeral: true });

    if (interaction.commandName === 'resolved') {
        const lockTime = Date.now() + (30 * 60 * 1000);
        db.prepare('INSERT OR REPLACE INTO pending_locks (thread_id, guild_id, lock_at) VALUES (?, ?, ?)').run(interaction.channelId, interaction.guildId, lockTime);
        logAction(interaction.guildId, 'RESOLVED', `Marked thread for locking: ${interaction.channel.name}`);
        await interaction.reply("✅ Thread marked as **Resolved**. Locking in 30 minutes.");
    }

  if (interaction.commandName === 'duplicate') {
          // Check if user is Admin OR has the Helper Role
          const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
          const isHelper = hasHelperRole(interaction.member, settings);

          if (!isAdmin && !isHelper) {
              return interaction.reply({ 
                  content: "❌ Access Denied. You need a **Helper Role** or **Administrator** permissions.", 
                  ephemeral: true 
              });
          }

          const link = interaction.options.getString('link');
          
          try {
              // Apply duplicate tag and lock
              await interaction.channel.setAppliedTags([settings.duplicate_tag]);
              await interaction.reply({ 
                  embeds: [new EmbedBuilder()
                      .setTitle("Thread Closed: Duplicate")
                      .setDescription(`This topic has already been addressed here: ${link}`)
                      .setColor(0xFFA500)
                      .setTimestamp()] 
              });
              
              await interaction.channel.setLocked(true);
              logAction(interaction.guildId, 'DUPLICATE', `Closed duplicate: ${interaction.channel.name}`);
          } catch (e) {
              console.error(e);
              interaction.followUp({ content: "Failed to apply tags/lock. Check bot permissions.", ephemeral: true });
          }
    }
});

client.login(process.env.DISCORD_TOKEN);