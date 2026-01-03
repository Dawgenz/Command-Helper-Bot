//  index.js
require('dotenv').config();
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const Database = require('better-sqlite3');
const db = new Database('database.db');
const cron = require('node-cron');

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// setup database
db.prepare('CREATE TABLE IF NOT EXISTS pending_locks (thread_id TEXT PRIMARY KEY, lock_at INTEGER)').run();

// IDs variabless
const FORUM_ID = '1457087795402244210';
const RESOLVED_TAG = '1457088064265519224';

client.once('clientReady', () => {
    console.log(`logged in as ${client.user.tag}!`);
    setInterval(processPendingLocks, 60000);

    // run every day at midnight
    cron.schedule('0 0 * * *', async () => {
        console.log('running daily stale post check...');
        const forum = await client.channels.fetch(FORUM_ID);
        const threads = await forum.threads.fetchActive();
        
        const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
        const now = Date.now();

        threads.threads.forEach(async (thread) => {
            if (now - thread.createdTimestamp > thirtyDaysMs) {
                // create the "Keep Open" button
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('keep_open')
                        .setLabel('Keep Post Open')
                        .setStyle(ButtonStyle.Success)
                );

                await thread.send({
                    content: `⚠️ <@${thread.ownerId}>, this post is over 30 days old. To keep the forum clean, it will be closed in 1 hour. If you still need help, click the button below!`,
                    components: [row]
                });

                // add to DB to lock in uno hour unless they click the button
                const oneHour = Date.now() + (60 * 60 * 1000);
                db.prepare('INSERT OR REPLACE INTO pending_locks (thread_id, lock_at) VALUES (?, ?)').run(thread.id, oneHour);
            }
        });
    });
});

// listener for commands
client.on('interactionCreate', async interaction => {
    // handle buttons
    if (interaction.isButton()) {
        if (interaction.customId === 'keep_open') {
            // only the OP/helper should be able to cancel closure
            if (interaction.user.id !== interaction.channel.ownerId) {
                return interaction.reply({ content: "Only the person who made this post can keep it open!", ephemeral: true });
            }

            // remove the pending lock from the database
            db.prepare('DELETE FROM pending_locks WHERE thread_id = ?').run(interaction.channelId);

            await interaction.update({
                content: "✅ **Closure cancelled.** This thread will stay open for now!",
                components: [] // removes the button
            });
        }
        return;
    }
    // handle slash commands
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'resolved') {
        // logic for 30 min timer
        const thirtyMins = Date.now() + (30 * 60 * 1000);
        db.prepare('INSERT OR REPLACE INTO pending_locks (thread_id, lock_at) VALUES (?, ?)').run(interaction.channelId, thirtyMins);

        await interaction.reply("**Thread marked as Resolved.** It will be tagged and locked in 30 minutes.");
    }

    if (interaction.commandName === 'duplicate') {
        const HELPER_ROLE_ID = '1457090977960558754'; 
        const DUPLICATE_TAG_ID = '1457088536153952400';

        // permission check first!
        if (!interaction.member.roles.cache.has(HELPER_ROLE_ID)) {
            return interaction.reply({ 
                content: "Only Command Helpers can mark posts as duplicates!", 
                ephemeral: true 
            });
        }

        const originalLink = interaction.options.getString('link');

        // set the duplicate tag (replaces all current tags tho)
        await interaction.channel.setAppliedTags([DUPLICATE_TAG_ID]);

        // send the redirection message
        await interaction.reply({
            embeds: [{
                title: "Duplicate Post",
                description: `This issue has already been addressed here:\n${originalLink}\n\nTo keep the channel organized, this thread is being closed. Please refer to the link above for the solution!`,
                color: 0xFFA500 // Orange
            }]
        });

        // lock the thread
        await interaction.channel.setLocked(true, "Marked as duplicate");
    }
});

// listener for thread creation (initial reminder counter)
client.on('threadCreate', async (thread) => {
    if (thread.parentId !== FORUM_ID) return;

    await thread.send({
        content: `Welcome <@${thread.ownerId}>!`,
        embeds: [{
            title: "Help Guidelines",
            description: "A command helper will reach out to you soon! Use **/resolved** when finished!",
            color: 0x5865F2
        }]
    });
});

client.login(process.env.DISCORD_TOKEN);