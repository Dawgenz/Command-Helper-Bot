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

const hasHelperRole = (member, settings) => {
    if (!settings || !settings.helper_role_id) return false;
    const allowedRoles = settings.helper_role_id.split(',');
    return member.roles.cache.some(role => allowedRoles.includes(role.id));
};

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

// MAIN DASHBOARD
app.get('/', async (req, res) => {
    if (!req.isAuthenticated()) {
        // ... (Login page stays mostly the same, just update the sky-400 to [#FFAA00])
        return res.send(`<html><script src="https://cdn.tailwindcss.com"></script><body class="bg-slate-950 text-white flex items-center justify-center h-screen"><div class="text-center p-10 bg-slate-900 rounded-2xl shadow-2xl border border-[#FFAA00]/20"><h1 class="text-4xl font-bold mb-6 text-[#FFAA00]">Impulse Bot Dashboard</h1><a href="/auth/discord" class="bg-[#FFAA00] hover:bg-[#cc8800] text-black transition px-8 py-3 rounded-lg font-bold text-lg inline-block">Login with Discord</a></div></body></html>`);
    }

    const botAvatar = client.user.displayAvatarURL();
    const allSettings = db.prepare(`SELECT * FROM guild_settings`).all();
    const authorizedGuilds = [];

    for (const settings of allSettings) {
        const guild = client.guilds.cache.get(settings.guild_id);
        if (!guild) continue;
        try {
            const member = await guild.members.fetch(req.user.id);
            if (member.permissions.has(PermissionFlagsBits.Administrator) || hasHelperRole(member, settings)) {
                // Fetch the actual timers for this guild
                const timers = db.prepare('SELECT thread_id, lock_at FROM pending_locks WHERE guild_id = ?').all(settings.guild_id);
                authorizedGuilds.push({ ...settings, timers });
            }
        } catch (e) {}
    }

    const logs = db.prepare(`SELECT audit_logs.*, guild_settings.guild_name FROM audit_logs JOIN guild_settings ON audit_logs.guild_id = guild_settings.guild_id ORDER BY timestamp DESC LIMIT 8`).all();

    res.send(`
    <html>
    <head>
        <title>Impulse Bot | Dashboard</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            .glow { box-shadow: 0 0 15px rgba(255, 170, 0, 0.1); }
            .border-amber { border-color: rgba(255, 170, 0, 0.3); }
        </style>
    </head>
    <body class="bg-[#0b0f1a] text-slate-200 min-h-screen p-8">
        <div class="max-w-6xl mx-auto">
            <header class="flex justify-between items-center mb-10">
                <div class="flex items-center gap-4">
                    <img src="${botAvatar}" class="w-12 h-12 rounded-full border-2 border-[#FFAA00] shadow-[0_0_10px_#FFAA00]">
                    <h1 class="text-3xl font-extrabold text-white tracking-tighter">IMPULSE <span class="text-[#FFAA00] text-xl font-mono ml-2">v2.0</span></h1>
                </div>
                <div class="flex items-center gap-4 text-sm font-medium">
                    <span class="bg-slate-800 px-3 py-1 rounded-full border border-slate-700">Logged as ${req.user.username}</span>
                    <a href="/logout" class="text-rose-500 hover:text-rose-400 transition">Logout</a>
                </div>
            </header>

            <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
                ${authorizedGuilds.map(s => `
                    <div class="bg-slate-900/50 p-6 rounded-xl border border-amber glow">
                        <h3 class="text-[#FFAA00] uppercase text-xs font-bold mb-4 tracking-widest">${s.guild_name}</h3>
                        <div class="space-y-3">
                            ${s.timers.length > 0 ? s.timers.map(t => `
                                <div class="flex justify-between items-center bg-black/30 p-2 rounded border border-slate-800">
                                    <span class="text-xs font-mono text-slate-400">#${t.thread_id.slice(-4)}</span>
                                    <span class="text-xs font-bold text-emerald-400" data-expire="${t.lock_at}">Calculating...</span>
                                </div>
                            `).join('') : '<div class="text-slate-600 text-xs italic">No active timers</div>'}
                        </div>
                    </div>`).join('')}
            </div>

            <div class="bg-slate-900/50 rounded-xl border border-slate-800 overflow-hidden shadow-2xl">
                <div class="p-6 border-b border-slate-800 flex justify-between items-center">
                    <h2 class="text-xl font-bold text-white">Audit Log Feed</h2>
                    <a href="/logs" class="bg-[#FFAA00]/10 text-[#FFAA00] px-4 py-1 rounded hover:bg-[#FFAA00]/20 transition text-xs font-bold">VIEW ALL</a>
                </div>
                <div class="divide-y divide-slate-800/50 font-mono">
                    ${logs.map(l => `<div class="p-4 hover:bg-[#FFAA00]/5 transition text-sm flex gap-4">
                        <span class="text-[#FFAA00] opacity-50 text-xs">[${new Date(l.timestamp).toLocaleTimeString()}]</span>
                        <span class="text-[#FFAA00] font-bold underline decoration-dotted">${l.action}</span>
                        <span class="text-slate-400">${l.details}</span>
                    </div>`).join('')}
                </div>
            </div>
        </div>

        <script>
            function updateTimers() {
                document.querySelectorAll('[data-expire]').forEach(el => {
                    const expire = parseInt(el.getAttribute('data-expire'));
                    const now = Date.now();
                    const diff = expire - now;
                    if (diff <= 0) {
                        el.innerText = "LOCKING...";
                        el.classList.replace('text-emerald-400', 'text-rose-500');
                    } else {
                        const mins = Math.floor(diff / 60000);
                        const secs = Math.floor((diff % 60000) / 1000);
                        el.innerText = mins + "m " + secs + "s";
                    }
                });
            }
            setInterval(updateTimers, 1000);
            updateTimers();
        </script>
    </body></html>`);
});

// FULL LOGS PAGE
app.get('/logs', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/auth/discord');
    const allLogs = db.prepare(`SELECT audit_logs.*, guild_settings.guild_name FROM audit_logs LEFT JOIN guild_settings ON audit_logs.guild_id = guild_settings.guild_id ORDER BY timestamp DESC LIMIT 100`).all();
    res.send(`<html><head><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-slate-900 text-slate-200 p-8"><div class="max-w-4xl mx-auto text-white">
        <a href="/" class="text-sky-400 hover:underline text-sm font-bold tracking-tight">← BACK TO DASHBOARD</a>
        <h1 class="text-3xl font-bold mt-4 mb-8">Full Audit Logs</h1>
        <div class="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden text-sm"><table class="w-full text-left">
            <thead class="bg-slate-700 text-slate-400 text-xs uppercase"><tr class="font-bold tracking-widest"><th class="p-4">Server</th><th class="p-4">Action</th><th class="p-4">Details</th><th class="p-4">Time</th></tr></thead>
            <tbody class="divide-y divide-slate-700">${allLogs.map(l => `<tr class="hover:bg-slate-750 transition"><td class="p-4">${l.guild_name || 'N/A'}</td><td class="p-4 font-mono text-sky-400">${l.action}</td><td class="p-4 text-slate-400">${l.details}</td><td class="p-4 text-xs text-slate-500">${new Date(l.timestamp).toLocaleString()}</td></tr>`).join('')}</tbody>
        </table></div></div></body></html>`);
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
        const forumId = interaction.options.getString('forum_id');
        const resTag = interaction.options.getString('resolved_tag');
        const dupTag = interaction.options.getString('duplicate_tag');
        const rolesString = interaction.options.getString('helper_roles').replace(/\s/g, '');

        db.prepare(`INSERT OR REPLACE INTO guild_settings (guild_id, guild_name, forum_id, resolved_tag, duplicate_tag, helper_role_id) VALUES (?, ?, ?, ?, ?, ?)`).run(interaction.guildId, interaction.guild.name, forumId, resTag, dupTag, rolesString);
        logAction(interaction.guildId, 'SETUP', `Updated config with roles: ${rolesString}`);
        return interaction.reply("✅ Server configuration updated successfully!");
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
        if (!hasHelperRole(interaction.member, settings)) return interaction.reply("You do not have a Helper Role.");
        const link = interaction.options.getString('link');
        await interaction.channel.setAppliedTags([settings.duplicate_tag]);
        await interaction.reply({ embeds: [new EmbedBuilder().setTitle("Duplicate").setDescription(`Addressed here: ${link}`).setColor(0xFFA500)] });
        await interaction.channel.setLocked(true);
        logAction(interaction.guildId, 'DUPLICATE', `Closed duplicate: ${interaction.channel.name}`);
    }
});

client.login(process.env.DISCORD_TOKEN);