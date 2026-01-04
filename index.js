require('dotenv').config();
const { Client, GatewayIntentBits, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const Database = require('better-sqlite3');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { Strategy } = require('passport-discord');

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
    secret: process.env.SESSION_SECRET || 'keyboard cat',
    resave: false,
    saveUninitialized: false
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
        return res.send(`<html><body style="background:#0f172a;color:white;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;">
            <div style="text-align:center;"><h1>Impulse Dashboard</h1><a href="/auth/discord" style="background:#5865F2;color:white;padding:15px 25px;border-radius:5px;text-decoration:none;font-weight:bold;">Login with Discord</a></div>
        </body></html>`);
    }

    // Filter servers: Only show those where the user is an Admin or has a Helper Role
    const allSettings = db.prepare(`SELECT * FROM guild_settings`).all();
    const authorizedGuilds = [];

    for (const settings of allSettings) {
        try {
            const guild = await client.guilds.fetch(settings.guild_id);
            const member = await guild.members.fetch(req.user.id);
            
            if (member.permissions.has(PermissionFlagsBits.Administrator) || hasHelperRole(member, settings)) {
                const activeTimers = db.prepare('SELECT COUNT(*) as count FROM pending_locks WHERE guild_id = ?').get(settings.guild_id).count;
                authorizedGuilds.push({ ...settings, active_timers: activeTimers });
            }
        } catch (e) { /* User not in this guild or fetch failed */ }
    }

    const logs = db.prepare(`SELECT audit_logs.*, guild_settings.guild_name FROM audit_logs JOIN guild_settings ON audit_logs.guild_id = guild_settings.guild_id ORDER BY timestamp DESC LIMIT 10`).all();

    res.send(`<html><head><title>Impulse Dashboard</title><style>body{font-family:sans-serif;background:#0f172a;color:#f8fafc;padding:40px;} .card{background:#1e293b;padding:20px;border-radius:10px;margin-bottom:20px;border:1px solid #334155;} .log{font-size:0.9rem;border-bottom:1px solid #334155;padding:5px 0;} h1,h2{color:#38bdf8;} .btn-logout{float:right;color:#ef4444;text-decoration:none;font-size:0.9rem;}</style></head><body>
        <a href="/logout" class="btn-logout">Logout</a>
        <h1>Mission Control</h1>
        <p>Logged in as: <strong>${req.user.username}</strong></p>
        <div style="display:flex;gap:20px;flex-wrap:wrap;">
            ${authorizedGuilds.length > 0 ? authorizedGuilds.map(s => `
                <div class="card">
                    <h3>${s.guild_name}</h3>
                    <div style="font-size:2rem;color:#10b981;">${s.active_timers}</div>
                    Active Timers
                </div>`).join('') : '<p>No servers found where you have staff permissions.</p>'}
        </div>
        <div class="card"><h2>Recent Activity</h2>${logs.map(l => `<div class="log"><strong style="color:#38bdf8;">${l.guild_name}</strong>: ${l.details}</div>`).join('')}</div>
    </body></html>`);
});

app.listen(3000, '0.0.0.0');

// --- BOT EVENTS ---
client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
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