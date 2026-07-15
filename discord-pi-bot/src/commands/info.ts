import { version as discordJsVersion, type Message } from "discord.js";

export function handleInfoCommand(message: Message) {
	const uptime = process.uptime();
	const days = Math.floor(uptime / 86400);
	const hours = Math.floor((uptime % 86400) / 3600);
	const minutes = Math.floor((uptime % 3600) / 60);

	const infoText = `📊 **Bot Information**

• **Uptime:** ${days}d ${hours}h ${minutes}m
• **JavaScript Runtime:** ${process.version}
• **Platform:** ${process.platform}
• **Total Memory Usage:** ${Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10} MB
• **Total Heap Size:** ${Math.round((process.memoryUsage().heapTotal / 1024 / 1024) * 10) / 10} MB
• **Discord.js Version:** ${discordJsVersion}`;

	message.reply(infoText);
}
