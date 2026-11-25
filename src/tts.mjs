// Text-to-speech: ElevenLabs when ELEVENLABS_API_KEY is set, else Windows' built-in offline voice.
// Clips are cached by provider, voice and text, so re-running a video does not pay for them twice.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./env.mjs";
import { PipelineError, ffmpegPath } from "./openscreen.mjs";

/** voiceOverride: the script's own "voice" (an ElevenLabs voice id); else ELEVENLABS_VOICE_ID. */
export function ttsProvider(voiceOverride) {
	const key = process.env.ELEVENLABS_API_KEY?.trim();
	if (key) {
		const voice = voiceOverride?.trim() || process.env.ELEVENLABS_VOICE_ID?.trim();
		if (!voice) throw new PipelineError('No voice chosen. Pick one in the script ("voice"), or set a default ELEVENLABS_VOICE_ID in .env.');
		return { name: "elevenlabs", voice, model: process.env.ELEVENLABS_MODEL_ID?.trim() || "eleven_multilingual_v2", settings: voiceSettings(), ext: "mp3" };
	}
	return { name: "windows", voice: process.env.WINDOWS_TTS_VOICE?.trim() || "", rate: Number(process.env.WINDOWS_TTS_RATE ?? 0) || 0, ext: "wav" };
}

// Default delivery: enthusiastic, confident, friendly and approachable. Lower stability = more
// expressive; higher style = more emotion. Each can be tuned in .env (values 0 to 1).
function voiceSettings() {
	const num = (name, def) => {
		const v = Number.parseFloat(process.env[name] ?? "");
		return Number.isFinite(v) && v >= 0 && v <= 1 ? v : def;
	};
	return {
		stability: num("ELEVENLABS_STABILITY", 0.35),
		similarity_boost: num("ELEVENLABS_SIMILARITY", 0.8),
		style: num("ELEVENLABS_STYLE", 0.45),
		use_speaker_boost: true,
	};
}

export function durationMs(file) {
	const ff = ffmpegPath();
	const ffprobe = ff === "ffmpeg" ? "ffprobe" : path.join(path.dirname(ff), "ffprobe");
	const r = spawnSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { encoding: "utf8" });
	const sec = Number.parseFloat(r.stdout);
	if (!Number.isFinite(sec)) throw new PipelineError(`Could not read the length of ${file}: ${r.stderr || r.error?.message}`);
	return Math.round(sec * 1000);
}

async function elevenLabs(provider, text, out) {
	const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(provider.voice)}?output_format=mp3_44100_128`;
	let res;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY.trim(), "content-type": "application/json", accept: "audio/mpeg" },
			body: JSON.stringify({ text, model_id: provider.model, voice_settings: provider.settings }),
		});
	} catch (e) {
		throw new PipelineError(`Could not reach ElevenLabs: ${e.message}`);
	}
	if (!res.ok) {
		const body = (await res.text()).slice(0, 300);
		const hint =
			/ivc_not_permitted|subscription_required/.test(body) ? ` The voice ${provider.voiceName ? `"${provider.voiceName}" ` : ""}is a cloned voice, and cloned voices need a paid ElevenLabs plan (Starter or higher). Pick a standard voice, or upgrade the plan.` :
			res.status === 401 ? " The API key in .env is wrong or revoked." :
			res.status === 404 ? " ELEVENLABS_VOICE_ID does not match a voice on this account." :
			res.status === 429 ? " Rate limit or quota reached." : "";
		throw new PipelineError(`ElevenLabs returned ${res.status}.${hint} ${body}`);
	}
	writeFileSync(out, Buffer.from(await res.arrayBuffer()));
}

// One PowerShell run for every clip: System.Speech ships with Windows, works offline.
function windowsSpeech(provider, jobs) {
	const listFile = path.join(path.dirname(jobs[0].out), "_sapi-jobs.json");
	writeFileSync(listFile, JSON.stringify(jobs.map((j) => ({ text: j.text, out: j.out }))), "utf8");
	const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $env:DR_VOICE
if ($voice) { $s.SelectVoice($voice) }
$s.Rate = [int]$env:DR_RATE
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo 44100, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($j in (Get-Content -Raw -Encoding UTF8 $env:DR_JOBS | ConvertFrom-Json)) {
  $s.SetOutputToWaveFile($j.out, $fmt)
  $s.Speak($j.text)
}
$s.SetOutputToNull()
$s.Dispose()
`;
	const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
		encoding: "utf8",
		windowsHide: true,
		env: { ...process.env, DR_JOBS: listFile, DR_VOICE: provider.voice, DR_RATE: String(provider.rate) },
	});
	if (r.status !== 0) {
		throw new PipelineError(
			`Windows text-to-speech failed: ${(r.stderr || r.error?.message || "").trim().split("\n").slice(0, 4).join(" ")}` +
				(provider.voice ? ` (Is WINDOWS_TTS_VOICE="${provider.voice}" installed? Leave it empty for the default voice.)` : ""),
		);
	}
}

/**
 * Makes one clip per narrated step. Returns [{ index, text, file, durationMs }] (null for steps
 * with nothing to say), with the clips copied into clipsDir.
 */
export async function synthesizeAll(steps, clipsDir, log, voiceOverride) {
	const provider = ttsProvider(voiceOverride);
	if (provider.name === "elevenlabs") provider.voiceName = (await voiceName(provider.voice)) ?? provider.voice;
	log(`Voice: ${provider.name === "elevenlabs" ? `ElevenLabs "${provider.voiceName}" (${provider.voice}, model ${provider.model})${voiceOverride ? "" : " - default from .env"}` : `Windows offline voice${provider.voice ? ` "${provider.voice}"` : " (default)"} - fallback until ELEVENLABS_API_KEY is set${voiceOverride ? "; the script's voice choice needs ElevenLabs" : ""}`}`);
	const cacheDir = path.join(ROOT, ".cache", "tts");
	mkdirSync(cacheDir, { recursive: true });
	mkdirSync(clipsDir, { recursive: true });
	const items = steps.map((s, index) => {
		if (!s.say) return null;
		const text = s.say.trim();
		const key = createHash("sha256").update(JSON.stringify([provider.name, provider.voice, provider.model, provider.rate, provider.settings, text])).digest("hex").slice(0, 20);
		return { index, text, cached: path.join(cacheDir, `${key}.${provider.ext}`) };
	});
	const todo = items.filter((it) => it && !existsSync(it.cached));
	if (todo.length) {
		log(`Generating ${todo.length} narration clip(s)${items.filter(Boolean).length - todo.length ? `, ${items.filter(Boolean).length - todo.length} from cache` : ""}...`);
		if (provider.name === "elevenlabs") {
			for (const it of todo) await elevenLabs(provider, it.text, it.cached);
		} else {
			windowsSpeech(provider, todo.map((it) => ({ text: it.text, out: it.cached })));
		}
	} else {
		log("All narration clips came from the cache.");
	}
	const result = items.map((it) => {
		if (!it) return null;
		if (!existsSync(it.cached)) throw new PipelineError(`The narration clip for step ${it.index + 1} was not written.`);
		const file = path.join(clipsDir, `step-${String(it.index + 1).padStart(2, "0")}.${provider.ext}`);
		copyFileSync(it.cached, file);
		const ms = durationMs(file);
		if (ms < 100) throw new PipelineError(`The narration clip for step ${it.index + 1} is empty.`);
		return { index: it.index, text: it.text, file, durationMs: ms };
	});
	result.provider = provider;
	return result;
}

// ---------------- ElevenLabs voice list (for the UI's picker) ----------------
let voiceCache = { at: 0, voices: null };
/** The voices this account can use: [{ id, name, category, gender, accent, age, useCase, previewUrl }]. */
export async function listVoices({ fresh = false } = {}) {
	const key = process.env.ELEVENLABS_API_KEY?.trim();
	if (!key) return null;
	if (!fresh && voiceCache.voices && Date.now() - voiceCache.at < 10 * 60 * 1000) return voiceCache.voices;
	const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
	if (!res.ok) throw new PipelineError(`ElevenLabs returned ${res.status} when listing voices.${res.status === 401 ? " The API key in .env is wrong or revoked." : ""}`);
	const { voices } = await res.json();
	voiceCache = {
		at: Date.now(),
		voices: voices.map((v) => {
			const l = v.labels ?? {};
			return { id: v.voice_id, name: v.name, category: v.category, gender: l.gender ?? null, accent: l.accent ?? null, age: l.age ?? null, useCase: l.use_case ?? l["use case"] ?? null, previewUrl: v.preview_url ?? null };
		}),
	};
	return voiceCache.voices;
}
async function voiceName(id) {
	try {
		return (await listVoices())?.find((v) => v.id === id)?.name ?? null;
	} catch {
		return null;
	}
}
