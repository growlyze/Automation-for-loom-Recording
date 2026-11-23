// Lists the ElevenLabs voices this API key can use (never prints the key).
//   npm run voices
import { loadEnv } from "../src/env.mjs";

loadEnv();
const key = process.env.ELEVENLABS_API_KEY?.trim();
if (!key) {
	console.error("ELEVENLABS_API_KEY is not set in .env");
	process.exit(1);
}
const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
if (!res.ok) {
	console.error(`ElevenLabs returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
	process.exit(1);
}
const { voices } = await res.json();
for (const v of voices) {
	const l = v.labels ?? {};
	console.log(`${v.voice_id}  ${v.name.padEnd(28)} ${[v.category, l.gender, l.accent, l.age, l.use_case ?? l["use case"], l.description].filter(Boolean).join(", ")}`);
}
const sub = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": key } });
if (sub.ok) {
	const s = await sub.json();
	console.log(`\nPlan: ${s.tier} - ${s.character_count} of ${s.character_limit} characters used this period.`);
} else {
	console.log(`\n(Plan details not readable with this key: ${sub.status})`);
}
