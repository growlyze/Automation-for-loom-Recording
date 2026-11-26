// Saved logins: sign in to a site once in a normal Chrome window (any way: email and password,
// Google, 2-step codes) and save that session under a name. Scripts then use it with
// "switch <name>" - no email or password in the script.
//
// Each saved login keeps its own Chrome profile in .cache/logins/profiles/, so a Google sign-in
// stays signed in there too and signing in again later is usually one click.
// Files (git-ignored, on this PC only):
//   .cache/logins/index.json                 [{ name, origin, savedAt, checkedAt, status }]
//   .cache/logins/<host>/<name>.json         the session (cookies, local storage, IndexedDB)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { ROOT } from "./env.mjs";

const DIR = path.join(ROOT, ".cache", "logins");
const INDEX = path.join(DIR, "index.json");
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;
const PASSWORD_FIELD = 'input[type="password"] >> visible=true';

const hostDir = (origin) => new URL(origin).host.replace(/[^\w.-]/g, "_");
const stateFile = (origin, name) => path.join(DIR, hostDir(origin), `${name}.json`);
const profileDir = (origin, name) => path.join(DIR, "profiles", `${hostDir(origin)}-${name}`);
export const originOf = (url) => {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
};

const readIndex = () => {
	try {
		return JSON.parse(readFileSync(INDEX, "utf8"));
	} catch {
		return [];
	}
};
const writeIndex = (list) => {
	mkdirSync(DIR, { recursive: true });
	writeFileSync(INDEX, JSON.stringify(list, null, 2));
};
const upsert = (entry) => {
	const list = readIndex().filter((l) => !(l.origin === entry.origin && l.name === entry.name));
	list.push(entry);
	writeIndex(list.sort((a, b) => (a.origin + a.name).localeCompare(b.origin + b.name)));
};

/** Every saved login, optionally only for one site. */
export function listLogins(origin) {
	return readIndex().filter((l) => !origin || l.origin === origin);
}
/** Names of the logins saved for the site of `url` (used by script validation). */
export function savedLoginNames(url) {
	const origin = originOf(url);
	return origin ? listLogins(origin).map((l) => l.name) : [];
}
/** The saved session for a login, or null. */
export function loadLogin(url, name) {
	const origin = originOf(url);
	const file = origin && stateFile(origin, name);
	if (!file || !existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}
/** Stores a newer copy of a session (sites rotate tokens while in use). */
export function updateLogin(url, name, state) {
	const origin = originOf(url);
	if (!origin || !existsSync(stateFile(origin, name))) return;
	writeFileSync(stateFile(origin, name), JSON.stringify(state));
}
export function deleteLogin(origin, name) {
	rmSync(stateFile(origin, name), { force: true });
	rmSync(profileDir(origin, name), { recursive: true, force: true, maxRetries: 3 });
	writeIndex(readIndex().filter((l) => !(l.origin === origin && l.name === name)));
}

// ---------------- signing in (a real, visible Chrome window) ----------------
const captures = new Map(); // id -> { id, name, origin, url, port, child, startedAt }

function findChrome() {
	const candidates = [
		process.env.CHROME_PATH,
		"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
		path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
		"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
		"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	].filter(Boolean);
	return candidates.find((c) => existsSync(c)) ?? null;
}
const freePort = () =>
	new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});

/**
 * Opens a normal Chrome window at `url` with this login's own profile, for the person to sign
 * in. Not automated: Google and other sign-in pages treat it as an ordinary browser.
 */
export async function startCapture({ url, name }) {
	const origin = originOf(url);
	if (!origin || !/^https?:/.test(origin)) throw new Error("Enter the site's full address, e.g. https://app.example.com");
	if (!NAME_RE.test(name ?? "")) throw new Error('Give the login a short name: lower-case letters, digits, "-" or "_" (e.g. admin).');
	for (const c of captures.values()) if (c.origin === origin && c.name === name) return view(c);
	const chrome = findChrome();
	if (!chrome) throw new Error("Chrome or Edge was not found. Install Google Chrome, or set CHROME_PATH in .env.");
	const port = await freePort();
	const profile = profileDir(origin, name);
	mkdirSync(profile, { recursive: true });
	const child = spawn(chrome, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check", "--new-window", url], {
		stdio: "ignore",
		windowsHide: false,
	});
	const c = { id: Math.random().toString(36).slice(2, 10), name, origin, url, port, child, startedAt: new Date().toISOString(), closed: false };
	child.on("exit", () => (c.closed = true));
	captures.set(c.id, c);
	return view(c);
}
const view = ({ id, name, origin, url, startedAt, closed, port }) => ({ id, name, origin, url, startedAt, closed, port });
export const activeCaptures = () => [...captures.values()].map(view);

/**
 * Reads the signed-in session from the open window and saves it. Refuses (and keeps the window
 * open) while the site still shows a password field, i.e. sign-in isn't finished.
 */
export async function finishCapture(id, { force = false } = {}) {
	const c = captures.get(id);
	if (!c) throw new Error("That sign-in window is no longer open. Start again.");
	if (c.closed) {
		captures.delete(c.id);
		throw new Error("The Chrome window was closed before the login was saved. Start again, and click Save login while the window is still open.");
	}
	const { chromium } = await import("playwright");
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${c.port}`, { timeout: 15000 });
	try {
		const ctx = browser.contexts()[0];
		const pages = ctx.pages().filter((p) => originOf(p.url()) === c.origin);
		if (!pages.length && !force) return { saved: false, reason: `No tab is open on ${c.origin}. Go back to the site in that window (signed in), then click Save login again.` };
		for (const p of pages) {
			if (!force && (await p.locator(PASSWORD_FIELD).count().catch(() => 0))) {
				return { saved: false, reason: "The site still shows a password field: finish signing in in the Chrome window, then click Save login again." };
			}
		}
		const state = await ctx.storageState({ indexedDB: true }).catch(() => ctx.storageState());
		mkdirSync(path.dirname(stateFile(c.origin, c.name)), { recursive: true });
		writeFileSync(stateFile(c.origin, c.name), JSON.stringify(state));
		const now = new Date().toISOString();
		upsert({ name: c.name, origin: c.origin, savedAt: now, checkedAt: now, status: "valid" });
	} finally {
		await browser.close().catch(() => {}); // disconnects
	}
	closeCapture(c);
	return { saved: true, name: c.name, origin: c.origin };
}
function closeCapture(c) {
	try {
		c.child.kill();
	} catch {}
	captures.delete(c.id);
}
export function cancelCapture(id) {
	const c = captures.get(id);
	if (c) closeCapture(c);
}
process.on("exit", () => {
	for (const c of captures.values()) {
		try {
			c.child.kill();
		} catch {}
	}
});

// ---------------- logins from your own Chrome (via the extension) ----------------
// The "Growlyze Recorder - Save login" extension (chrome-extension/), installed in a Chrome
// profile, copies a site's session from that profile and sends it here with this code.
const CODE_FILE = path.join(ROOT, ".cache", "extension-code");
export function extensionCode() {
	if (!existsSync(CODE_FILE)) {
		mkdirSync(path.dirname(CODE_FILE), { recursive: true });
		writeFileSync(CODE_FILE, Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8));
	}
	return readFileSync(CODE_FILE, "utf8").trim();
}
export function checkExtensionCode(given) {
	const a = Buffer.from(String(given ?? ""));
	const b = Buffer.from(extensionCode());
	return a.length === b.length && a.equals(b);
}

/** Chrome profiles on this PC, with the Google account each is signed into. */
export function chromeProfiles() {
	const file = path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "User Data", "Local State");
	try {
		const s = JSON.parse(readFileSync(file, "utf8"));
		const cache = s.profile?.info_cache ?? {};
		const order = s.profile?.profiles_order ?? Object.keys(cache);
		return order
			.filter((dir) => cache[dir])
			.map((dir) => ({ dir, name: cache[dir].name || dir, email: cache[dir].user_name || "", lastUsed: dir === s.profile?.last_used }));
	} catch {
		return [];
	}
}

const fromChrome = new Map(); // `${origin}|${name}` -> { name, origin, profile, email, status, error, startedAt }
export const chromeRequests = () => [...fromChrome.values()];

/** Opens the site in the person's own Chrome profile; the extension copies the session. */
export function openInChrome({ profile, url, name, recorderUrl }) {
	const origin = originOf(url);
	if (!origin || !/^https?:/.test(origin)) throw new Error("Enter the site's full address, e.g. https://www.make.com");
	if (!NAME_RE.test(name ?? "")) throw new Error('Give the login a short name: lower-case letters, digits, "-" or "_" (e.g. make).');
	const p = chromeProfiles().find((x) => x.dir === profile);
	if (!p) throw new Error("Pick one of your Chrome profiles.");
	const chrome = findChrome();
	if (!chrome || /msedge/i.test(chrome)) throw new Error("Google Chrome was not found on this PC.");
	const capture = `${recorderUrl}/ext/capture?${new URLSearchParams({ site: url, name, code: extensionCode(), profile })}`;
	spawn(chrome, [`--profile-directory=${profile}`, capture], { stdio: "ignore", detached: true }).unref();
	const req = { name, origin, profile, profileName: p.name, email: p.email, status: "waiting", error: null, startedAt: new Date().toISOString() };
	fromChrome.set(`${origin}|${name}`, req);
	return req;
}

/** Stores a session the extension sent from the person's Chrome. */
export function saveImported({ name, site, state, profile }) {
	const origin = originOf(site);
	if (!origin) throw new Error("Bad site address.");
	if (!NAME_RE.test(name ?? "")) throw new Error("Bad login name.");
	if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw new Error("No session was sent.");
	mkdirSync(path.dirname(stateFile(origin, name)), { recursive: true });
	writeFileSync(stateFile(origin, name), JSON.stringify(state));
	const p = chromeProfiles().find((x) => x.dir === profile);
	const now = new Date().toISOString();
	upsert({ name, origin, savedAt: now, checkedAt: now, status: "valid", via: "chrome", ...(p ? { profile: p.dir, profileName: p.name, email: p.email } : {}) });
	const req = fromChrome.get(`${origin}|${name}`);
	if (req) Object.assign(req, { status: "saved" });
	return { name, origin };
}
export function importFailed({ name, site, error }) {
	const req = fromChrome.get(`${originOf(site)}|${name}`);
	if (req) Object.assign(req, { status: "failed", error: String(error ?? "").slice(0, 300) });
}
export function clearChromeRequest(origin, name) {
	fromChrome.delete(`${origin}|${name}`);
}

/** Opens the site with the saved session (hidden browser): still signed in? Updates the index. */
export async function checkLogin(url, name, browser) {
	const origin = originOf(url);
	const state = loadLogin(origin, name);
	if (!state) return { name, origin, status: "missing" };
	const { chromium } = await import("playwright");
	const own = !browser;
	browser ??= await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true }).catch(() => chromium.launch({ headless: true }));
	let status = "valid";
	try {
		// A normal Chrome identity: some sites (NetSuite, n8n pages) turn "HeadlessChrome" away.
		const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, storageState: state, userAgent });
		const page = await ctx.newPage();
		// The page the video opens, not the bare origin: on some sites (NetSuite) the root is the sign-in page.
		const target = /^https?:\/\/[^/]+\/./.test(String(url)) ? url : origin;
		await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
		await page.waitForTimeout(2000);
		if (await page.locator(PASSWORD_FIELD).count().catch(() => 0)) status = "expired";
		await ctx.close();
	} catch {
		status = "unreachable";
	} finally {
		if (own) await browser.close().catch(() => {});
	}
	const entry = listLogins(origin).find((l) => l.name === name);
	if (entry) upsert({ ...entry, checkedAt: new Date().toISOString(), status });
	return { name, origin, status };
}
