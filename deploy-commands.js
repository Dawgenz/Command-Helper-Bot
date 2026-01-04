const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
require('dotenv').config();

const commands = [
    // --- RESOLVED COMMAND ---
    new SlashCommandBuilder()
        .setName('resolved')
        .setDescription('Marks this thread as resolved and locks it in 30 minutes'),

    // --- DUPLICATE COMMAND ---
    new SlashCommandBuilder()
        .setName('duplicate')
        .setDescription('Marks this thread as a duplicate')
        .addStringOption(option => 
            option.setName('link')
                .setDescription('Link to the original post')
                .setRequired(true)),

    // --- NEW SETUP COMMAND ---
    new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Configure the bot for this specific server')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(option => option.setName('forum_id').setDescription('The ID of the Forum channel').setRequired(true))
        .addStringOption(option => option.setName('resolved_tag').setDescription('The ID of the Resolved tag').setRequired(true))
        .addStringOption(option => option.setName('duplicate_tag').setDescription('The ID of the Duplicate tag').setRequired(true))
        .addStringOption(option => option.setName('helper_roles').setDescription('Comma-separated IDs of roles (e.g. 123,456,789)').setRequired(true)),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');

        // Option A: REGISTER GLOBALLY (Recommended for multiple servers)
        // This makes the commands available in EVERY server the bot is in.
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands },
        );

        console.log('Successfully reloaded application (/) commands globally.');
    } catch (error) {
        console.error(error);
    }
})();