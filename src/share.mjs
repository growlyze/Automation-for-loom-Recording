// Share links: a random token per video, a public watch page served by its own server (port
// SHARE_PORT, default 4401) and a Cloudflare tunnel that makes that server - and only that one -
// reachable from the internet. The editor on UI_PORT is never tunnelled.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { ROOT } from "./env.mjs";
import { esc, readJson, sendJson, sendText, serveFile } from "./http-util.mjs";
import { buildTranscript, short, toSrt, toText, toVtt } from "./transcript.mjs";

const OUTPUT = path.join(ROOT, "output");
const STORE = path.join(ROOT, "shares.json");
export const SHARE_PORT = Number(process.env.SHARE_PORT ?? 4401);

// ---------------- share store ----------------
// { "<token>": { slug, createdAt, views, lastViewedAt } }
const load = () => readJson(STORE, {});
function save(data) {
	writeFileSync(`${STORE}.tmp`, JSON.stringify(data, null, 2));
	renameSync(`${STORE}.tmp`, STORE);
}
export const shareFor = (slug) => {
	const all = load();
	const token = Object.keys(all).find((t) => all[t].slug === slug);
	return token ? { token, ...all[token] } : null;
};
export function createShare(slug) {
	const existing = shareFor(slug);
	if (existing) return existing;
	const all = load();
	const token = randomBytes(12).toString("base64url");
	all[token] = { slug, createdAt: new Date().toISOString(), views: 0 };
	save(all);
	return { token, ...all[token] };
}
export function revokeShare(slug) {
	const all = load();
	for (const t of Object.keys(all)) if (all[t].slug === slug) delete all[t];
	save(all);
}
export const listShares = () => Object.entries(load()).map(([token, s]) => ({ token, ...s }));
function countView(token) {
	const all = load();
	if (!all[token]) return;
	all[token].views = (all[token].views ?? 0) + 1;
	all[token].lastViewedAt = new Date().toISOString();
	save(all);
}

// ---------------- tunnel ----------------
const tunnel = { status: "stopped", url: null, error: null, child: null, mode: null };
export const tunnelState = () => ({ status: tunnel.status, url: tunnel.url, error: tunnel.error, mode: tunnel.mode });

function findCloudflared() {
	const candidates = [
		process.env.CLOUDFLARED,
		"C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
		"C:\\Program Files\\cloudflared\\cloudflared.exe",
		path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links", "cloudflared.exe"),
	].filter(Boolean);
	const found = candidates.find((c) => existsSync(c));
	if (found) return found;
	return spawnSync("cloudflared", ["--version"], { stdio: "ignore" }).error ? null : "cloudflared";
}

export function startTunnel(onChange = () => {}, attempt = 1) {
	if (tunnel.child) return tunnelState();
	const exe = findCloudflared();
	if (!exe) {
		Object.assign(tunnel, { status: "error", error: "cloudflared is not installed. Install it with: winget install Cloudflare.cloudflared" });
		onChange();
		return tunnelState();
	}
	// A named tunnel (Cloudflare account) gives a link that never changes; a quick tunnel gets a
	// new random trycloudflare.com address each time it starts.
	const token = process.env.SHARE_TUNNEL_TOKEN?.trim();
	const fixedBase = process.env.SHARE_BASE_URL?.trim().replace(/\/+$/, "");
	// http2 over TCP 443 gets through networks that block QUIC (UDP 7844).
	const protocol = ["--protocol", process.env.SHARE_TUNNEL_PROTOCOL || "http2"];
	const args = token ? ["tunnel", "--no-autoupdate", ...protocol, "run", "--token", token] : ["tunnel", "--no-autoupdate", ...protocol, "--url", `http://127.0.0.1:${SHARE_PORT}`];
	Object.assign(tunnel, { status: "starting", url: null, error: null, mode: token ? "named" : "quick" });
	if (token && !fixedBase) {
		Object.assign(tunnel, { status: "error", error: "SHARE_TUNNEL_TOKEN is set but SHARE_BASE_URL is empty. Set it to the public hostname of your tunnel, e.g. https://videos.example.com" });
		onChange();
		return tunnelState();
	}
	const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	tunnel.child = child;
	let buf = "";
	const onData = (chunk) => {
		buf = (buf + chunk.toString()).slice(-8000);
		if (tunnel.status === "starting") {
			// The tunnel's own address, not api.trycloudflare.com from an error line.
			const quick = /https:\/\/(?!api\.)[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/.exec(buf);
			if (!token && quick) Object.assign(tunnel, { status: "on", url: quick[0] }), onChange();
			if (token && /Registered tunnel connection/i.test(buf)) Object.assign(tunnel, { status: "on", url: fixedBase }), onChange();
		}
	};
	child.stdout.on("data", onData);
	child.stderr.on("data", onData);
	child.on("error", (e) => Object.assign(tunnel, { status: "error", error: e.message, child: null }) && onChange());
	child.on("close", (code) => {
		if (tunnel.child !== child) return;
		const tail = buf.split("\n").map((l) => l.replace(/^\S+Z\s+/, "").trim()).filter(Boolean);
		const lastErr = (tail.filter((l) => /^ERR|error|failed/i.test(l)).slice(-2).join(" ") || tail.slice(-2).join(" ")).replace(/--token\s+\S+/g, "--token ***").slice(0, 400);
		const wasStarting = tunnel.status === "starting";
		Object.assign(tunnel, { status: tunnel.status === "stopping" ? "stopped" : "error", url: null, child: null, error: tunnel.status === "stopping" ? null : `cloudflared exited (${code}). ${lastErr}`.trim() });
		// Slow connections often time out on the first request for a quick tunnel: try again.
		if (wasStarting && attempt < 3) {
			tunnel.status = "starting";
			onChange();
			setTimeout(() => startTunnel(onChange, attempt + 1), 3000);
			return;
		}
		onChange();
	});
	setTimeout(() => {
		if (tunnel.child === child && tunnel.status === "starting") {
			// Killing it lands in the close handler above, which retries.
			buf += "\nERR The tunnel did not come up within 60 s. Check the internet connection and try again.";
			child.kill();
		}
	}, 60000);
	onChange();
	return tunnelState();
}

export function stopTunnel(onChange = () => {}) {
	if (!tunnel.child) return tunnelState();
	tunnel.status = "stopping";
	tunnel.child.kill();
	onChange();
	return tunnelState();
}
process.on("exit", () => tunnel.child?.kill());

export const shareUrl = (token) => (tunnel.status === "on" && tunnel.url ? `${tunnel.url}/v/${token}` : null);

// ---------------- public watch page server ----------------
function poster(slug) {
	const dir = path.join(OUTPUT, slug);
	const file = path.join(dir, "poster.jpg");
	if (!existsSync(file) && existsSync(path.join(dir, `${slug}.mp4`))) {
		spawnSync(process.env.FFMPEG || "ffmpeg", ["-y", "-loglevel", "error", "-ss", "2", "-i", path.join(dir, `${slug}.mp4`), "-frames:v", "1", "-vf", "scale=1280:-2", "-q:v", "3", file]);
	}
	return file;
}

function watchPage(token, slug, timeline, origin) {
	const { lines } = buildTranscript(timeline);
	const title = timeline?.title ?? slug;
	const base = `/v/${token}`;
	const desc = lines.map((l) => l.text).join(" ").slice(0, 200);
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex, nofollow">
<meta property="og:type" content="video.other"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="${esc(origin)}${base}/poster.jpg">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/theme.css">
<style>
header{background:var(--dark);color:var(--cream);border-bottom:2px solid var(--dark)}
header .in{max-width:1200px;margin:0 auto;padding:12px 20px}
main{max-width:1200px;margin:0 auto;padding:28px 20px 56px}
.kicker{display:inline-block;background:var(--orange);color:#fff;font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;padding:3px 9px;border-radius:6px;border:1.5px solid var(--dark);margin-bottom:10px}
.meta{color:var(--muted);font-size:13px;font-weight:600;margin-bottom:20px}
.layout{display:grid;grid-template-columns:minmax(0,1.8fr) minmax(280px,1fr);gap:22px;align-items:start}
.layout>*{min-width:0}
@media(max-width:860px){.layout{grid-template-columns:1fr}}
video{width:100%;display:block;border-radius:var(--radius);background:var(--dark);aspect-ratio:16/9;border:2px solid var(--dark);box-shadow:var(--shadow-lg)}
.panel{padding:16px 18px}
.panel h2{font-size:15px;margin:0 0 10px;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.tx{max-height:min(62vh,560px);overflow:auto;margin:0 -8px}
.line{display:grid;grid-template-columns:46px 1fr;gap:8px;padding:7px 8px;border-radius:8px;cursor:pointer;border:2px solid transparent}
.line>*{min-width:0}
.line:hover{background:var(--surface-2)}.line.now{background:#ffe1cf;border-color:var(--dark)}
.ts{font:500 12px var(--mono);color:var(--orange);padding-top:2px}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
.small{font-size:12px;color:var(--muted);font-weight:500}
@media(max-width:600px){main{padding:18px 16px 40px}header .in{padding:10px 16px}}
</style></head><body>
<header><div class="in"><span class="brand"><span class="mark"></span><span class="name"><b>Growlyze</b><span>Automatic Video Recorder</span></span></span></div></header>
<main>
<span class="kicker">Demo video</span>
<h1>${esc(title)}</h1>
<div class="meta">${timeline?.durationMs ? short(timeline.durationMs) : ""}${timeline?.finishedAt ? ` · ${new Date(timeline.finishedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : ""}</div>
<div class="layout">
<div>
<video id="v" controls playsinline preload="metadata" poster="${base}/poster.jpg" src="${base}/video.mp4">
<track kind="subtitles" srclang="en" label="English" src="${base}/transcript.vtt"${timeline?.captions ? "" : " default"}></track></video>
<div class="actions"><a class="btn primary" href="${base}/video.mp4?download">⬇ Download video</a><a class="btn" href="${base}/transcript.txt?download">Transcript (.txt)</a><a class="btn" href="${base}/transcript.srt?download">Subtitles (.srt)</a></div>
</div>
<div class="panel card"><h2>Transcript <span class="small">click a line to jump there</span></h2>
<div class="tx" id="tx">${lines.map((l) => `<div class="line" data-at="${(l.startMs / 1000).toFixed(2)}" data-end="${(l.endMs / 1000).toFixed(2)}"><span class="ts">${short(l.startMs)}</span><span>${esc(l.text)}</span></div>`).join("") || '<p class="small">This video has no narration.</p>'}</div></div>
</div></main>
<script>
const v=document.getElementById("v"),ls=[...document.querySelectorAll(".line")];
ls.forEach(l=>l.onclick=()=>{v.currentTime=+l.dataset.at;v.play()});
let last=null;v.ontimeupdate=()=>{let c=null;for(const l of ls)if(+l.dataset.at<=v.currentTime+.05)c=l;if(c!==last){ls.forEach(l=>l.classList.toggle("now",l===c));if(c){const tx=document.getElementById("tx");const top=c.offsetTop-tx.offsetTop;if(top<tx.scrollTop||top>tx.scrollTop+tx.clientHeight-40)tx.scrollTo({top:top-40,behavior:"smooth"})}last=c}};
</script></body></html>`;
}

const SECURITY = { "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const notFound = (res) =>
	sendText(res, 404, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Link not available</title><link rel="stylesheet" href="/theme.css"><body style="display:grid;place-items:center;min-height:100vh;padding:16px"><div class="card" style="max-width:420px;padding:28px;text-align:center"><span class="brand" style="justify-content:center;margin-bottom:16px;color:var(--dark)"><span class="mark" style="border-color:var(--dark)"></span><span class="name"><b>Growlyze</b><span>Automatic Video Recorder</span></span></span><h1 style="font-size:1.3rem">This link is not available</h1><p style="color:var(--muted);font-weight:500;margin:6px 0 0">It may have been turned off by its owner.</p></div>`, ".html", null, SECURITY);

export function startShareServer() {
	const server = http.createServer((req, res) => {
		try {
			if (req.method !== "GET" && req.method !== "HEAD") return notFound(res);
			const url = new URL(req.url, "http://x");
			if (url.pathname === "/theme.css") return serveFile(req, res, path.join(ROOT, "ui", "theme.css"), { extra: { ...SECURITY, "content-type": "text/css; charset=utf-8" } });
			const font = /^\/fonts\/(switzer-latin-\d{3}-normal\.woff2)$/.exec(url.pathname);
			if (font) return serveFile(req, res, path.join(ROOT, "ui", "fonts", font[1]), { extra: { ...SECURITY, "content-type": "font/woff2", "cache-control": "public, max-age=604800" } });
			const m = /^\/v\/([A-Za-z0-9_-]{16})(?:\/(video\.mp4|poster\.jpg|transcript\.(?:vtt|srt|txt)))?\/?$/.exec(url.pathname);
			const share = m && load()[m[1]];
			const dir = share && path.join(OUTPUT, share.slug);
			const mp4 = dir && path.join(dir, `${share.slug}.mp4`);
			if (!share || !existsSync(mp4) || existsSync(path.join(dir, "failed.json"))) return notFound(res);
			const timeline = readJson(path.join(dir, "timeline.json"), { steps: [] });
			const download = url.searchParams.has("download");
			switch (m[2]) {
				case undefined: {
					if (req.method === "GET" && !/bot|crawl|spider|preview|slack|whatsapp|facebookexternalhit|discord|telegram/i.test(req.headers["user-agent"] ?? "")) countView(m[1]);
					const proto = req.headers["x-forwarded-proto"] ?? "https";
					return sendText(res, 200, watchPage(m[1], share.slug, timeline, `${proto}://${req.headers.host}`), ".html", null, SECURITY);
				}
				case "video.mp4":
					return serveFile(req, res, mp4, { download, downloadName: `${share.slug}.mp4`, extra: SECURITY });
				case "poster.jpg":
					return serveFile(req, res, poster(share.slug), { extra: SECURITY });
				case "transcript.vtt":
					return sendText(res, 200, toVtt(timeline), ".vtt", download ? `${share.slug}.vtt` : null, SECURITY);
				case "transcript.srt":
					return sendText(res, 200, toSrt(timeline), ".srt", download ? `${share.slug}.srt` : null, SECURITY);
				case "transcript.txt":
					return sendText(res, 200, toText(timeline), ".txt", download ? `${share.slug}-transcript.txt` : null, SECURITY);
			}
			notFound(res);
		} catch {
			sendJson(res, 500, { error: "Server error" });
		}
	});
	server.on("error", (e) => console.error(e.code === "EADDRINUSE" ? `Share port ${SHARE_PORT} is in use. Set SHARE_PORT in .env.` : e.message));
	// Loopback only: the tunnel connects from this machine.
	server.listen(SHARE_PORT, "127.0.0.1");
	return server;
}
