const { REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const commands = [
    new SlashCommandBuilder()
        .setName('resolved')
        .setDescription('Marks this thread as resolved and locks it in 30 minutes'),
    new SlashCommandBuilder()
        .setName('duplicate')
        .setDescription('Marks this thread as a duplicate')
        .addStringOption(option => 
            option.setName('link')
                .setDescription('Link to the original post')
                .setRequired(true)),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        console.log('registering slash commands...');
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
            { body: commands },
        );
        console.log('success! it worksss.');
    } catch (error) {
        console.error(error);
    }
})();