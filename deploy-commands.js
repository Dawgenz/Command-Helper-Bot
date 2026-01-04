const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
require('dotenv').config();

const commands = [
    // --- RESOLVED COMMAND ---
    new SlashCommandBuilder()
        .setName('resolved')
        .setDescription('Marks this thread as resolved and locks it in 30 minutes'),
    
    // --- INFO COMMAND ---
    new SlashCommandBuilder()
        .setName('info')
        .setDescription('Display stats about the bot and view active timers, roles, channels, and settings'),

    // --- DUPLICATE COMMAND ---
    new SlashCommandBuilder()
        .setName('duplicate')
        .setDescription('Marks this thread as a duplicate')
        .addStringOption(option => 
            option.setName('link')
                .setDescription('Link to the original post')
                .setRequired(true)),

    // --- SMART SETUP COMMAND ---
    new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Configure the bot for this specific server')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        // SMART: This opens a channel picker filtered to Forums only
        .addChannelOption(option => 
            option.setName('forum')
                .setDescription('Select the Forum channel')
                .addChannelTypes(ChannelType.GuildForum) 
                .setRequired(true))
        // SMART: This opens a role picker
        .addRoleOption(option => 
            option.setName('helper_role')
                .setDescription('Select the Helper role')
                .setRequired(true))
        // Tags are still strings because they are internal to the forum settings
        .addStringOption(option => 
            option.setName('resolved_tag')
                .setDescription('The ID of the Resolved tag')
                .setRequired(true))
        .addStringOption(option => 
            option.setName('duplicate_tag')
                .setDescription('The ID of the Duplicate tag')
                .setRequired(true)),
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