// Builds the system flowchart: writes the Excalidraw elements (for the Excalidraw tool and
// the .excalidraw file) and renders docs/flowchart/system-flowchart.png with Excalidraw's
// own exporter in a hidden browser.
//   node docs/flowchart/build-flowchart.mjs
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));

const C = { blue: "#a5d8ff", purple: "#d0bfff", green: "#b2f2bb", orange: "#ffd8a8", teal: "#c3fae8", pink: "#eebefa", yellow: "#fff3bf" };
const S = { blue: "#4a9eed", purple: "#8b5cf6", green: "#22c55e", orange: "#f59e0b", teal: "#06b6d4", pink: "#ec4899", dark: "#1e1e1e" };

const els = [];
const box = (id, x, y, w, h, text, fill = C.blue, stroke = S.blue, extra = {}) =>
	els.push({ type: "rectangle", id, x, y, width: w, height: h, roundness: { type: 3 }, backgroundColor: fill, fillStyle: "solid", strokeColor: stroke, label: { text, fontSize: 20, strokeColor: S.dark }, ...extra });
const zone = (id, x, y, w, h, fill, stroke) =>
	els.push({ type: "rectangle", id, x, y, width: w, height: h, roundness: { type: 3 }, backgroundColor: fill, fillStyle: "solid", strokeColor: stroke, strokeWidth: 1, opacity: 40 });
const text = (id, x, y, t, size = 24, color = S.dark) => els.push({ type: "text", id, x, y, text: t, fontSize: size, strokeColor: color });
const arrow = (id, x, y, points, extra = {}) => {
	const xs = points.map((p) => p[0]);
	const ys = points.map((p) => p[1]);
	els.push({ type: "arrow", id, x, y, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), points, endArrowhead: "arrow", strokeColor: S.dark, strokeWidth: 2, ...extra });
};
const down = (id, x, y1, y2, extra) => arrow(id, x, y1, [[0, 0], [0, y2 - y1]], extra);

// ---- title ----
text("title", 330, -80, "Growlyze Automatic Video Recorder - how it works", 34);

// ---- lane 1: write the script ----
zone("z1", 0, 0, 440, 1000, "#dbe4ff", S.blue);
text("h1", 22, 18, "1. Write the script", 26, "#1d4ed8");
box("L1", 30, 80, 380, 80, "Open the web app\n(locked with a password)");
down("aL1", 220, 160, 200);
box("L2", 30, 200, 380, 80, "Paste a script\n(step format or plain English)");
down("aL2", 220, 280, 320);
els.push({ type: "diamond", id: "D1", x: 90, y: 320, width: 260, height: 130, backgroundColor: C.yellow, fillStyle: "solid", strokeColor: S.orange, label: { text: "Plain English?", fontSize: 20, strokeColor: S.dark } });
down("aD1", 220, 450, 500, { label: { text: "yes", fontSize: 18 } });
box("L3", 30, 500, 380, 105, "Convert with AI (Claude API)\nneeds ANTHROPIC_API_KEY\nlooks at the site, read-only", C.purple, S.purple);
down("aL3", 220, 605, 650);
arrow("aNo", 90, 385, [[0, 0], [-75, 0], [-75, 305], [-60, 305]], { label: { text: "no", fontSize: 18 } });
box("L4", 30, 650, 380, 80, "Step script\n(review and edit)");
down("aL4", 220, 730, 770);
box("L5", 30, 770, 380, 80, "Check the script\n(problems shown per line)");
down("aL5", 220, 850, 890);
box("L6", 30, 890, 380, 70, "Click Generate video", C.orange, S.orange);

// ---- lane 2: record automatically ----
zone("z2", 500, 0, 440, 1000, "#e5dbff", S.purple);
text("h2", 522, 18, "2. Record automatically", 26, "#6d28d9");
box("M1", 530, 80, 380, 105, "Make the voice (ElevenLabs API)\none clip per narration line\nvoice picked in the script", C.purple, S.purple);
down("aM1", 720, 185, 215);
box("M2", 530, 215, 380, 80, "Sign in each account once\n(saved sessions, no repeat logins)", C.purple, S.purple);
down("aM2", 720, 295, 325);
box("M3", 530, 325, 380, 80, "Open a full-screen browser\n(Playwright, kiosk window)", C.purple, S.purple);
down("aM3", 720, 405, 435);
box("M4", 530, 435, 380, 80, "OpenScreen starts recording\nthe browser window", C.purple, S.purple);
down("aM4", 720, 515, 545);
box("M5", 530, 545, 380, 105, "Play the steps: click, type,\nswitch account, scroll -\neach waits for its voice line", C.purple, S.purple);
down("aM5", 720, 650, 680);
box("M6", 530, 680, 380, 80, "Stop: OpenScreen project\n+ smooth cursor and click zooms", C.purple, S.purple);
down("aM6", 720, 760, 790);
box("M7", 530, 790, 380, 105, "Add narration + captions\n(on-device Whisper)\nexport a 1080p MP4", C.purple, S.purple);
arrow("aGo", 410, 925, [[0, 0], [60, 0], [60, -793], [120, -793]], { label: { text: "Generate", fontSize: 18 } });

// ---- lane 3: results ----
zone("z3", 1000, 0, 440, 1000, "#d3f9d8", S.green);
text("h3", 1022, 18, "3. Results", 26, "#15803d");
box("R1", 1030, 80, 380, 105, "Video folder\nMP4, transcript (txt / srt / vtt),\nnarration, project, poster", C.green, S.green);
down("aR1", 1220, 185, 225);
box("R2", 1030, 225, 380, 105, "Videos page\nwatch, jump by transcript,\ndownload, edit requests", C.green, S.green);
down("aR2", 1220, 330, 370);
box("R3", 1030, 370, 380, 80, "Create share link\n(per video, can be turned off)", C.green, S.green);
down("aR3", 1220, 450, 480);
box("R4", 1030, 480, 380, 80, "Cloudflare tunnel\nonly the watch page is public", C.orange, S.orange);
down("aR4", 1220, 560, 590);
box("R5", 1030, 590, 380, 80, "Client opens the link\nplayer + transcript + download", C.green, S.green);
box("R6", 1030, 760, 380, 105, "Logs page (by month and day)\nActions: what was clicked\nSystem: what ran automatically", C.pink, S.pink);
arrow("aOut", 910, 842, [[0, 0], [60, 0], [60, -710], [120, -710]]);
arrow("aLog", 910, 597, [[0, 0], [80, 0], [80, 215], [120, 215]], { strokeStyle: "dashed", strokeColor: S.pink });
text("logNote", 1040, 725, "every step is logged", 18, "#be185d");

// ---- external services ----
text("hx", 0, 1030, "Outside services and keys", 24);
box("X1", 0, 1075, 330, 80, "ElevenLabs API - the voice\n(ELEVENLABS_API_KEY)", C.orange, S.orange);
box("X2", 370, 1075, 330, 80, "Anthropic API - Claude\nonly for plain-English scripts", C.purple, S.purple);
box("X3", 740, 1075, 330, 80, "OpenScreen app\nrecording + export (local)", C.teal, S.teal);
box("X4", 1110, 1075, 330, 80, "Cloudflare\nshare links (free tunnel)", C.orange, S.orange);

// 1) Elements with cameras for the Excalidraw tool (guided drawing).
const cam = (x, y, w, h) => ({ type: "cameraUpdate", x, y, width: w, height: h });
const ids = (pre) => els.filter((e) => pre.some((p) => e.id.startsWith(p)));
const view = [
	cam(250, -130, 1200, 900), ...ids(["title"]),
	cam(-60, -40, 600, 450), ...ids(["z1", "h1", "L1", "aL1", "L2", "aL2", "D1", "aD1"]),
	cam(-60, 420, 600, 450), ...ids(["L3", "aL3", "aNo", "L4", "aL4", "L5", "aL5", "L6"]),
	cam(400, -40, 800, 600), ...ids(["z2", "h2", "M1", "aM1", "M2", "aM2", "M3", "aM3", "M4", "aM4"]),
	cam(400, 400, 800, 600), ...ids(["M5", "aM5", "M6", "aM6", "M7", "aGo"]),
	cam(900, -40, 800, 600), ...ids(["z3", "h3", "R1", "aR1", "R2", "aR2", "R3", "aR3", "R4", "aR4", "R5"]),
	cam(700, 300, 800, 600), ...ids(["R6", "aOut", "aLog", "logNote"]),
	cam(-80, -110, 1600, 1200), ...ids(["hx", "X1", "X2", "X3", "X4"]),
];
writeFileSync(path.join(here, "flowchart-view.json"), JSON.stringify(view));

// 2) Render a PNG with Excalidraw's own converter and exporter.
const html = `<!doctype html><html><head><meta charset="utf-8">
<script>window.EXCALIDRAW_ASSET_PATH = "https://unpkg.com/@excalidraw/excalidraw@0.17.6/dist/";</script>
<script src="https://unpkg.com/react@18.2.0/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18.2.0/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@excalidraw/excalidraw@0.17.6/dist/excalidraw.production.min.js"></script>
</head><body></body></html>`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
	const page = await browser.newPage();
	await page.setContent(html, { waitUntil: "networkidle", timeout: 90000 });
	const result = await page.evaluate(async (skeleton) => {
		const lib = window.ExcalidrawLib;
		// The tool's arrow bindings and cameras are not part of the skeleton format.
		const clean = skeleton.map(({ startBinding, endBinding, ...e }) => e);
		const elements = lib.convertToExcalidrawElements(clean);
		await document.fonts.ready;
		const blob = await lib.exportToBlob({ elements, appState: { exportBackground: true, viewBackgroundColor: "#ffffff", exportScale: 2 }, files: null, exportPadding: 40, mimeType: "image/png" });
		const buf = new Uint8Array(await blob.arrayBuffer());
		let bin = "";
		for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
		const scene = lib.serializeAsJSON(elements, { viewBackgroundColor: "#ffffff" }, {}, "local");
		return { png: btoa(bin), scene };
	}, els);
	writeFileSync(path.join(here, "system-flowchart.png"), Buffer.from(result.png, "base64"));
	writeFileSync(path.join(here, "system-flowchart.excalidraw"), result.scene);
	console.log("wrote system-flowchart.png and system-flowchart.excalidraw");
} finally {
	await browser.close();
}
