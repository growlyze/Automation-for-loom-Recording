// Milestone 1: record ~10 s of one URL in a full-screen app window and export it.
//   node scripts/smoke.mjs [url]
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { connectOpenScreen } from "../src/openscreen.mjs";

const url = process.argv[2] ?? "https://example.com";
const out = path.resolve("output", "_smoke");
mkdirSync(out, { recursive: true });
const token = `DemoRec-${Date.now().toString(36)}`;

const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), "demorec-")), {
	channel: "chrome",
	headless: false,
	viewport: null,
	chromiumSandbox: true,
	ignoreDefaultArgs: ["--enable-automation"],
	args: [`--app=${url}`, "--kiosk"],
});
await new Promise((r) => setTimeout(r, 1500));
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.waitForLoadState("load");
await page.evaluate((t) => (document.title = t), token);
console.log("window size", await page.evaluate(() => [outerWidth, outerHeight, innerWidth, innerHeight, devicePixelRatio]));

const os = await connectOpenScreen();
try {
	console.log("sources", JSON.stringify(await os.call("listSources", {})).slice(0, 1500));
	const rec = await os.call("startRecording", { window: token });
	console.log("startRecording", JSON.stringify(rec));
	await page.waitForTimeout(10000);
	const stop = await os.call("stopRecording", { title: "smoke test" });
	console.log("stopRecording", JSON.stringify(stop));
	await ctx.close();
	const exp = await os.call("exportVideo", { projectId: stop.projectId, path: path.join(out, "smoke.mp4"), fps: 30 });
	console.log("exportVideo", JSON.stringify(exp));
} finally {
	await ctx.close().catch(() => {});
	await os.close();
}
