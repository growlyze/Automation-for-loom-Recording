#!/usr/bin/env node
// One command: input file -> narrated, zoomed demo MP4.
//   npm run make -- videos/example.json [--no-captions] [--captions] [--keep-cursor-file]
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { prepareAccounts, saveSession } from "./accounts.mjs";
import { openBrowser, sleep } from "./browser.mjs";
import { ROOT, loadEnv } from "./env.mjs";
import { readInput } from "./input.mjs";
import { updateLogin } from "./logins.mjs";
import { clockTime, startRun } from "./runlog.mjs";
import { PipelineError, connectOpenScreen, ffmpegPath, findOpenScreen } from "./openscreen.mjs";
import { toSrt, toText, toVtt } from "./transcript.mjs";
import { durationMs, synthesizeAll } from "./tts.mjs";

loadEnv();

const LEAD_IN_MS = Number(process.env.LEAD_IN_MS ?? 1500); // still frames before the first step
const GAP_MS = Number(process.env.STEP_GAP_MS ?? 500); // silence between two narration lines
const HOLD_MS = Number(process.env.ACTION_HOLD_MS ?? 1000); // a result stays on screen at least this long
const TAIL_MS = Number(process.env.TAIL_MS ?? 2000); // still frames after the last step

const args = process.argv.slice(2);
const inputFile = args.find((a) => !a.startsWith("--"));
if (!inputFile) {
	console.error("Usage: npm run make -- videos/<file>.json [--captions | --no-captions]");
	process.exit(2);
}

// Two kinds of log line: ACTION is what happened on screen, in plain words (clicked, typed,
// switched account, said); SYSTEM is the automatic work around it (voice, recording, export).
// Every line goes to the console, the video's log.txt and the permanent run log in logs/.
let logFile = null;
const run = startRun({ script: path.relative(ROOT, path.resolve(inputFile ?? "")).replaceAll("\\", "/") });
const write = (type, msg) => {
	const line = `[${clockTime()}] [${type}] ${msg}`;
	if (!msg.startsWith("openscreen ")) console.log(line);
	if (logFile) appendFileSync(logFile, `${line}\n`);
	run.append(line);
};
const log = (msg) => write("SYSTEM", msg);
const action = (msg) => write("ACTION", msg);

const fmtVideoTime = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

// The Microsoft Store build sees %APPDATA% through a per-app redirect: map its paths to real ones.
function realPath(p) {
	if (!p || existsSync(p)) return p;
	const appData = process.env.APPDATA;
	if (appData && p.toLowerCase().startsWith(appData.toLowerCase())) {
		const pkgRoot = path.join(process.env.LOCALAPPDATA, "Packages");
		const pkg = existsSync(pkgRoot) && readdirSync(pkgRoot).find((d) => d.startsWith("EtienneLescot.OpenScreen_"));
		if (pkg) {
			const mapped = path.join(pkgRoot, pkg, "LocalCache", "Roaming", p.slice(appData.length));
			if (existsSync(mapped)) return mapped;
		}
	}
	return p;
}

/** Lays each clip at its offset (ms into the recording) and writes one track of the given length. */
function mixNarration(clips, totalMs, out) {
	const ff = ffmpegPath();
	const inputs = clips.flatMap((c) => ["-i", c.file]);
	const chains = clips.map((c, i) => `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(c.offsetMs)}:all=1[a${i}]`);
	const mix = `${clips.map((_, i) => `[a${i}]`).join("")}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,apad,atrim=0:${(totalMs / 1000).toFixed(3)}[out]`;
	const r = spawnSync(ff, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", [...chains, mix].join(";"), "-map", "[out]", "-c:a", "pcm_s16le", out], { encoding: "utf8" });
	if (r.status !== 0) throw new PipelineError(`ffmpeg could not build the narration track: ${r.stderr}`);
}

async function main() {
	const spec = readInput(path.resolve(inputFile));
	run.describe({ slug: spec.slug, title: spec.title });
	if (args.includes("--captions")) spec.captions = true;
	if (args.includes("--no-captions")) spec.captions = false;

	// Check the tools before touching the output folder, so a failed start keeps the last good video.
	const exe = findOpenScreen();
	ffmpegPath();
	const outDir = path.join(ROOT, "output", spec.slug);
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	logFile = path.join(outDir, "log.txt");
	log(`Video: "${spec.title}" - ${spec.steps.length} steps -> ${path.relative(ROOT, outDir)}`);
	log(`OpenScreen: ${exe}`);

	// 1-2. Narration first: its length paces the steps.
	const clips = await synthesizeAll(spec.steps, path.join(outDir, "clips"), log, spec.voice);
	for (const c of clips.filter(Boolean)) log(`  step ${c.index + 1}: ${(c.durationMs / 1000).toFixed(1)} s  "${c.text}"`);

	const os = await connectOpenScreen();
	let browser;
	let recording = false;
	const timeline = [];
	try {
		// 3. Sign in the script's accounts (saved sessions are reused), stage the page, then record its window.
		// Accounts come from Account: lines (signed in with email + password) or from logins saved
		// on the Logins page (no password in the script).
		const usesAccounts = spec.accounts?.length || spec.steps.some((s) => s.action === "switch" && s.account !== "guest");
		let accountStates = {};
		if (usesAccounts) {
			log("Preparing accounts...");
			accountStates = await prepareAccounts(spec, log);
		}
		log(`Opening ${spec.url} ...`);
		browser = await openBrowser(spec.url, log, {
			accounts: accountStates,
			accountEmails: Object.fromEntries((spec.accounts ?? []).map((a) => [a.id, a.email])),
			onStateChange: (id, state) => {
				const acc = (spec.accounts ?? []).find((a) => a.id === id);
				if (acc) saveSession(spec.url, acc.email, state);
				else updateLogin(spec.steps.find((s) => s.action === "switch" && s.account === id && s.url)?.url ?? spec.url, id, state); // a saved login: keep its newest tokens
			},
		});
		// Start in the first step's account, so the opening frames already show the right screen.
		const firstSwitch = spec.steps[0]?.action === "switch" ? spec.steps[0] : null;
		let firstSwitchDone = null;
		if (firstSwitch) {
			firstSwitchDone = await browser.run(firstSwitch, 1);
			await sleep(800);
		}
		await browser.park();
		await browser.markWindow();
		log("Starting the recording - please don't touch the mouse or keyboard until it ends.");
		const started = await os.call("startRecording", { window: browser.token });
		log("Recording.");
		recording = true;
		const recStart = started.startedAt ?? Date.now();
		await sleep(LEAD_IN_MS - (Date.now() - recStart));

		// 4. Each step: narration and action start together; the step lasts as long as the
		// longer of the two (plus a gap / a hold), so voice and picture stay in line.
		for (const [i, step] of spec.steps.entries()) {
			const clip = clips[i];
			const t0 = Date.now();
			let skipped = null;
			const at = `[${fmtVideoTime(t0 - recStart)}] Step ${i + 1}`;
			if (clip) action(`${at} · Said: "${clip.text}"`);
			let did = null;
			if (i === 0 && firstSwitch) {
				did = firstSwitchDone; // already on this account's screen (done before recording started)
			} else {
				try {
					did = await browser.run(step, i + 1);
				} catch (e) {
					if (!step.optional) {
						action(`${at} · Could not do it: ${e.message.replace(/^Step \d+ \([^)]*\): /, "")}`);
						throw e;
					}
					skipped = e.message;
					action(`${at} · Skipped (optional step, it could not be done): ${e.message.replace(/^Step \d+ \([^)]*\): /, "")}`);
				}
			}
			if (did) action(`${at} · ${did}`);
			const actionEnd = Date.now();
			const narrationEnd = clip ? t0 + clip.durationMs + GAP_MS : t0;
			const hold = step.action === "wait" ? t0 + (step.ms ?? 1000) : step.action === "blur" || step.action === "unblur" ? actionEnd : actionEnd + (step.action === "goto" ? 600 : HOLD_MS);
			const until = Math.max(narrationEnd, hold) + (step.pause ?? 0);
			await sleep(until - Date.now());
			timeline.push({ step: i + 1, action: step.action, ...(step.account ? { account: step.account } : {}), ...(skipped ? { skipped } : {}), startMs: t0 - recStart, actionMs: actionEnd - t0, endMs: Date.now() - recStart, say: step.say ?? null, narrationMs: clip?.durationMs ?? 0 });
			log(`  step ${i + 1} ${step.action.padEnd(6)} at ${((t0 - recStart) / 1000).toFixed(2)} s (action ${actionEnd - t0} ms)`);
			if (clip) clip.offsetMs = t0 - recStart;
		}
		await sleep(TAIL_MS);

		// 5. Stop: OpenScreen turns the take into a project.
		const stop = await os.call("stopRecording", { title: spec.title });
		recording = false;
		log(`Recording stopped: ${stop.durationSec?.toFixed(1)} s, project ${stop.projectId}`);
		await browser.captureCurrent();
		const pointerEvents = browser.events;
		await browser.close();
		browser = null;
		const projectId = stop.projectId;
		const startedAt = stop.recordingStartedAt ?? recStart;
		if (startedAt !== recStart) {
			// Keep the narration on the recording's own clock.
			for (const c of clips.filter(Boolean)) c.offsetMs += recStart - startedAt;
		}

		// Zooms planned from the real mouse at stop time point at nothing in particular (the script
		// drove the page, not the mouse), and setPointerTrack keeps clear of them: drop them first.
		const doc = await os.call("getCurrentDocument", { projectId });
		for (const z of doc.zoomRanges ?? []) await os.call("removeModifier", { projectId, id: z.id }).catch((e) => log(`  (could not remove zoom ${z.id}: ${e.message})`));
		if (doc.zoomRanges?.length) log(`Removed ${doc.zoomRanges.length} zoom(s) planned from the real mouse.`);

		// Cursor and click zooms from the logged pointer (Playwright moves no real mouse).
		const track = await os.call("setPointerTrack", { projectId, events: pointerEvents, recordingStartedAt: startedAt });
		log(`Pointer track set; ${track.autoZoomsAdded ?? 0} click zoom(s) planned.`);

		// Privacy blurs: each blur step hides its areas until the next unblur step or the end.
		const totalForBlur = Math.round((stop.durationSec ?? 0) * 1000) || timeline.at(-1).endMs + TAIL_MS;
		for (const [i, step] of spec.steps.entries()) {
			if (step.action !== "blur") continue;
			const from = timeline[i].startMs;
			const endIdx = spec.steps.findIndex((s2, j) => j > i && (s2.action === "unblur" || s2.action === "blur"));
			const to = endIdx > 0 ? timeline[endIdx].startMs : totalForBlur;
			for (const r of step.regions) {
				await os.call("addAnnotation", {
					projectId,
					type: "blur",
					startSec: Math.max(0, (from - 300) / 1000),
					endSec: to / 1000,
					x: r.x + r.w / 2,
					y: r.y + r.h / 2,
					width: r.w,
					height: r.h,
					blurData: { type: "mosaic", shape: "rectangle" },
				});
			}
			log(`Privacy blur: ${step.regions.length} area(s) from ${(from / 1000).toFixed(1)} s to ${(to / 1000).toFixed(1)} s.`);
		}

		// 6. One narration file, timed to the steps, next to the recording (where OpenScreen trusts media).
		const totalMs = Math.round((stop.durationSec ?? 0) * 1000) || timeline.at(-1).endMs + TAIL_MS;
		const narrated = clips.filter(Boolean);
		const narrationOut = path.join(outDir, "narration.wav");
		if (narrated.length) {
			mixNarration(narrated, totalMs, narrationOut);
			log(`Narration track: ${(durationMs(narrationOut) / 1000).toFixed(1)} s`);
			const recordingsDir = path.dirname(realPath(stop.videoPath));
			const trusted = path.join(recordingsDir, `${path.basename(stop.videoPath, ".mp4")}.narration.wav`);
			copyFileSync(narrationOut, trusted);
			const media = await os.call("importMedia", { projectId, path: stop.videoPath.replace(/\.mp4$/, ".narration.wav"), kind: "audio", label: "Narration" });
			await os.call("addAudio", { projectId, assetId: media.assetId, startSec: 0, kind: "voiceover" });
			log("Narration added as the voiceover track (the recording has no other sound).");

			// 7. Captions from the voiceover, transcribed on this machine.
			if (spec.captions) {
				log("Transcribing the narration for captions (on-device Whisper; the first run downloads ~264 MB)...");
				const words = [...new Set(spec.steps.flatMap((s) => (s.say ?? "").match(/\b[A-Z][\w.-]*\b|\b\w*\d\w*\b/g) ?? []))].slice(0, 80);
				if (words.length) await os.call("setVocabulary", { projectId, vocabulary: words.join(", ").slice(0, 600) }).catch((e) => log(`  (vocabulary skipped: ${e.message})`));
				const tr = await os.call("transcribe", { projectId, assetId: media.assetId, language: process.env.CAPTIONS_LANGUAGE || "en" }, { timeoutMs: 30 * 60 * 1000 });
				log(`  transcript: ${JSON.stringify(tr).slice(0, 200)}`);
				const cap = await os.call("setCaptionSettings", { projectId, enabled: true, lane: "voiceover", style: "classic" });
				log(`Captions on (lane: ${cap.resolvedLane ?? "voiceover"}).`);
			}
		} else {
			log("No step has \"say\": the video will be silent.");
		}

		// 8. Export.
		await os.call("setEditorSettings", { projectId, aspectRatio: "16:9", formatFollowCursor: false }).catch((e) => log(`  (aspect ratio left as is: ${e.message})`));
		const mp4 = path.join(outDir, `${spec.slug}.mp4`);
		log(`Exporting ${spec.resolution} at ${spec.fps} fps ...`);
		const exp = await os.call("exportVideo", { projectId, path: mp4, quality: spec.quality, fps: spec.fps }, { timeoutMs: 60 * 60 * 1000 });
		log(`Exported ${exp.width}x${exp.height}: ${path.relative(ROOT, exp.path ?? mp4)}`);

		// 9. Keep the project with its media, plus the timings.
		const projectFile = realPath(path.join(path.dirname(path.dirname(stop.videoPath)), "projects", `${projectId}.openscreen`));
		if (existsSync(projectFile)) {
			// `openscreen pack` only takes legacy v2 files, not the editor's format the MCP tools save,
			// so copy the project and its media by hand. OpenScreen falls back to same-named files next
			// to the project when the stored paths are gone.
			const projDir = path.join(outDir, "project");
			mkdirSync(projDir, { recursive: true });
			copyFileSync(projectFile, path.join(projDir, `${spec.slug}.openscreen`));
			const video = realPath(stop.videoPath);
			for (const f of [video, `${video}.cursor.json`, video.replace(/\.mp4$/, ".narration.wav")]) {
				if (existsSync(f)) copyFileSync(f, path.join(projDir, path.basename(f)));
			}
			log(`Project saved to project/ (also in OpenScreen's project list as "${spec.title}").`);
		} else {
			log(`Project file not found at ${projectFile}; it is still in OpenScreen's project list as "${spec.title}".`);
		}
		const timelineData = { title: spec.title, script: path.relative(ROOT, path.resolve(inputFile)).replaceAll("\\", "/"), voice: clips.find(Boolean) ? clips.provider.name : null, voiceId: clips.provider.name === "elevenlabs" ? clips.provider.voice : null, voiceName: clips.provider.voiceName ?? null, captions: spec.captions, finishedAt: new Date().toISOString(), projectId, recordingStartedAt: startedAt, durationMs: totalMs, steps: timeline };
		writeFileSync(path.join(outDir, "timeline.json"), JSON.stringify(timelineData, null, 2));
		writeFileSync(path.join(outDir, "transcript.txt"), toText(timelineData));
		writeFileSync(path.join(outDir, "transcript.srt"), toSrt(timelineData));
		writeFileSync(path.join(outDir, "transcript.vtt"), toVtt(timelineData));
		spawnSync(ffmpegPath(), ["-y", "-loglevel", "error", "-ss", "2", "-i", mp4, "-frames:v", "1", "-vf", "scale=1280:-2", "-q:v", "3", path.join(outDir, "poster.jpg")]);
		log("Transcript (txt, srt, vtt) and poster image written.");
		log(`Done: ${path.join(outDir, `${spec.slug}.mp4`)}`);
		return { videoDurationMs: totalMs, voice: clips.provider?.voiceName ?? clips.provider?.name ?? null, steps: spec.steps.length, skippedSteps: timeline.filter((t) => t.skipped).length };
	} catch (e) {
		if (browser) await browser.screenshot(path.join(outDir, "failure.png"));
		throw e;
	} finally {
		if (recording) {
			log("Stopping the recording after the error...");
			await os.call("stopRecording", { title: `${spec.title} (failed)` }).catch(() => {});
		}
		if (browser) await browser.close();
		await os.close().catch(() => {});
	}
}

main().then(
	(result) => run.finish({ status: "success", extra: result ?? {} }),
	(e) => {
	const msg = e instanceof PipelineError ? e.message : e.stack ?? String(e);
	log(`ERROR: ${msg}`);
	run.finish({ status: "failed", error: msg.split("\n")[0].slice(0, 300) });
	if (logFile) {
		writeFileSync(
			path.join(path.dirname(logFile), "failed.json"),
			JSON.stringify({ script: path.relative(ROOT, path.resolve(inputFile)).replaceAll("\\", "/"), error: msg, at: new Date().toISOString() }, null, 2),
		);
	}
	process.exitCode = 1;
	},
);
