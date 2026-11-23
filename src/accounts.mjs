// Accounts for multi-role videos: log each account in once, keep its session (cookies and
// local storage) in .cache/sessions/, and reuse it on later runs. Sites that block repeated
// logins never see more than one login per account while its session stays valid.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./env.mjs";
import { PipelineError } from "./openscreen.mjs";

const SESSIONS = path.join(ROOT, ".cache", "sessions");
const EMAIL_FIELDS = ['input[type="email"]', "#email", 'input[name*="email" i]', 'input[autocomplete="username"]', 'input[name*="user" i]', 'input[id*="email" i]'];
const PASSWORD_FIELDS = ['input[type="password"]'];
const SUBMIT = ['button[type="submit"]', 'role=button[name=/^(sign in|log in|login|continue|unlock)$/i]', 'input[type="submit"]'];

// Password-only logins (no email) are keyed by "password-only" for the site.
const sessionFile = (url, email) => {
	const host = new URL(url).host.replace(/[^\w.-]/g, "_");
	return path.join(SESSIONS, host, `${createHash("sha256").update((email || "password-only").toLowerCase()).digest("hex").slice(0, 16)}.json`);
};

async function first(page, selectors, timeout = 0) {
	for (const s of selectors) {
		const loc = page.locator(s).first();
		try {
			if (timeout) await loc.waitFor({ state: "visible", timeout });
			if (await loc.isVisible()) return loc;
		} catch {}
	}
	return null;
}

/** True when the page shows a password field, i.e. the account is signed out. */
async function onLoginPage(page) {
	return !!(await first(page, PASSWORD_FIELDS));
}

async function signIn(page, { loginUrl, account, login = {}, log }) {
	await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
	// Password-only lock pages (no email) are supported: leave the account's email empty.
	const needsEmail = !!account.email;
	const email = !needsEmail ? null : login.emailSelector ? page.locator(login.emailSelector).first() : await first(page, EMAIL_FIELDS, 15000);
	const password = login.passwordSelector ? page.locator(login.passwordSelector).first() : await first(page, PASSWORD_FIELDS, needsEmail ? 5000 : 15000);
	if ((needsEmail && !email) || !password) throw new PipelineError(`Could not find the login form at ${loginUrl}. Set "login": { "url", "emailSelector", "passwordSelector" } in the script.`);
	if (email) await email.fill(account.email);
	await password.fill(account.password ?? "");
	const submit = login.submitSelector ? page.locator(login.submitSelector).first() : await first(page, SUBMIT);
	if (submit) await submit.click();
	else await password.press("Enter");
	// Signed in once the password field is gone.
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		await page.waitForTimeout(500);
		if (!(await onLoginPage(page))) return;
	}
	const message = await page
		.locator('[role="alert"], .error, .alert, [class*="error" i], [class*="toast" i]')
		.allInnerTexts()
		.then((t) => t.map((x) => x.trim()).filter(Boolean).join(" ").slice(0, 200))
		.catch(() => "");
	throw new PipelineError(`Login failed for ${account.email}${message ? `: "${message}"` : ""}. Check the email and password${/many|limit|blocked|wait/i.test(message) ? ", or wait a few minutes: the site is limiting logins" : ""}.`);
}

/**
 * Returns a Playwright storageState for the account, signed in. Reuses the saved session when it
 * still works; otherwise signs in (once) and saves the new session.
 */
export async function ensureSession(browser, { url, account, login = {}, log = () => {} }) {
	const file = sessionFile(url, account.email);
	const loginUrl = login.url || url;
	const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...(existsSync(file) ? { storageState: file } : {}) });
	try {
		const page = await context.newPage();
		if (existsSync(file)) {
			await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
			await page.waitForTimeout(1500);
			if (!(await onLoginPage(page))) {
				log(`  ${account.label ?? account.email}: saved session still valid.`);
				return JSON.parse(readFileSync(file, "utf8"));
			}
			log(`  ${account.label ?? account.email}: saved session expired - signing in again.`);
			rmSync(file, { force: true });
		}
		log(`  ${account.label ?? account.email}: signing in...`);
		await signIn(page, { loginUrl, account, login, log });
		await page.waitForTimeout(1000);
		const state = await context.storageState();
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(state));
		return state;
	} finally {
		await context.close();
	}
}

/** Saves a session's newer state (rotated tokens) for the next run. */
export function saveSession(url, email, state) {
	const file = sessionFile(url, email);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(state));
}

/**
 * Signs in every account of a script (each only if its saved session no longer works) and
 * returns { [id]: storageState }. Logins are spaced out, for sites that limit them.
 */
export async function prepareAccounts(spec, log) {
	if (!spec.accounts?.length) return {};
	const { chromium } = await import("playwright");
	const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true }).catch(() => chromium.launch({ headless: true }));
	const states = {};
	try {
		let lastLogin = 0;
		for (const account of spec.accounts) {
			const wait = lastLogin + 3000 - Date.now();
			if (wait > 0) await new Promise((r) => setTimeout(r, wait));
			const before = Date.now();
			states[account.id] = await ensureSession(browser, { url: spec.url, account: { ...account, label: account.label ?? account.id }, login: spec.login, log });
			if (Date.now() - before > 4000) lastLogin = Date.now(); // a real login happened
		}
	} finally {
		await browser.close();
	}
	return states;
}

/** Forgets the saved session (e.g. after the site logged it out). */
export const dropSession = (url, email) => rmSync(sessionFile(url, email), { force: true });
