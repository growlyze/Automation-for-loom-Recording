// Password lock for the web interface. The password lives in .env (UI_PASSWORD), never in the
// code. A successful login gets a signed, HttpOnly cookie valid for UI_SESSION_DAYS (default 7);
// changing the password signs everyone out.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./env.mjs";

const COOKIE = "dr_session";
const sha = (s) => createHash("sha256").update(String(s)).digest();

export const authEnabled = () => !!process.env.UI_PASSWORD;

// A random secret kept on this machine, so cookies survive a restart but can't be forged.
function secret() {
	const file = path.join(ROOT, ".cache", "session-secret");
	if (!existsSync(file)) {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, randomBytes(32).toString("hex"));
	}
	// Mixing in the password means a new password invalidates every existing session.
	return createHmac("sha256", readFileSync(file, "utf8").trim()).update(sha(process.env.UI_PASSWORD ?? "")).digest();
}
const sign = (payload) => createHmac("sha256", secret()).update(payload).digest("base64url");

export function checkPassword(given) {
	const a = sha(given ?? "");
	const b = sha(process.env.UI_PASSWORD ?? "");
	return timingSafeEqual(a, b);
}

export function sessionCookie() {
	const days = Number(process.env.UI_SESSION_DAYS ?? 7);
	const exp = Date.now() + days * 86400000;
	const payload = `${exp}.${randomBytes(8).toString("base64url")}`;
	return `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.round(days * 86400)}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

export function isLoggedIn(req) {
	if (!authEnabled()) return true;
	const raw = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
	if (!raw) return false;
	const value = raw.slice(COOKIE.length + 1);
	const i = value.lastIndexOf(".");
	if (i < 0) return false;
	const payload = value.slice(0, i);
	const sig = Buffer.from(value.slice(i + 1));
	const expected = Buffer.from(sign(payload));
	if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return false;
	return Number(payload.split(".")[0]) > Date.now();
}

// Slows down guessing: after 5 wrong passwords in 10 minutes, wait a minute.
const failures = [];
export function loginBlockedFor() {
	const now = Date.now();
	while (failures.length && now - failures[0] > 10 * 60000) failures.shift();
	if (failures.length < 5) return 0;
	return Math.max(0, failures.at(-1) + 60000 - now);
}
export const recordFailure = () => failures.push(Date.now());
export const resetFailures = () => (failures.length = 0);

export const loginPage = (error = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Growlyze Automatic Video Recorder - Sign in</title><meta name="robots" content="noindex">
<link rel="stylesheet" href="/theme.css">
<style>
body{min-height:100vh;display:grid;place-items:center;padding:16px}
.card{width:100%;max-width:400px;padding:30px 30px 28px;box-shadow:var(--shadow-lg)}
.brandbar{display:flex;align-items:center;gap:12px;background:var(--dark);color:var(--cream);margin:-30px -30px 24px;padding:16px 22px;border-radius:8px 8px 0 0;border-bottom:2px solid var(--dark)}
.lock{display:inline-block;background:var(--orange);color:#fff;font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;padding:3px 9px;border-radius:6px;border:1.5px solid var(--dark);margin-bottom:10px}
h1{font-size:1.4rem;margin-bottom:6px}
p{color:var(--muted);margin:0 0 20px;font-size:14px;font-weight:500}
.pw{position:relative}.pw input{padding-right:70px}
.show{position:absolute;right:6px;top:50%;transform:translateY(-50%);border:0;box-shadow:none;background:none;padding:6px 8px;font-size:13px;color:var(--orange)}
.show:hover{background:none;color:var(--dark)}.show:active{transform:translateY(-50%)}
button.go{width:100%;margin-top:18px;padding:11px;font-size:15px}
.err{background:var(--bad-bg);color:var(--bad);border:2px solid var(--bad);border-radius:8px;padding:8px 12px;font-size:13px;font-weight:500;margin-bottom:16px}
</style></head><body>
<form class="card" method="post" action="/login">
<div class="brandbar"><span class="brand"><span class="mark"></span><span class="name"><b>Growlyze</b><span>Automatic Video Recorder</span></span></span></div>
<span class="lock">Locked</span>
<h1>Sign in to continue</h1>
<p>This workspace is private. Enter the password to open it.</p>
${error ? `<div class="err">${error}</div>` : ""}
<label for="pw">Password</label>
<div class="pw"><input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
<button type="button" class="show" onclick="const i=document.getElementById('pw');i.type=i.type==='password'?'text':'password';this.textContent=i.type==='password'?'Show':'Hide'">Show</button></div>
<button class="go primary" type="submit">Unlock</button>
</form></body></html>`;
