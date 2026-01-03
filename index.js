require('dotenv').config();
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const Database = require('better-sqlite3');
const express = require('express');

const db = new Database('database.db');
const app = express();
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// --- DATABASE INITIALIZATION ---
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
    const stats = db.prepare(`
        SELECT guild_name, COUNT(pending_locks.thread_id) as active_timers 
        FROM guild_settings 
        LEFT JOIN pending_locks ON guild_settings.guild_id = pending_locks.guild_id 
        GROUP BY guild_settings.guild_id
    `).all();

    const logs = db.prepare(`
        SELECT audit_logs.*, guild_settings.guild_name 
        FROM audit_logs 
        JOIN guild_settings ON audit_logs.guild_id = guild_settings.guild_id 
        ORDER BY timestamp DESC LIMIT 10
    `).all();

    res.send(`
    <html>
    <head>
        <title>Impulse Bot Multi-Dashboard</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { font-family: 'Segoe UI', sans-serif; background: #0f172a; color: #f8fafc; padding: 20px; display: flex; flex-direction: column; align-items: center; }
            .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; width: 100%; max-width: 900px; }
            .card { background: #1e293b; padding: 1.5rem; border-radius: 1rem; border: 1px solid #334155; }
            .log-card { background: #1e293b; padding: 1.5rem; border-radius: 1rem; border: 1px solid #334155; width: 100%; max-width: 900px; margin-top: 20px; }
            h1, h2 { color: #38bdf8; }
            .stat { font-size: 2rem; font-weight: bold; color: #10b981; }
            .log-item { border-bottom: 1px solid #334155; padding: 8px 0; font-size: 0.9rem; }
            .guild-tag { font-size: 0.7rem; background: #334155; padding: 2px 6px; border-radius: 4px; margin-right: 8px; }
        </style>
    </head>
    <body>
        <h1>Mission Control</h1>
        <div class="grid">
            ${stats.map(s => `
                <div class="card">
                    <h3>${s.guild_name || 'Unknown Server'}</h3>
                    <div class="stat">${s.active_timers}</div>
                    <div style="color: #94a3b8">Active Timers</div>
                </div>
            `).join('')}
        </div>
        <div class="log-card">
            <h2>Recent Global Activity</h2>
            ${logs.map(l => `
                <div class="log-item">
                    <span class="guild-tag">${l.guild_name}</span>
                    <span style="color: #38bdf8">${new Date(l.timestamp).toLocaleTimeString()}</span> - ${l.details}
                </div>
            `).join('')}
        </div>
    </body>
    </html>`);
});
app.listen(3000, '0.0.0.0');

// --- BOT LOGIC ---
client.once('clientReady', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    
    // Global Lock Processor
    setInterval(async () => {
        const rows = db.prepare('SELECT * FROM pending_locks WHERE lock_at <= ?').all(Date.now());
        for (const row of rows) {
            const settings = getSettings(row.guild_id);
            try {
                const thread = await client.channels.fetch(row.thread_id);
                if (thread && settings) {
                    await thread.setAppliedTags([settings.resolved_tag]);
                    await thread.setLocked(true);
                    logAction(row.guild_id, 'LOCK', `Auto-locked: ${thread.name}`);
                }
            } catch (e) { console.error(e); }
            db.prepare('DELETE FROM pending_locks WHERE thread_id = ?').run(row.thread_id);
        }
    }, 60000);
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isChatInputCommand()) {
        const settings = getSettings(interaction.guildId);

        // --- SETUP COMMAND ---
        if (interaction.commandName === 'setup') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply("Admins only!");
            
            const forumId = interaction.options.getString('forum_id');
            const resolved = interaction.options.getString('resolved_tag');
            const duplicate = interaction.options.getString('duplicate_tag');
            const role = interaction.options.getRole('helper_role').id;

            db.prepare(`INSERT OR REPLACE INTO guild_settings (guild_id, guild_name, forum_id, resolved_tag, duplicate_tag, helper_role_id) 
                        VALUES (?, ?, ?, ?, ?, ?)`).run(interaction.guildId, interaction.guild.name, forumId, resolved, duplicate, role);
            
            logAction(interaction.guildId, 'SETUP', 'Updated server configuration');
            return interaction.reply("✅ Server configuration updated successfully!");
        }

        // --- RESOLVED COMMAND ---
        if (interaction.commandName === 'resolved') {
            if (!settings) return interaction.reply("Please run /setup first!");
            const lockTime = Date.now() + (30 * 60 * 1000);
            db.prepare('INSERT OR REPLACE INTO pending_locks (thread_id, guild_id, lock_at) VALUES (?, ?, ?)').run(interaction.channelId, interaction.guildId, lockTime);
            logAction(interaction.guildId, 'COMMAND', `Resolved: ${interaction.channel.name}`);
            await interaction.reply("Thread marked as Resolved. Locking in 30 mins.");
        }
    }

    // Button Handling
    if (interaction.isButton() && interaction.customId === 'keep_open') {
        db.prepare('DELETE FROM pending_locks WHERE thread_id = ?').run(interaction.channelId);
        logAction(interaction.guildId, 'BUTTON', `Timer cancelled for ${interaction.channel.name}`);
        await interaction.update({ content: "✅ Closure cancelled.", components: [] });
    }
});

client.login(process.env.DISCORD_TOKEN);