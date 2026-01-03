// index.js

require('dotenv').config();
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const Database = require('better-sqlite3');
const cron = require('node-cron');

const db = new Database('database.db');
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent
    ]
});

// --- CONFIGURATION ---
const FORUM_ID = '1457087795402244210';
const RESOLVED_TAG = '1457088064265519224';
const DUPLICATE_TAG = '1457088536153952400';
const HELPER_ROLE_ID = '1457090977960558754';

// --- DATABASE INITIALIZATION ---
db.prepare('CREATE TABLE IF NOT EXISTS pending_locks (thread_id TEXT PRIMARY KEY, lock_at INTEGER)').run();

// --- CORE FUNCTIONS ---
async function processPendingLocks() {
    const now = Date.now();
    const rows = db.prepare('SELECT thread_id FROM pending_locks WHERE lock_at <= ?').all(now);

    for (const row of rows) {
        try {
            const thread = await client.channels.fetch(row.thread_id);
            if (thread) {
                await thread.setAppliedTags([RESOLVED_TAG]);
                await thread.setLocked(true);
                await thread.send("🔒 **Post Locked.** This thread has been closed following resolution.");
            }
        } catch (err) {
            console.error(`Lock error for ${row.thread_id}:`, err);
        }
        db.prepare('DELETE FROM pending_locks WHERE thread_id = ?').run(row.thread_id);
    }
}

// --- BOT EVENTS ---
client.once('clientReady', () => {
    console.log(`✅ Ready! Authenticated as ${client.user.tag}`);
    
    setInterval(processPendingLocks, 60000);

    // Daily Stale Check at Midnight
    cron.schedule('0 0 * * *', async () => {
        const forum = await client.channels.fetch(FORUM_ID);
        const { threads } = await forum.threads.fetchActive();
        const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

        threads.forEach(async (thread) => {
            if (Date.now() - thread.createdTimestamp > thirtyDaysMs) {
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('keep_open')
                        .setLabel('Keep Post Open')
                        .setStyle(ButtonStyle.Success)
                );

                await thread.send({
                    content: `⚠️ <@${thread.ownerId}>, this post is 30+ days old and will close in 1 hour.`,
                    components: [row]
                });

                const oneHour = Date.now() + (60 * 60 * 1000);
                db.prepare('INSERT OR REPLACE INTO pending_locks (thread_id, lock_at) VALUES (?, ?)').run(thread.id, oneHour);
            }
        });
    });
});

client.on('threadCreate', async (thread) => {
    if (thread.parentId !== FORUM_ID) return;
    await thread.send({
        content: `Welcome <@${thread.ownerId}>!`,
        embeds: [{
            title: "Help Guidelines",
            description: "A command helper will reach out soon! Use **/resolved** when finished.",
            color: 0x5865F2
        }]
    });
});

client.on('interactionCreate', async interaction => {
    // Button Handling
    if (interaction.isButton() && interaction.customId === 'keep_open') {
        if (interaction.user.id !== interaction.channel.ownerId) {
            return interaction.reply({ content: "Only the thread author can do this.", ephemeral: true });
        }
        db.prepare('DELETE FROM pending_locks WHERE thread_id = ?').run(interaction.channelId);
        return interaction.update({ content: "✅ **Closure cancelled.** Thread remains open.", components: [] });
    }

    // Slash Command Handling
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'resolved') {
        const lockTime = Date.now() + (30 * 60 * 1000);
        db.prepare('INSERT OR REPLACE INTO pending_locks (thread_id, lock_at) VALUES (?, ?)').run(interaction.channelId, lockTime);
        await interaction.reply("**Thread marked as Resolved.** Locking in 30 minutes.");
    }

    if (interaction.commandName === 'duplicate') {
        if (!interaction.member.roles.cache.has(HELPER_ROLE_ID)) {
            return interaction.reply({ content: "Missing Permissions.", ephemeral: true });
        }
        const link = interaction.options.getString('link');
        await interaction.channel.setAppliedTags([DUPLICATE_TAG]);
        await interaction.reply({
            embeds: [{
                title: "Duplicate Post",
                description: `Already addressed here: ${link}`,
                color: 0xFFA500
            }]
        });
        await interaction.channel.setLocked(true);
    }
});

client.login(process.env.DISCORD_TOKEN);