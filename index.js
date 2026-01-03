require('dotenv').config();
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const Database = require('better-sqlite3');
const express = require('express');

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

// --- DASHBOARD ---
app.get('/', (req, res) => {
    const stats = db.prepare(`SELECT guild_name, (SELECT COUNT(*) FROM pending_locks WHERE pending_locks.guild_id = guild_settings.guild_id) as active_timers FROM guild_settings`).all();
    const logs = db.prepare(`SELECT audit_logs.*, guild_settings.guild_name FROM audit_logs JOIN guild_settings ON audit_logs.guild_id = guild_settings.guild_id ORDER BY timestamp DESC LIMIT 10`).all();
    res.send(`<html><head><title>Impulse Dashboard</title><style>body{font-family:sans-serif;background:#0f172a;color:#f8fafc;padding:40px;} .card{background:#1e293b;padding:20px;border-radius:10px;margin-bottom:20px;border:1px solid #334155;} .log{font-size:0.9rem;border-bottom:1px solid #334155;padding:5px 0;} h1,h2{color:#38bdf8;}</style></head><body><h1>Mission Control</h1><div style="display:flex;gap:20px;">${stats.map(s=>`<div class="card"><h3>${s.guild_name}</h3><div style="font-size:2rem;color:#10b981;">${s.active_timers}</div>Active Timers</div>`).join('')}</div><div class="card"><h2>Recent Activity</h2>${logs.map(l=>`<div class="log"><strong style="color:#38bdf8;">${l.guild_name}</strong>: ${l.details}</div>`).join('')}</div></body></html>`);
});
app.listen(3000, '0.0.0.0');

// --- BOT EVENTS ---
client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    // Auto-lock checker
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

// Dynamic Greeting
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
            const roleId = interaction.options.getRole('helper_role').id;

            db.prepare(`INSERT OR REPLACE INTO guild_settings (guild_id, guild_name, forum_id, resolved_tag, duplicate_tag, helper_role_id) VALUES (?, ?, ?, ?, ?, ?)`).run(interaction.guildId, interaction.guild.name, forumId, resTag, dupTag, roleId);
            logAction(interaction.guildId, 'SETUP', 'Updated configuration');
            return interaction.reply("✅ Server configuration updated!");
        }

        if (!settings) return interaction.reply({ content: "Please run `/setup` first to configure this server.", ephemeral: true });

        if (interaction.commandName === 'resolved') {
            const lockTime = Date.now() + (30 * 60 * 1000);
            db.prepare('INSERT OR REPLACE INTO pending_locks (thread_id, guild_id, lock_at) VALUES (?, ?, ?)').run(interaction.channelId, interaction.guildId, lockTime);
            logAction(interaction.guildId, 'RESOLVED', `Marked thread for locking: ${interaction.channel.name}`);
            await interaction.reply("✅ Thread marked as **Resolved**. Locking in 30 minutes.");
        }

        if (interaction.commandName === 'duplicate') {
            if (!interaction.member.roles.cache.has(settings.helper_role_id)) return interaction.reply("Missing Helper Role.");
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