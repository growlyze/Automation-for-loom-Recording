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
<title>Demo Recorder - Sign in</title><meta name="robots" content="noindex">
<style>
:root{--bg:#f6f7f9;--surface:#fff;--border:#dfe3e8;--text:#16191d;--muted:#5d6773;--accent:#2f6fed;--bad:#c4321c;--bad-bg:#fbe7e3;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#111317;--surface:#1a1d22;--border:#2f343b;--text:#e8eaed;--muted:#9aa3ad;--accent:#5b8ff9;--bad:#ff8a75;--bad-bg:#3a1d18;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 "Segoe UI",system-ui,sans-serif;padding:16px}
.card{width:100%;max-width:360px;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:28px;box-shadow:0 8px 30px rgba(0,0,0,.06)}
.brand{display:flex;align-items:center;gap:8px;font-weight:650;font-size:17px;margin-bottom:4px}.dot{width:10px;height:10px;border-radius:50%;background:#c4321c}
p{color:var(--muted);margin:0 0 20px;font-size:14px}
label{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px}
.pw{position:relative}input{width:100%;font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 64px 10px 12px}
input:focus{outline:2px solid var(--accent);outline-offset:-1px}
.show{position:absolute;right:6px;top:50%;transform:translateY(-50%);border:0;background:none;color:var(--accent);font:inherit;font-size:13px;cursor:pointer;padding:6px}
button.go{width:100%;margin-top:16px;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{background:var(--bad-bg);color:var(--bad);border-radius:8px;padding:8px 12px;font-size:13px;margin-bottom:14px}
</style></head><body>
<form class="card" method="post" action="/login">
<div class="brand"><span class="dot"></span>Demo Recorder</div>
<p>This workspace is locked. Enter the password to continue.</p>
${error ? `<div class="err">${error}</div>` : ""}
<label for="pw">Password</label>
<div class="pw"><input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
<button type="button" class="show" onclick="const i=document.getElementById('pw');i.type=i.type==='password'?'text':'password';this.textContent=i.type==='password'?'Show':'Hide'">Show</button></div>
<button class="go" type="submit">Unlock</button>
</form></body></html>`;
