#!/usr/bin/env node
// Exercise the native Claude adapter and its real stdio MCP bridge without a subscription.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const args = process.argv.slice(2);
assert.equal(process.env.SUPERVISOR_TOKEN, undefined);
assert.equal(process.env.DISCORD_BOT_TOKEN, undefined);
assert.ok(args.includes('--strict-mcp-config'));
assert.equal(args[args.indexOf('--tools') + 1], '');
const mcp = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.home;
const resume = args.includes('--resume');
const id = args[args.indexOf(resume ? '--resume' : '--session-id') + 1];
const session = path.join(process.cwd(), `fixture-${id}.json`);
if (resume) assert.ok(fs.existsSync(session), 'The specific native session must exist before resume');
else fs.writeFileSync(session, '{}', { mode: 0o600 });
const worker = spawn(mcp.command, mcp.args, { env: { PATH: process.env.PATH, ...mcp.env }, stdio: 'pipe' });
worker.stderr.resume();
const write = message => worker.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const emit = message => process.stdout.write(JSON.stringify(message) + '\n');
emit({ type: 'system', subtype: 'init', session_id: id });
write({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } });
readline.createInterface({ input: worker.stdout }).on('line', line => {
	const message = JSON.parse(line);
	assert.ok(!message.error, 'The MCP bridge must accept the native client');
	if (message.id === 1) write({ id: 2, method: 'tools/list', params: {} });
	else if (message.id === 2) {
		assert.ok(message.result.tools.some(tool => tool.name === 'home_entities'));
		write({ id: 3, method: 'tools/call', params: { name: 'home_entities', arguments: {} } });
	} else if (message.id === 3) {
		assert.equal(message.result.isError, false);
		assert.ok(JSON.parse(message.result.content[0].text).entities);
		emit({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'The fixture house has no connected lights.' } } });
		emit({ type: 'result', is_error: false, session_id: id });
		worker.stdin.end();
	}
});
worker.once('close', code => process.exit(code || 0));
