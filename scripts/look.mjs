// Dev helper: prints a page's visible interactive elements, as the AI converter sees them.
//   node scripts/look.mjs <url> [account-email]   (logs in through the saved session if an email is given)
import { chromium } from "playwright";
import { loadEnv } from "../src/env.mjs";
import { snapshot } from "../src/page-snapshot.mjs";

loadEnv();
const [url, email] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
	let context;
	if (email) {
		const { ensureSession } = await import("../src/accounts.mjs");
		const state = await ensureSession(browser, { url, account: { id: "x", email, password: process.env.LOOK_PASSWORD }, log: console.log });
		context = await browser.newContext({ viewport: { width: 1280, height: 720 }, storageState: state });
	} else {
		context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	}
	const page = await context.newPage();
	await page.goto(url, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
	await page.waitForTimeout(1500);
	console.log(await snapshot(page));
} finally {
	await browser.close();
}
