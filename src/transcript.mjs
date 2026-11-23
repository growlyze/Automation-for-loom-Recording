// Transcript of a video from its timeline: the exact script text, timed to where each line is
// spoken. Produces readable text, SRT and WebVTT.

const pad = (n, w = 2) => String(n).padStart(w, "0");
function clock(ms, sep) {
	const t = Math.max(0, Math.round(ms));
	return `${pad(Math.floor(t / 3600000))}:${pad(Math.floor(t / 60000) % 60)}:${pad(Math.floor(t / 1000) % 60)}${sep}${pad(t % 1000, 3)}`;
}
export const short = (ms) => `${Math.floor(ms / 60000)}:${pad(Math.floor(ms / 1000) % 60)}`;

/** Splits a line into subtitle-sized pieces: sentences, then chunks of at most ~12 words. */
function pieces(text) {
	const sentences = text.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
	const out = [];
	for (const s of sentences) {
		const words = s.split(/\s+/);
		if (words.length <= 14) {
			out.push(s);
			continue;
		}
		const n = Math.ceil(words.length / 12);
		const size = Math.ceil(words.length / n);
		for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size).join(" "));
	}
	return out;
}

/**
 * Lines: one per narrated step { step, startMs, endMs, text }.
 * Cues: subtitle-sized pieces of those lines, timed in proportion to their length.
 */
export function buildTranscript(timeline) {
	const lines = (timeline?.steps ?? [])
		.filter((s) => s.say && s.narrationMs > 0)
		.map((s) => ({ step: s.step, startMs: s.startMs, endMs: s.startMs + s.narrationMs, text: s.say.trim() }));
	const cues = [];
	for (const line of lines) {
		const parts = pieces(line.text);
		const total = parts.reduce((n, p) => n + p.length, 0) || 1;
		let t = line.startMs;
		for (const p of parts) {
			const d = ((line.endMs - line.startMs) * p.length) / total;
			cues.push({ startMs: t, endMs: t + d, text: p });
			t += d;
		}
	}
	return { lines, cues };
}

export function toText(timeline) {
	const { lines } = buildTranscript(timeline);
	const head = `${timeline?.title ?? "Transcript"}\n${"=".repeat(Math.min(60, (timeline?.title ?? "Transcript").length))}\n\n`;
	return head + lines.map((l) => `[${short(l.startMs)}] ${l.text}`).join("\n\n") + "\n";
}

export function toSrt(timeline) {
	return buildTranscript(timeline)
		.cues.map((c, i) => `${i + 1}\n${clock(c.startMs, ",")} --> ${clock(c.endMs, ",")}\n${c.text}\n`)
		.join("\n");
}

export function toVtt(timeline) {
	return `WEBVTT\n\n${buildTranscript(timeline)
		.cues.map((c) => `${clock(c.startMs, ".")} --> ${clock(c.endMs, ".")}\n${c.text}\n`)
		.join("\n")}`;
}
