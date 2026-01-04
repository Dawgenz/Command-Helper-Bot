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
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// --- DB INIT ---
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

// Check if user has one of the allowed roles
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
    store: new SQLiteStore({ db: 'database.db', table: 'sessions' }),
    secret: process.env.SESSION_SECRET || 'keyboard cat',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 1 week
}));
app.use(passport.initialize());
app.use(passport.session());

// --- AUTH ROUTES ---
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
});

// --- DASHBOARD (PROTECTED) ---
app.get('/', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.send(`
            <html>
            <script src="https://cdn.tailwindcss.com"></script>
            <body class="bg-slate-900 text-white flex items-center justify-center h-screen">
                <div class="text-center p-10 bg-slate-800 rounded-2xl shadow-2xl border border-slate-700">
                    <h1 class="text-4xl font-bold mb-6 text-sky-400 tracking-tight">Impulse Mission Control</h1>
                    <a href="/auth/discord" class="bg-indigo-600 hover:bg-indigo-500 transition px-8 py-3 rounded-lg font-bold text-lg inline-block">Login with Discord</a>
                </div>
            </body></html>`);
    }

    const allSettings = db.prepare(`SELECT * FROM guild_settings`).all();
    const authorizedGuilds = [];

    for (const settings of allSettings) {
        const guild = client.guilds.cache.get(settings.guild_id);
        if (!guild) continue;
        try {
            const member = await guild.members.fetch(req.user.id);
            if (member.permissions.has(PermissionFlagsBits.Administrator) || hasHelperRole(member, settings)) {
                const timers = db.prepare('SELECT COUNT(*) as count FROM pending_locks WHERE guild_id = ?').get(settings.guild_id).count;
                authorizedGuilds.push({ ...settings, active_timers: timers });
            }
        } catch (e) {}
    }

    const logs = db.prepare(`SELECT audit_logs.*, guild_settings.guild_name FROM audit_logs JOIN guild_settings ON audit_logs.guild_id = guild_settings.guild_id ORDER BY timestamp DESC LIMIT 8`).all();

    res.send(`
    <html>
    <head><script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-slate-900 text-slate-200 min-h-screen p-8">
        <div class="max-w-6xl mx-auto">
            <header class="flex justify-between items-center mb-10">
                <div>
                    <h1 class="text-3xl font-extrabold text-white">Impulse <span class="text-sky-400">Mission Control</span></h1>
                    <p class="text-slate-400">Welcome back, ${req.user.username}</p>
                </div>
                <a href="/logout" class="text-rose-400 hover:text-rose-300 font-medium">Logout</a>
            </header>

            <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
                ${authorizedGuilds.map(s => `
                    <div class="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
                        <h3 class="text-slate-400 uppercase text-xs font-bold tracking-widest mb-2">${s.guild_name}</h3>
                        <div class="text-4xl font-bold text-emerald-400">${s.active_timers}</div>
                        <div class="text-sm text-slate-500 mt-1">Active Auto-Lock Timers</div>
                    </div>
                `).join('')}
            </div>

            <div class="bg-slate-800 rounded-xl border border-slate-700 shadow-lg overflow-hidden">
                <div class="p-6 border-b border-slate-700 flex justify-between items-center">
                    <h2 class="text-xl font-bold text-white">Recent Activity</h2>
                    <a href="/logs" class="text-sky-400 text-sm hover:underline">View All Logs</a>
                </div>
                <div class="divide-y divide-slate-700">
                    ${logs.map(l => `
                        <div class="p-4 hover:bg-slate-750 transition">
                            <span class="text-sky-500 font-mono text-xs uppercase mr-4">${l.action}</span>
                            <span class="text-slate-300">${l.details}</span>
                            <span class="text-slate-500 text-xs float-right italic">${new Date(l.timestamp).toLocaleTimeString()}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>
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
    if (interaction.isChatInputCommand()) {
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
            
            const embed = new EmbedBuilder()
                .setTitle("Bot Configuration Status")
                .addFields(
                    { name: "Forum Channel", value: `<#${settings.forum_id}>`, inline: true },
                    { name: "Helper Roles", value: settings.helper_role_id.split(',').map(id => `<@&${id}>`).join(', '), inline: true },
                    { name: "Active Timers", value: db.prepare('SELECT COUNT(*) as count FROM pending_locks WHERE guild_id = ?').get(interaction.guildId).count.toString(), inline: true }
                )
                .setColor(0x38BDF8);
                
            return interaction.reply({ embeds: [embed] });
        }

        if (!settings) return interaction.reply({ content: "Please run `/setup` first.", ephemeral: true });

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
    }

    if (interaction.isButton() && interaction.customId === 'keep_open') {
        db.prepare('DELETE FROM pending_locks WHERE thread_id = ?').run(interaction.channelId);
        logAction(interaction.guildId, 'BUTTON', `Cancelled closure for ${interaction.channel.name}`);
        await interaction.update({ content: "✅ Closure cancelled.", components: [] });
    }
});

client.login(process.env.DISCORD_TOKEN);