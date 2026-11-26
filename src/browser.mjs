// The browser side: a full-screen (kiosk) Chrome or Edge window driven by Playwright, with every
// pointer move and click logged on the Date.now() clock for OpenScreen's setPointerTrack.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { PipelineError } from "./openscreen.mjs";

const SELECTOR_TIMEOUT = Number(process.env.SELECTOR_TIMEOUT_MS ?? 10000);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * accounts: { [id]: storageState } of signed-in sessions (see accounts.mjs). "guest" is always
 * available: signed out. Switching swaps cookies and local storage in the one recorded window,
 * so no login happens on camera.
 */
export async function openBrowser(url, log, { accounts = {}, accountEmails = {}, onStateChange = () => {} } = {}) {
	const profile = mkdtempSync(path.join(tmpdir(), "demo-recorder-"));
	const options = {
		headless: false,
		viewport: null,
		chromiumSandbox: true,
		ignoreDefaultArgs: ["--enable-automation"],
		args: [`--app=${url}`, "--kiosk", "--lang=en-US", "--disable-features=Translate,LocalNetworkAccessChecks,LocalNetworkAccessChecksWarn,LocalNetworkAccessPermissionPrompt", "--hide-crash-restore-bubble"],
		locale: "en-US",
	};
	const channels = process.env.BROWSER_CHANNEL ? [process.env.BROWSER_CHANNEL] : ["chrome", "msedge", undefined];
	let ctx;
	let lastError;
	for (const channel of channels) {
		try {
			ctx = await chromium.launchPersistentContext(profile, { ...options, channel });
			log(`Browser: ${channel ?? "Playwright Chromium"} (kiosk window)`);
			break;
		} catch (e) {
			lastError = e;
		}
	}
	if (!ctx) throw new PipelineError(`No browser could be started (tried ${channels.map((c) => c ?? "chromium").join(", ")}): ${lastError?.message.split("\n")[0]}`);
	const page = ctx.pages()[0] ?? (await ctx.newPage());
	try {
		await page.waitForLoadState("load", { timeout: 60000 });
	} catch {
		log(`Warning: ${url} was still loading after 60 s; carrying on.`);
	}
	await sleep(1200); // let the kiosk window settle at full size
	const token = `DemoRec-${Date.now().toString(36)}`;
	await page.evaluate((t) => (document.title = t), token);

	const geom = await page.evaluate(() => ({ outerWidth, outerHeight, innerWidth, innerHeight }));
	const border = (geom.outerWidth - geom.innerWidth) / 2;
	// setPointerTrack's formula: page point -> fraction of the recorded window.
	const toWindow = (cx, cy) => ({
		x: Math.min(1, Math.max(0, (border + cx) / geom.outerWidth)),
		y: Math.min(1, Math.max(0, (geom.outerHeight - geom.innerHeight - border + cy) / geom.outerHeight)),
	});

	const events = [];
	let pos = { x: geom.innerWidth / 2, y: geom.innerHeight * 0.6 };
	const logPointer = (click = false) => events.push({ at: Date.now(), ...toWindow(pos.x, pos.y), ...(click ? { click: true } : {}) });

	const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
	async function moveTo(x, y, ms = 800) {
		const from = { ...pos };
		logPointer();
		const t0 = Date.now();
		for (;;) {
			const k = Math.min(1, (Date.now() - t0) / ms);
			const e = ease(k);
			pos = { x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e };
			await page.mouse.move(pos.x, pos.y);
			if (k >= 1) break;
			await sleep(16);
		}
		logPointer();
	}

	async function locate(selector, stepNo, action) {
		// Only visible matches: a selector like [name="description"] can also match hidden
		// elements (e.g. <meta name="description">) that come first in the page.
		const loc = page.locator(`${selector} >> visible=true`).first();
		try {
			await loc.waitFor({ state: "visible", timeout: SELECTOR_TIMEOUT });
			await loc.scrollIntoViewIfNeeded({ timeout: SELECTOR_TIMEOUT });
		} catch {
			throw new PipelineError(`Step ${stepNo} (${action}): selector not found - nothing visible matches "${selector}" on ${page.url()} after ${SELECTOR_TIMEOUT / 1000} s.`);
		}
		const box = await loc.boundingBox();
		if (!box) throw new PipelineError(`Step ${stepNo} (${action}): "${selector}" has no size on screen.`);
		return { loc, cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
	}

	/** The name a person would use for an element: its aria-label, <label>, placeholder or text. */
	async function labelOf(loc, fallback) {
		const name = await loc
			.evaluate((el) => {
				const clean = (t) => (t ?? "").replace(/\s+/g, " ").trim();
				const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
				return (
					clean(el.getAttribute("aria-label")) ||
					clean(el.labels?.[0]?.innerText) ||
					clean(byFor?.innerText) ||
					clean(el.getAttribute("placeholder")) ||
					clean(el.innerText) ||
					clean(el.getAttribute("title")) ||
					clean(el.value) ||
					clean(el.getAttribute("name"))
				);
			})
			.catch(() => "");
		const short = name.replace(/\s*\*$/, "").slice(0, 70);
		return short ? `"${short}${name.length > 70 ? "…" : ""}"` : fallback;
	}

	async function click(selector, stepNo, action = "click") {
		const { loc, cx, cy } = await locate(selector, stepNo, action);
		const label = await labelOf(loc, selector);
		await moveTo(cx, cy);
		await sleep(150);
		logPointer(true);
		await page.mouse.down();
		await sleep(70);
		await page.mouse.up();
		return label;
	}

	// ---- accounts ----
	let current = "guest";
	const states = { ...accounts };
	async function captureCurrent() {
		// Sites rotate tokens while in use: keep the newest copy for the next switch back.
		if (current === "guest" || !states[current]) return;
		try {
			const origin = new URL(page.url()).origin;
			const items = await page.evaluate(() => Object.entries(localStorage).map(([name, value]) => ({ name, value })));
			const st = states[current];
			const o = st.origins?.find((x) => x.origin === origin);
			if (o) o.localStorage = items;
			else (st.origins ??= []).push({ origin, localStorage: items });
			st.cookies = await ctx.cookies();
			onStateChange(current, st);
		} catch {}
	}
	async function switchTo(accountId, landingUrl, stepNo) {
		if (accountId !== "guest" && !states[accountId]) throw new PipelineError(`Step ${stepNo} (switch): no signed-in session for account "${accountId}".`);
		await captureCurrent();
		const target = landingUrl || url;
		const origin = new URL(target).origin;
		// Serve the pass-through robots.txt as a blank white page so its text never shows on camera.
		if (!switchTo.blank) {
			switchTo.blank = true;
			await page.route("**/robots.txt", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><html><body style=\"background:#fff\"></body></html>" }));
		}
		// Local storage can only be set on the site's own origin: pass through its tiny robots.txt
		// (a blink) rather than its home page (seconds of a marketing page on camera).
		if (new URL(page.url()).origin !== origin) await page.goto(`${origin}/robots.txt`, { waitUntil: "domcontentloaded", timeout: 60000 });
		const st = accountId === "guest" ? { cookies: [], origins: [] } : states[accountId];
		await ctx.clearCookies();
		if (st.cookies?.length) await ctx.addCookies(st.cookies);
		const items = st.origins?.find((o) => o.origin === origin)?.localStorage ?? [];
		const setStorage = () =>
			page.evaluate((items) => {
				localStorage.clear();
				sessionStorage.clear();
				for (const { name, value } of items) localStorage.setItem(name, value);
			}, items);
		try {
			await setStorage();
		} catch {
			// Sandboxed pages (e.g. HTML served by an n8n webhook) can't touch local storage:
			// set it from the site's plain robots.txt page instead.
			await page.goto(`${origin}/robots.txt`, { waitUntil: "domcontentloaded", timeout: 60000 });
			await setStorage();
		}
		await page.goto(target, { waitUntil: "load", timeout: 60000 });
		current = accountId;
		if (accountId !== "guest" && (await page.locator('input[type="password"]').first().isVisible().catch(() => false))) {
			throw new PipelineError(`Step ${stepNo} (switch): the saved session for "${accountId}" was rejected by the site. Run again to sign in fresh.`);
		}
	}

	/**
	 * Runs one step's action. Resolves, when the action itself is done, with a plain-English
	 * description of what was done (for the Actions log), e.g. 'Clicked "Payments"'.
	 */
	async function run(step, stepNo) {
		switch (step.action) {
			case "switch": {
				await switchTo(step.account, step.url, stepNo);
				const who = step.account === "guest" ? "signed out (guest view)" : `account "${step.account}"${accountEmails[step.account] ? ` (${accountEmails[step.account]})` : ""}`;
				return `Switched to ${who}${step.url ? ` on ${step.url}` : ""}`;
			}
			case "goto":
				try {
					await page.goto(step.url, { waitUntil: "load", timeout: 60000 });
				} catch (e) {
					throw new PipelineError(`Step ${stepNo} (goto): could not open ${step.url}: ${e.message.split("\n")[0]}`);
				}
				return `Opened ${step.url}`;
			case "click":
				return `Clicked ${await click(step.selector, stepNo)}`;
			case "hover": {
				// "@x,y": a point on the screen, in percent from the top-left. For canvas apps (e.g. a
				// Make scenario diagram) where there's no element to aim at.
				const at = /^@\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)$/.exec(step.selector);
				if (at) {
					await moveTo((Number(at[1]) / 100) * geom.innerWidth, (Number(at[2]) / 100) * geom.innerHeight);
					return `Pointed at ${at[1]}%, ${at[2]}% of the screen`;
				}
				const { loc, cx, cy } = await locate(step.selector, stepNo, "hover");
				const label = await labelOf(loc, step.selector);
				await moveTo(cx, cy);
				return `Pointed at ${label}`;
			}
			case "type": {
				const label = await click(step.selector, stepNo, "type");
				const perChar = step.delay ?? 60;
				let i = 0;
				for (const ch of String(step.text)) {
					await page.keyboard.type(ch);
					await sleep(perChar + ((i++ * 37) % 40));
				}
				return `Typed "${step.text}" into ${label}`;
			}
			case "press":
				try {
					await page.keyboard.press(step.key);
				} catch (e) {
					throw new PipelineError(`Step ${stepNo} (press): "${step.key}" is not a key Playwright knows (e.g. Enter, Tab, Escape, ArrowDown, Control+A): ${e.message.split("\n")[0]}`);
				}
				return `Pressed ${step.key}`;
			case "scroll": {
				let dy = step.y;
				if (step.selector) {
					const loc = page.locator(step.selector).first();
					try {
						await loc.waitFor({ state: "attached", timeout: SELECTOR_TIMEOUT });
					} catch {
						throw new PipelineError(`Step ${stepNo} (scroll): selector not found - nothing matches "${step.selector}" on ${page.url()}.`);
					}
					const top = await loc.evaluate((el) => el.getBoundingClientRect().top);
					dy = top - 120;
				}
				// The wheel scrolls whatever is under the pointer: after a sidebar click that is the
				// sidebar, so glide onto the main content first.
				if (pos.x < geom.innerWidth * 0.3 || pos.y < geom.innerHeight * 0.15) await moveTo(geom.innerWidth * 0.62, geom.innerHeight * 0.55, 500);
				// Smooth wheel scroll, about 1 s.
				const steps = 30;
				for (let i = 0; i < steps; i++) {
					await page.mouse.wheel(0, dy / steps);
					await sleep(33);
				}
				return step.selector ? `Scrolled to ${step.selector}` : `Scrolled ${dy >= 0 ? "down" : "up"} ${Math.abs(Math.round(dy))} px`;
			}
			case "blur":
				return `Blurred ${step.regions.length} area(s) of the screen for privacy`;
			case "unblur":
				return "Removed the privacy blur";
			case "wait":
				return step.ms ? `Waited ${(step.ms / 1000).toFixed(1)} s` : null; // the pacing below holds for step.ms
			default:
				throw new PipelineError(`Step ${stepNo}: unknown action "${step.action}".`);
		}
	}

	/** Parks the pointer off-centre so the first frames have a cursor to glide from. */
	async function park() {
		await page.mouse.move(pos.x, pos.y);
		logPointer();
	}

	return {
		page,
		token,
		geom,
		events,
		run,
		park,
		captureCurrent,
		states,
		/** Re-applies the window title OpenScreen finds the window by (a navigation resets it). */
		async markWindow() {
			await page.evaluate((t) => (document.title = t), token).catch(() => {});
		},
		async screenshot(file) {
			await page.screenshot({ path: file }).catch(() => {});
		},
		async close() {
			await ctx.close().catch(() => {});
			try {
				rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
			} catch {
				// The profile folder is temporary; Windows may still hold a lock on it.
			}
		},
	};
}

export { sleep };
