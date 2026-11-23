// The browser side: a full-screen (kiosk) Chrome or Edge window driven by Playwright, with every
// pointer move and click logged on the Date.now() clock for OpenScreen's setPointerTrack.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { PipelineError } from "./openscreen.mjs";

const SELECTOR_TIMEOUT = Number(process.env.SELECTOR_TIMEOUT_MS ?? 10000);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export async function openBrowser(url, log) {
	const profile = mkdtempSync(path.join(tmpdir(), "demo-recorder-"));
	const options = {
		headless: false,
		viewport: null,
		chromiumSandbox: true,
		ignoreDefaultArgs: ["--enable-automation"],
		args: [`--app=${url}`, "--kiosk", "--lang=en-US", "--disable-features=Translate", "--hide-crash-restore-bubble"],
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
		const loc = page.locator(selector).first();
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

	async function click(selector, stepNo, action = "click") {
		const { cx, cy } = await locate(selector, stepNo, action);
		await moveTo(cx, cy);
		await sleep(150);
		logPointer(true);
		await page.mouse.down();
		await sleep(70);
		await page.mouse.up();
	}

	/** Runs one step's action. Resolves when the action itself is done. */
	async function run(step, stepNo) {
		switch (step.action) {
			case "goto":
				try {
					await page.goto(step.url, { waitUntil: "load", timeout: 60000 });
				} catch (e) {
					throw new PipelineError(`Step ${stepNo} (goto): could not open ${step.url}: ${e.message.split("\n")[0]}`);
				}
				return;
			case "click":
				return click(step.selector, stepNo);
			case "hover": {
				const { cx, cy } = await locate(step.selector, stepNo, "hover");
				return moveTo(cx, cy);
			}
			case "type": {
				await click(step.selector, stepNo, "type");
				const perChar = step.delay ?? 60;
				let i = 0;
				for (const ch of String(step.text)) {
					await page.keyboard.type(ch);
					await sleep(perChar + ((i++ * 37) % 40));
				}
				return;
			}
			case "press":
				try {
					await page.keyboard.press(step.key);
				} catch (e) {
					throw new PipelineError(`Step ${stepNo} (press): "${step.key}" is not a key Playwright knows (e.g. Enter, Tab, Escape, ArrowDown, Control+A): ${e.message.split("\n")[0]}`);
				}
				return;
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
				// Smooth wheel scroll, about 1 s.
				const steps = 30;
				for (let i = 0; i < steps; i++) {
					await page.mouse.wheel(0, dy / steps);
					await sleep(33);
				}
				return;
			}
			case "wait":
				return; // the pacing below holds for step.ms
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
