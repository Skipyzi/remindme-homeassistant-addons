import type { Message } from "discord.js";

export function handleHelpCommand(message: Message) {
	const helpText = `🤖 **AI Chat Bot Commands**

**Chat:**
• !chat <message> - Send a message to the AI assistant

**Reminders:**
• !remind <message> [minutes] - Set a reminder
• !remind list - List all active reminders
• !remind delete <reminderId> - Delete a reminder

**Bot Info:**
• !ping - Check bot latency
• !help - Show this help message
• !info - Show bot information

**Note:** Use the !chat prefix to talk to the AI assistant!`;

	message.reply(helpText);
}
