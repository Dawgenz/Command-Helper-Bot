const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
require('dotenv').config();

const commands = [
    // RESOLVED COMMAND
    new SlashCommandBuilder()
        .setName('resolved')
        .setDescription('Marks this thread as resolved and locks it after 30 minutes'),
    
    // CANCEL COMMAND
    new SlashCommandBuilder()
        .setName('cancel')
        .setDescription('Cancel the automatic lock timer for this thread'),
    
    // INFO COMMAND
    new SlashCommandBuilder()
        .setName('info')
        .setDescription('Display stats about the bot and view active timers, roles, channels, and settings'),

    // DUPLICATE COMMAND
    new SlashCommandBuilder()
        .setName('duplicate')
        .setDescription('Marks this thread as a duplicate')
        .addStringOption(option => 
            option.setName('link')
                .setDescription('Link to the original post')
                .setRequired(true)),

    // LColor COMMAND
    new SlashCommandBuilder()
        .setName('lcolor')
        .setDescription('Set a reaction trigger for a user')
        .addUserOption(option => option.setName('user').setDescription('The user to target').setRequired(true))
        .addIntegerOption(option => option.setName('count').setDescription('Number of reactions required').setRequired(true))
        .addStringOption(option => option.setName('reaction').setDescription('The emoji name or ID').setRequired(true))
        .addStringOption(option => option.setName('text').setDescription('Custom reply text (defaults to "L color")').setRequired(false)),

    // SNIPPET COMMAND
    new SlashCommandBuilder()
        .setName('snippet')
        .setDescription('Send a saved embed snippet')
        .addStringOption(option =>
            option.setName('name')
                .setDescription('Snippet name')
                .setRequired(true)
        ),

    // LINK COMMAND
    new SlashCommandBuilder()
        .setName('link')
        .setDescription('Add a clickable link to your thread (OP only)')
        .addStringOption(option =>
            option.setName('url')
                .setDescription('The URL to attach to this thread')
                .setRequired(true)),

    // REMOVELINK COMMAND (NEW!)
    new SlashCommandBuilder()
        .setName('removelink')
        .setDescription('Remove the link attached to this thread (Owner/Mods only)'),

    // SETUP COMMAND
    new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Configure the bot for this specific server')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addChannelOption(option => 
            option.setName('forum')
                .setDescription('Select the Forum channel')
                .addChannelTypes(ChannelType.GuildForum) 
                .setRequired(true))
        .addStringOption(option => 
            option.setName('helper_roles')
                .setDescription('Paste Role IDs separated by commas (e.g. 123, 456)')
                .setRequired(true))
        .addStringOption(option => 
            option.setName('resolved_tag')
                .setDescription('The ID of the Resolved tag')
                .setRequired(true))
        .addStringOption(option => 
            option.setName('duplicate_tag')
                .setDescription('The ID of the Duplicate tag')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('unanswered_tag')
                .setDescription('The ID of the Unanswered tag (optional)')
                .setRequired(false)),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands },
        );

        console.log('Successfully reloaded application (/) commands globally.');
    } catch (error) {
        console.error(error);
    }
})();