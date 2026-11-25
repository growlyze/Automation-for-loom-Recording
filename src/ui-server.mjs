#!/usr/bin/env node
// Local web UI: write scripts, generate videos, watch and download them, and log edit requests.
//   npm run ui   ->  http://localhost:4400
// Listens on 127.0.0.1 only: nothing is reachable from other machines.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { ROOT, loadEnv } from "./env.mjs";
import { MIME, esc, readJson, sendJson as send, sendText, serveFile as serveFileBase } from "./http-util.mjs";
import { parseScript, slugify, validateSpec } from "./input.mjs";

loadEnv();
// Imported after loadEnv so SHARE_* settings from .env apply.
const share = await import("./share.mjs");
const { buildTranscript, toSrt, toText, toVtt } = await import("./transcript.mjs");
const { listVoices } = await import("./tts.mjs");
const auth = await import("./auth.mjs");
const runlog = await import("./runlog.mjs");
const { convertScript, converterAvailable } = await import("./ai-convert.mjs");
const logins = await import("./logins.mjs");

// One AI conversion at a time; its progress streams to the page as "convert" events.
let conversion = null; // { id, status, lines, script, error, startedAt }
const conversionView = () => conversion && { ...conversion, lines: conversion.lines.slice(-300) };
function startConversion(text) {
	const c = { id: Date.now().toString(36), status: "running", lines: [], script: null, error: null, startedAt: new Date().toISOString() };
	conversion = c;
	broadcast("convert", conversionView());
	convertScript(text, {
		onLine: (line) => {
			c.lines.push(line);
			broadcast("convert-line", { id: c.id, line });
		},
	}).then(
		(r) => Object.assign(c, { status: "done", script: r.script, costUsd: r.costUsd }),
		(e) => Object.assign(c, { status: "failed", error: e.message }),
	).finally(() => broadcast("convert", conversionView()));
}
if (!auth.authEnabled()) console.warn("Warning: UI_PASSWORD is not set in .env - the interface is NOT locked.");

const rawBody = (req) =>
	new Promise((resolve) => {
		let data = "";
		req.on("data", (c) => {
			data += c;
			if (data.length > 10000) req.destroy();
		});
		req.on("end", () => resolve(data));
	});
const PORT = Number(process.env.UI_PORT ?? 4400);
const VIDEOS = path.join(ROOT, "videos");
const OUTPUT = path.join(ROOT, "output");
const REQUESTS = path.join(ROOT, "edit-requests"); // outside output/, so a re-run keeps them
for (const d of [VIDEOS, OUTPUT, REQUESTS]) mkdirSync(d, { recursive: true });

const SAFE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const serveFile = (req, res, file, download) => serveFileBase(req, res, file, { download });
const body = (req) =>
	new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (c) => {
			data += c;
			if (data.length > 2e6) req.destroy();
		});
		req.on("end", () => {
			try {
				resolve(data ? JSON.parse(data) : {});
			} catch {
				reject(new Error("Body is not valid JSON"));
			}
		});
	});

// ---------- scripts (videos/*.json) ----------
function listScripts() {
	return readdirSync(VIDEOS)
		.filter((f) => f.endsWith(".json"))
		.map((f) => {
			const spec = readJson(path.join(VIDEOS, f), {});
			const name = f.replace(/\.json$/, "");
			return { name, title: spec.title ?? name, steps: spec.steps?.length ?? 0, slug: spec.title ? slugify(spec.title) : null, updatedAt: statSync(path.join(VIDEOS, f)).mtime };
		})
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

function cleanSpec(spec) {
	// Store only what the author wrote, not the defaults validateSpec fills in.
	const { quality, slug, ...rest } = spec;
	return rest;
}

// ---------- videos (output/<slug>/) ----------
function videoInfo(slug) {
	const dir = path.join(OUTPUT, slug);
	if (!SAFE.test(slug) || !existsSync(dir)) return null;
	const timeline = readJson(path.join(dir, "timeline.json"));
	const failed = readJson(path.join(dir, "failed.json"));
	const mp4 = path.join(dir, `${slug}.mp4`);
	const hasMp4 = existsSync(mp4) && !failed;
	const requests = readJson(path.join(REQUESTS, `${slug}.json`), []);
	const scriptName = (timeline?.script ?? failed?.script ?? "").match(/^videos\/([^/]+)\.json$/)?.[1] ?? listScripts().find((s) => s.slug === slug)?.name ?? null;
	return {
		slug,
		title: timeline?.title ?? readJson(path.join(VIDEOS, `${scriptName}.json`))?.title ?? slug,
		status: hasMp4 ? "ready" : failed ? "failed" : "incomplete",
		error: failed?.error ?? null,
		script: scriptName,
		durationMs: timeline?.durationMs ?? null,
		voice: timeline?.voice ?? null,
		voiceName: timeline?.voiceName ?? null,
		captions: timeline?.captions ?? null,
		steps: timeline?.steps ?? [],
		sizeBytes: hasMp4 ? statSync(mp4).size : 0,
		updatedAt: statSync(hasMp4 ? mp4 : dir).mtime,
		openRequests: requests.filter((r) => r.status !== "done").length,
		transcript: buildTranscript(timeline).lines,
		share: shareView(slug),
		files: readdirSync(dir).filter((f) => statSync(path.join(dir, f)).isFile()),
	};
}
function shareView(slug) {
	const s = share.shareFor(slug);
	return s && { token: s.token, url: share.shareUrl(s.token), views: s.views ?? 0, lastViewedAt: s.lastViewedAt ?? null, createdAt: s.createdAt };
}
const listVideos = () =>
	readdirSync(OUTPUT, { withFileTypes: true })
		.filter((d) => d.isDirectory() && SAFE.test(d.name))
		.map((d) => videoInfo(d.name))
		.filter(Boolean)
		.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));


// ---------- jobs: one pipeline run at a time (it takes over the screen) ----------
let job = null; // { id, script, slug, status, lines, startedAt, endedAt, exitCode }
const listeners = new Set();
const broadcast = (event, data) => {
	for (const res of listeners) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};
const jobView = () => job && { id: job.id, script: job.script, slug: job.slug, title: job.title, status: job.status, startedAt: job.startedAt, endedAt: job.endedAt, lines: job.lines.slice(-400) };

function startJob(scriptName, captions) {
	const spec = readJson(path.join(VIDEOS, `${scriptName}.json`));
	const args = [path.join(ROOT, "src", "make.mjs"), `videos/${scriptName}.json`];
	if (captions === true) args.push("--captions");
	if (captions === false) args.push("--no-captions");
	job = { id: Date.now().toString(36), script: scriptName, slug: slugify(spec.title), title: spec.title, status: "running", lines: [], startedAt: new Date().toISOString(), endedAt: null };
	const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env, windowsHide: true });
	const current = job;
	let buf = "";
	const onData = (chunk) => {
		buf += chunk.toString();
		const parts = buf.split(/\r?\n/);
		buf = parts.pop();
		for (const line of parts) {
			if (!line.trim() || line.startsWith(">")) continue;
			current.lines.push(line);
			broadcast("line", { id: current.id, line });
		}
	};
	child.stdout.on("data", onData);
	child.stderr.on("data", onData);
	child.on("close", (code) => {
		if (buf.trim()) current.lines.push(buf.trim());
		current.status = code === 0 ? "done" : "failed";
		current.endedAt = new Date().toISOString();
		broadcast("job", jobView());
	});
	broadcast("job", jobView());
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, "http://localhost");
	const p = url.pathname;
	const m = (re) => re.exec(p);
	let r;
	try {
		// Theme and fonts are public: the lock page needs them before signing in.
		if (req.method === "GET" && p === "/theme.css") return serveFileBase(req, res, path.join(ROOT, "ui", "theme.css"), { extra: { "content-type": "text/css; charset=utf-8" } });
		if (req.method === "GET" && (r = m(/^\/fonts\/(switzer-latin-\d{3}-normal\.woff2)$/))) return serveFileBase(req, res, path.join(ROOT, "ui", "fonts", r[1]), { extra: { "content-type": "font/woff2", "cache-control": "public, max-age=604800" } });

		// ---- the Chrome extension (no app session; protected by the extension code, localhost only) ----
		if (p === "/ext/capture" && req.method === "GET") {
			// The extension acts on this page. If it stays visible, the extension isn't installed here.
			const site = url.searchParams.get("site") ?? "";
			return sendText(res, 200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Saving login…</title><link rel="stylesheet" href="/theme.css">
<body style="display:grid;place-items:center;min-height:100vh;padding:16px"><div class="card" style="max-width:520px;padding:28px">
<span class="brand" style="margin-bottom:16px;color:var(--dark)"><span class="mark" style="border-color:var(--dark)"></span><span class="name"><b>Growlyze</b><span>Automatic Video Recorder</span></span></span>
<h1 style="font-size:1.3rem">Saving your login for ${esc(site)}…</h1>
<p style="color:var(--muted);font-weight:500">If this page doesn't change in a few seconds, the <b>Growlyze Recorder - Save login</b> extension isn't installed in this Chrome profile:</p>
<ol style="line-height:1.8;font-weight:500"><li>Open <code>chrome://extensions</code> in this window and turn on <b>Developer mode</b>.</li><li>Click <b>Load unpacked</b> and choose the folder <code>${esc(path.join(ROOT, "chrome-extension"))}</code>.</li><li>Go back to the recorder and click <b>Open in my Chrome</b> again.</li></ol></div>`, ".html");
		}
		if ((r = m(/^\/api\/ext\/(import|failed)$/)) && req.method === "POST") {
			if (!logins.checkExtensionCode(req.headers["x-recorder-code"])) return send(res, 403, { error: "Wrong recorder code. Copy it again from the recorder's Logins page." });
			const b = await body(req);
			try {
				if (r[1] === "failed") {
					logins.importFailed(b);
					broadcast("logins", {});
					return send(res, 200, { ok: true });
				}
				const saved = logins.saveImported(b);
				broadcast("logins", saved);
				return send(res, 200, saved);
			} catch (e) {
				return send(res, 400, { error: e.message });
			}
		}

		// ---- lock ----
		if (p === "/login") {
			if (req.method === "POST") {
				const wait = auth.loginBlockedFor();
				if (wait) return sendText(res, 429, auth.loginPage(`Too many wrong attempts. Try again in ${Math.ceil(wait / 1000)} s.`), ".html");
				const password = new URLSearchParams(await rawBody(req)).get("password");
				if (auth.authEnabled() && auth.checkPassword(password)) {
					auth.resetFailures();
					res.writeHead(303, { location: "/", "set-cookie": auth.sessionCookie(), "cache-control": "no-store" });
					return res.end();
				}
				auth.recordFailure();
				await new Promise((ok) => setTimeout(ok, 800));
				return sendText(res, 401, auth.loginPage("Wrong password."), ".html");
			}
			if (auth.isLoggedIn(req) && auth.authEnabled()) {
				res.writeHead(303, { location: "/" });
				return res.end();
			}
			return sendText(res, 200, auth.loginPage(), ".html");
		}
		if (p === "/logout") {
			res.writeHead(303, { location: "/login", "set-cookie": auth.clearCookie() });
			return res.end();
		}
		if (!auth.isLoggedIn(req)) {
			if (p.startsWith("/api/") || p.startsWith("/media/")) return send(res, 401, { error: "Locked. Sign in again.", login: "/login" });
			res.writeHead(303, { location: "/login" });
			return res.end();
		}

		if (req.method === "GET" && (p === "/" || p === "/index.html")) {
			res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
			return res.end(readFileSync(path.join(ROOT, "ui", "index.html")));
		}
		if (req.method === "GET" && p === "/api/status") {
			const key = !!process.env.ELEVENLABS_API_KEY?.trim();
			return send(res, 200, { voice: key ? "ElevenLabs (chosen per script)" : "Windows offline voice (fallback)", job: jobView(), tunnel: share.tunnelState(), locked: auth.authEnabled(), converter: converterAvailable() });
		}

		// Saved logins: sign in once in a real Chrome window, then scripts use "switch <name>"
		if (p === "/api/logins" && req.method === "GET") {
			return send(res, 200, {
				logins: logins.listLogins(),
				signingIn: logins.activeCaptures(),
				fromChrome: logins.chromeRequests(),
				chromeProfiles: logins.chromeProfiles(),
				extension: { code: logins.extensionCode(), folder: path.join(ROOT, "chrome-extension") },
			});
		}
		if (p === "/api/logins/from-chrome" && req.method === "POST") {
			const b = await body(req);
			try {
				return send(res, 200, logins.openInChrome({ profile: b.profile, url: String(b.url ?? "").trim(), name: String(b.name ?? "").trim().toLowerCase(), recorderUrl: `http://localhost:${PORT}` }));
			} catch (e) {
				return send(res, 400, { error: e.message });
			}
		}
		if (p === "/api/logins" && req.method === "DELETE") {
			const { origin, name } = Object.fromEntries(url.searchParams);
			if (!origin || !logins.NAME_RE.test(name ?? "")) return send(res, 400, { error: "Which login?" });
			logins.deleteLogin(origin, name);
			return send(res, 200, { ok: true });
		}
		if ((r = m(/^\/api\/logins\/(start|save|cancel|check)$/)) && req.method === "POST") {
			const b = await body(req);
			try {
				if (r[1] === "start") return send(res, 200, await logins.startCapture({ url: String(b.url ?? "").trim(), name: String(b.name ?? "").trim().toLowerCase() }));
				if (r[1] === "save") return send(res, 200, await logins.finishCapture(b.id, { force: !!b.force }));
				if (r[1] === "cancel") return send(res, 200, (logins.cancelCapture(b.id), { ok: true }));
				return send(res, 200, await logins.checkLogin(b.origin, b.name));
			} catch (e) {
				return send(res, 400, { error: e.message });
			}
		}

		// Logs: every run, by month and day
		if (req.method === "GET" && p === "/api/logs") {
			const runs = runlog.listRuns().map(({ pid, ...r }) => r);
			const months = {};
			for (const r of runs) {
				const m = (months[r.month] ??= { month: r.month, runs: 0, failed: 0, success: 0 });
				m.runs++;
				if (r.status === "failed") m.failed++;
				if (r.status === "success") m.success++;
			}
			return send(res, 200, { months: Object.values(months).sort((a, b) => (a.month < b.month ? 1 : -1)), runs });
		}
		if ((r = m(/^\/api\/logs\/([\w-]{8,40})(\/download)?$/)) && req.method === "GET") {
			const entry = runlog.listRuns().find((x) => x.id === r[1]);
			if (!entry) return send(res, 404, { error: "No such run" });
			const text = runlog.readRunLog(entry);
			if (r[2]) return sendText(res, 200, text, ".txt", `${entry.day}-${path.basename(entry.file ?? entry.id)}`);
			const { pid, ...run } = entry;
			return send(res, 200, { run, text });
		}

		// Voices the person writing a script can choose from
		if (req.method === "GET" && p === "/api/voices") {
			const defaultId = process.env.ELEVENLABS_VOICE_ID?.trim() || null;
			try {
				const voices = await listVoices({ fresh: url.searchParams.has("refresh") });
				if (!voices) return send(res, 200, { available: false, reason: "No ElevenLabs API key in .env: videos use the Windows offline voice.", voices: [], defaultId: null });
				// The default may be a Voice Library voice that isn't in the account's list: show it anyway.
				const list = defaultId && !voices.some((v) => v.id === defaultId) ? [{ id: defaultId, name: "Classic", category: "library", gender: "male", accent: null, age: null, useCase: "narration", previewUrl: null }, ...voices] : voices;
				return send(res, 200, { available: true, voices: list, defaultId });
			} catch (e) {
				return send(res, 200, { available: false, reason: e.message, voices: [], defaultId });
			}
		}

		// Public sharing: the tunnel and per-video links
		if (req.method === "POST" && p === "/api/tunnel") {
			const { action } = await body(req);
			return send(res, 200, action === "stop" ? share.stopTunnel(onTunnel) : share.startTunnel(onTunnel));
		}
		if ((r = m(/^\/api\/videos\/([a-z0-9-]+)\/share$/))) {
			const info = videoInfo(r[1]);
			if (!info) return send(res, 404, { error: "No such video" });
			if (req.method === "POST") {
				if (info.status !== "ready") return send(res, 400, { error: "Only a finished video can be shared." });
				share.createShare(r[1]);
				share.startTunnel(onTunnel);
				return send(res, 200, { share: shareView(r[1]), tunnel: share.tunnelState() });
			}
			if (req.method === "DELETE") {
				share.revokeShare(r[1]);
				return send(res, 200, { ok: true });
			}
		}

		// Transcripts, made from the timeline (exact script text, spoken times)
		if ((r = m(/^\/api\/videos\/([a-z0-9-]+)\/transcript\.(txt|srt|vtt)$/)) && req.method === "GET") {
			const timeline = SAFE.test(r[1]) && readJson(path.join(OUTPUT, r[1], "timeline.json"));
			if (!timeline) return send(res, 404, { error: "No transcript" });
			const text = r[2] === "txt" ? toText(timeline) : r[2] === "srt" ? toSrt(timeline) : toVtt(timeline);
			const name = r[2] === "txt" ? `${r[1]}-transcript.txt` : `${r[1]}.${r[2]}`;
			return sendText(res, 200, text, `.${r[2]}`, url.searchParams.has("download") ? name : null);
		}

		// Scripts
		if (req.method === "GET" && p === "/api/scripts") return send(res, 200, listScripts());
		if (req.method === "POST" && p === "/api/parse") {
			// Pasted script (JSON or the simple text format) -> spec + every problem found.
			const { text, overrides } = await body(req);
			const { spec, errors, prose } = parseScript(text);
			if (prose) return send(res, 200, { spec: null, errors, prose: true, converter: converterAvailable() });
			if (spec && overrides && typeof overrides === "object") {
				for (const k of ["voice", "captions", "resolution"]) if (overrides[k] !== undefined) spec[k] = overrides[k];
				if (overrides.voice === "") delete spec.voice;
			}
			// When step lines were rejected, "steps is required" only repeats that.
			const checks = spec ? validateSpec(structuredClone(spec)).filter((e) => !(errors.length && e.startsWith('"steps"'))) : [];
			const all = [...errors, ...checks];
			return send(res, 200, { spec, errors: all });
		}
		if (p === "/api/convert") {
			if (req.method === "GET") return send(res, 200, { conversion: conversionView(), available: converterAvailable() });
			if (req.method === "POST") {
				if (!converterAvailable()) return send(res, 400, { error: "Converting plain-English scripts needs an Anthropic API key: add ANTHROPIC_API_KEY=... to .env, then restart the UI." });
				if (conversion?.status === "running") return send(res, 409, { error: "A conversion is already running. Wait for it to finish." });
				const { text } = await body(req);
				if (!text?.trim()) return send(res, 400, { error: "Paste a script first." });
				startConversion(text);
				return send(res, 200, conversionView());
			}
		}
		if (req.method === "POST" && p === "/api/validate") {
			const spec = await body(req);
			return send(res, 200, { errors: validateSpec(structuredClone(spec)) });
		}
		if ((r = m(/^\/api\/scripts\/([a-z0-9-]+)$/))) {
			const file = path.join(VIDEOS, `${r[1]}.json`);
			if (req.method === "GET") return existsSync(file) ? send(res, 200, readJson(file)) : send(res, 404, { error: "No such script" });
			if (req.method === "PUT") {
				const spec = await body(req);
				const errors = validateSpec(structuredClone(spec));
				if (errors.length) return send(res, 400, { errors });
				writeFileSync(file, `${JSON.stringify(cleanSpec(spec), null, 2)}\n`);
				return send(res, 200, { name: r[1] });
			}
			if (req.method === "DELETE") {
				rmSync(file, { force: true });
				return send(res, 200, { ok: true });
			}
		}
		if (req.method === "POST" && p === "/api/scripts") {
			// New script: name it after its title.
			const spec = await body(req);
			const errors = validateSpec(structuredClone(spec));
			if (errors.length) return send(res, 400, { errors });
			let name = slugify(spec.title);
			for (let i = 2; existsSync(path.join(VIDEOS, `${name}.json`)); i++) name = `${slugify(spec.title)}-${i}`;
			writeFileSync(path.join(VIDEOS, `${name}.json`), `${JSON.stringify(cleanSpec(spec), null, 2)}\n`);
			return send(res, 200, { name });
		}

		// Jobs
		if (req.method === "POST" && p === "/api/jobs") {
			const { script, captions } = await body(req);
			if (job?.status === "running") return send(res, 409, { error: `"${job.title}" is still being recorded. Wait for it to finish.` });
			if (!SAFE.test(script ?? "") || !existsSync(path.join(VIDEOS, `${script}.json`))) return send(res, 404, { error: "No such script" });
			const errors = validateSpec(readJson(path.join(VIDEOS, `${script}.json`), {}));
			if (errors.length) return send(res, 400, { errors });
			startJob(script, captions);
			return send(res, 200, jobView());
		}
		if (req.method === "GET" && p === "/api/events") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
			res.write(`event: job\ndata: ${JSON.stringify(jobView())}\n\n`);
			res.write(`event: tunnel\ndata: ${JSON.stringify(share.tunnelState())}\n\n`);
			listeners.add(res);
			const ping = setInterval(() => res.write(": ping\n\n"), 20000);
			req.on("close", () => {
				clearInterval(ping);
				listeners.delete(res);
			});
			return;
		}

		// Videos
		if (req.method === "GET" && p === "/api/videos") return send(res, 200, listVideos());
		if ((r = m(/^\/api\/videos\/([a-z0-9-]+)$/))) {
			const info = videoInfo(r[1]);
			if (!info) return send(res, 404, { error: "No such video" });
			if (req.method === "GET") return send(res, 200, info);
			if (req.method === "DELETE") {
				if (job?.status === "running" && job.slug === r[1]) return send(res, 409, { error: "This video is being recorded." });
				rmSync(path.join(OUTPUT, r[1]), { recursive: true, force: true });
				return send(res, 200, { ok: true });
			}
		}
		if ((r = m(/^\/media\/([a-z0-9-]+)\/([\w.-]+)$/)) && req.method === "GET") {
			const file = path.join(OUTPUT, r[1], r[2]);
			if (!SAFE.test(r[1]) || path.dirname(file) !== path.join(OUTPUT, r[1])) return send(res, 400, { error: "Bad path" });
			return serveFile(req, res, file, url.searchParams.has("download"));
		}

		// Edit requests (edit-requests/<slug>.json)
		if ((r = m(/^\/api\/videos\/([a-z0-9-]+)\/requests(?:\/([a-z0-9]+))?$/))) {
			if (!SAFE.test(r[1])) return send(res, 400, { error: "Bad name" });
			const file = path.join(REQUESTS, `${r[1]}.json`);
			const list = readJson(file, []);
			const save = () => {
				writeFileSync(`${file}.tmp`, JSON.stringify(list, null, 2));
				renameSync(`${file}.tmp`, file);
			};
			if (req.method === "GET" && !r[2]) return send(res, 200, list);
			if (req.method === "POST" && !r[2]) {
				const { text, atSec, step } = await body(req);
				if (!text?.trim()) return send(res, 400, { error: "Write what should change." });
				const item = { id: Date.now().toString(36), text: text.trim(), atSec: Number.isFinite(atSec) ? Math.round(atSec * 10) / 10 : null, step: Number.isInteger(step) ? step : null, status: "open", createdAt: new Date().toISOString() };
				list.push(item);
				save();
				return send(res, 200, item);
			}
			const item = list.find((x) => x.id === r[2]);
			if (!item) return send(res, 404, { error: "No such request" });
			if (req.method === "PATCH") {
				const { status, note } = await body(req);
				if (status) item.status = status === "done" ? "done" : "open";
				if (note !== undefined) item.note = String(note);
				item.updatedAt = new Date().toISOString();
				save();
				return send(res, 200, item);
			}
			if (req.method === "DELETE") {
				list.splice(list.indexOf(item), 1);
				save();
				return send(res, 200, { ok: true });
			}
		}
		send(res, 404, { error: "Not found" });
	} catch (e) {
		send(res, 500, { error: e.message });
	}
});

server.on("error", (e) => {
	console.error(e.code === "EADDRINUSE" ? `Port ${PORT} is already in use. Is the UI already running? Set UI_PORT in .env to use another port.` : e.message);
	process.exit(1);
});
server.listen(PORT, "127.0.0.1", () => {
	console.log(`Growlyze Automatic Video Recorder: http://localhost:${PORT}  (Ctrl+C to stop)`);
	share.startShareServer();
	// Links already handed out keep working: bring the tunnel up when any exist.
	if (share.listShares().length) share.startTunnel(onTunnel);
});

function onTunnel() {
	const t = share.tunnelState();
	if (t.status === "on") console.log(`Public sharing on: ${t.url}`);
	if (t.status === "error") console.log(`Public sharing error: ${t.error}`);
	broadcast("tunnel", t);
}
process.on("SIGINT", () => process.exit(0));
