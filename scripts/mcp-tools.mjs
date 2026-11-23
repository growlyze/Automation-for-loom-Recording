// Dev helper: lists the tools OpenScreen's MCP server offers, with their input schemas.
//   node scripts/mcp-tools.mjs [toolName ...]
import { connectOpenScreen } from "../src/openscreen.mjs";

const names = process.argv.slice(2);
const os = await connectOpenScreen();
try {
	const { tools } = await os.client.listTools();
	for (const t of tools) {
		if (names.length && !names.includes(t.name)) continue;
		if (!names.length) {
			console.log(`- ${t.name}: ${(t.description ?? "").split("\n")[0].slice(0, 160)}`);
			continue;
		}
		console.log(`=== ${t.name}\n${t.description}\n${JSON.stringify(t.inputSchema, null, 1)}\n`);
	}
} finally {
	await os.close();
}
