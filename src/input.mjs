// Reads and validates a video input file (JSON).
import { readFileSync } from "node:fs";
import { savedLoginNames } from "./logins.mjs";
import { PipelineError } from "./openscreen.mjs";

export const ACTIONS = {
	goto: { required: ["url"], help: '{ "action": "goto", "url": "https://..." }' },
	click: { required: ["selector"], help: '{ "action": "click", "selector": "text=Sign up" }' },
	type: { required: ["selector", "text"], help: '{ "action": "type", "selector": "#email", "text": "demo@test.com" }' },
	press: { required: ["key"], help: '{ "action": "press", "key": "Enter" }' },
	hover: { required: ["selector"], help: '{ "action": "hover", "selector": ".menu" }' },
	scroll: { required: [], help: '{ "action": "scroll", "selector": "#pricing" }  or  { "action": "scroll", "y": 600 }' },
	wait: { required: [], help: '{ "action": "wait", "ms": 1500 }' },
	blur: { required: ["regions"], help: '{ "action": "blur", "regions": [{ "x": 21, "y": 25, "w": 55, "h": 75 }] }  (percent of the screen, from the top-left)' },
	unblur: { required: [], help: '{ "action": "unblur" }' },
	switch: { required: ["account"], help: '{ "action": "switch", "account": "admin" }  (or "guest" for signed out)' },
};

const RESOLUTIONS = { "1920x1080": "good", "1280x720": "medium", source: "source" };

/**
 * Turns pasted script text into a spec. Accepts JSON (the file format) or the simple text format:
 *
 *   Title: How to sign up              <- settings: Title, URL, Resolution, Captions, Voice
 *   URL: https://example.com
 *   goto https://example.com | Welcome! Let's sign up.
 *   click text=Sign up | Click Sign up at the top.
 *   type #email "demo@test.com" | Enter your email.
 *   press Enter
 *   scroll #pricing | Here are the plans.   (or: scroll 600)
 *   wait 1500 | And you're in.
 *
 * One step per line; the text after " | " is the narration. Lines starting with # are notes.
 * Returns { spec, errors }.
 */
export function parseScript(text) {
	const src = String(text ?? "").replace(/^﻿/, "").trim();
	if (!src) return { spec: null, errors: ["The script is empty. Paste a script first."] };
	if (src.startsWith("{")) {
		try {
			return { spec: JSON.parse(src), errors: [] };
		} catch (e) {
			return { spec: null, errors: [`The script looks like JSON but isn't valid JSON: ${e.message}`] };
		}
	}
	const spec = { steps: [] };
	const errors = [];
	const settings = { title: "title", url: "url", resolution: "resolution", captions: "captions", voice: "voice", fps: "fps" };
	src.split(/\r?\n/).forEach((raw, i) => {
		const line = raw.trim();
		const where = `Line ${i + 1}`;
		if (!line || line.startsWith("#") || line.startsWith("//")) return;
		const setting = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
		if (setting && setting[1].toLowerCase() === "account") {
			// Account: admin | admin@site.com | MySecret1
			const [id, email, ...pw] = setting[2].split("|").map((x) => x.trim());
			if (!id || !email || !pw.length) {
				errors.push(`${where}: write accounts as  Account: <name> | <email> | <password>  e.g. Account: admin | admin@site.com | Secret123`);
				return;
			}
			// "-" as the email = a password-only login.
			(spec.accounts ??= []).push({ id: id.toLowerCase().replace(/\s+/g, "-"), label: id, email: email === "-" ? "" : email, password: pw.join("|") });
			return;
		}
		if (setting && setting[1].toLowerCase() === "login") {
			spec.login = { url: setting[2].trim() };
			return;
		}
		if (setting && settings[setting[1].toLowerCase()] && !/^(https?|file):/i.test(line)) {
			const key = settings[setting[1].toLowerCase()];
			let value = setting[2].trim();
			if (key === "captions") value = /^(on|yes|true|1)$/i.test(value);
			if (key === "fps") value = Number(value);
			spec[key] = value;
			return;
		}
		// "action args | narration" - split on the first " | " so selectors may contain "|"-free text.
		const bar = line.search(/\s\|\s|\s\|$/);
		const head = (bar >= 0 ? line.slice(0, bar) : line).trim();
		const say = bar >= 0 ? line.slice(bar).replace(/^\s*\|\s*/, "").trim() : "";
		const [rawWord, ...restParts] = head.split(/\s+/);
		// "click? ..." marks a step optional: skipped (narration still plays) if it can't be done.
		const optional = rawWord.endsWith("?");
		const word = rawWord.replace(/\?$/, "");
		const action = word.toLowerCase();
		const rest = restParts.join(" ").trim();
		const step = { action, ...(optional ? { optional: true } : {}) };
		switch (action) {
			case "switch":
			case "as": {
				// switch <account> [landing url]
				step.action = "switch";
				const [acc, landing] = rest.split(/\s+/);
				step.account = (acc ?? "").toLowerCase();
				if (landing) step.url = landing;
				if (!acc) {
					errors.push(`${where}: write  switch <account>  e.g. switch admin  (or switch guest for signed out)`);
					return;
				}
				break;
			}
			case "goto":
			case "open":
				step.action = "goto";
				step.url = rest;
				break;
			case "click":
			case "hover":
				step.selector = rest;
				break;
			case "type": {
				// type <selector> "text"  - the text is the last quoted part
				const m = /^(.*?)\s+(["'])(.*)\2\s*$/.exec(rest);
				if (!m) {
					errors.push(`${where}: write type steps as  type <field> "text to type"  e.g. type #email "demo@test.com"`);
					return;
				}
				step.selector = m[1].trim();
				step.text = m[3];
				break;
			}
			case "press":
				step.key = rest;
				break;
			case "scroll":
				if (/^-?\d+$/.test(rest)) step.y = Number(rest);
				else step.selector = rest;
				break;
			case "wait":
			case "pause": {
				step.action = "wait";
				const ms = /^(\d+(?:\.\d+)?)\s*(ms|s)?$/i.exec(rest || "1000");
				if (!ms) {
					errors.push(`${where}: write wait steps as  wait 1500  (milliseconds) or  wait 2s`);
					return;
				}
				step.ms = Math.round(Number(ms[1]) * (ms[2]?.toLowerCase() === "s" ? 1000 : 1));
				break;
			}
			case "blur": {
				// blur <left> <top> <width> <height> [; more areas]  (percent of the screen)
				const regions = rest.split(";").map((part) => part.trim().split(/[\s,]+/).map(Number)).filter((n) => n.length === 4);
				if (!regions.length || regions.some((n) => n.some((v) => !Number.isFinite(v)))) {
					errors.push(`${where}: write blur steps as  blur <left> <top> <width> <height>  in percent of the screen, e.g. blur 21 25 55 75  (separate several areas with ;)`);
					return;
				}
				step.regions = regions.map(([x, y, w, h]) => ({ x, y, w, h }));
				break;
			}
			case "unblur":
				break;
			case "say":
				// narration with no action: hold still while it is spoken
				step.action = "wait";
				step.ms = 0;
				step.say = [rest, say].filter(Boolean).join(" | ");
				spec.steps.push(step);
				return;
			default:
				errors.push(`${where}: "${word}" is not a step. Start each line with goto, click, type, press, hover, scroll, wait, say, switch or blur.`);
				return;
		}
		if (say) step.say = say;
		spec.steps.push(step);
	});
	if (!spec.url) spec.url = spec.steps.find((s) => s.action === "goto")?.url;
	// Mostly lines that aren't steps: this is a script written in plain English (e.g. a Loom
	// script). Say so once, instead of listing every line.
	const lines = src.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
	const notSteps = errors.filter((e) => /is not a step/.test(e)).length;
	if (notSteps >= 3 && notSteps / lines.length >= 0.3) {
		return { spec: null, prose: true, errors: ["This looks like a script written in plain English, not in the step format. Click “Convert with AI” to turn it into steps, or write it in the step format (see Script format below)."] };
	}
	return { spec, errors };
}

function isUrl(u) {
	if (typeof u !== "string") return false;
	try {
		const url = new URL(u);
		return url.protocol === "file:" || (/^https?:$/.test(url.protocol) && (url.hostname.includes(".") || url.hostname === "localhost" || url.hostname.startsWith("[")));
	} catch {
		return false;
	}
}

export function slugify(s) {
	return (
		String(s)
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "video"
	);
}

export function readInput(file) {
	let raw;
	try {
		raw = readFileSync(file, "utf8");
	} catch (e) {
		throw new PipelineError(`Cannot read the input file ${file}: ${e.code === "ENOENT" ? "it does not exist" : e.message}`);
	}
	let spec;
	try {
		spec = JSON.parse(raw.replace(/^﻿/, ""));
	} catch (e) {
		throw new PipelineError(`${file} is not valid JSON: ${e.message}`);
	}
	const errors = validateSpec(spec);
	if (errors.length) throw new PipelineError(`The input file ${file} has problems:\n  - ${errors.join("\n  - ")}`);
	return spec;
}

/** Checks a parsed spec, fills in defaults, and returns the list of problems (empty when valid). */
export function validateSpec(spec) {
	const errors = [];
	if (!spec || typeof spec !== "object" || Array.isArray(spec)) return ["The script must be one JSON object."];
	if (typeof spec.title !== "string" || !spec.title.trim()) errors.push('"title" is required (a non-empty string).');
	if (!isUrl(spec.url)) errors.push('"url" is required and must be a full address starting with http://, https:// or file://.');
	spec.resolution ??= "1920x1080";
	if (!RESOLUTIONS[spec.resolution]) errors.push(`"resolution" must be one of ${Object.keys(RESOLUTIONS).join(", ")} (got "${spec.resolution}").`);
	spec.captions ??= false;
	if (typeof spec.captions !== "boolean") errors.push('"captions" must be true or false.');
	if (spec.voice !== undefined && spec.voice !== null && !(typeof spec.voice === "string" && /^[A-Za-z0-9]{10,40}$/.test(spec.voice))) {
		errors.push('"voice" must be an ElevenLabs voice ID (letters and digits, e.g. "XrExE9yKIg1WjnnlVkGX"). Run npm run voices to list them.');
	}
	spec.fps ??= 30;
	if (![24, 30, 60].includes(spec.fps)) errors.push('"fps" must be 24, 30 or 60.');
	if (!Array.isArray(spec.steps) || spec.steps.length === 0) errors.push('"steps" is required: a non-empty list of steps.');
	const accountIds = new Set(["guest"]);
	// Account names are case-insensitive: store them lower-case.
	if (Array.isArray(spec.accounts)) for (const a of spec.accounts) if (typeof a?.id === "string") a.id = a.id.trim().toLowerCase();
	for (const s of Array.isArray(spec.steps) ? spec.steps : []) if (typeof s?.account === "string") s.account = s.account.trim().toLowerCase();
	if (spec.accounts !== undefined) {
		if (!Array.isArray(spec.accounts)) errors.push('"accounts" must be a list of { "id", "email", "password" }.');
		else
			spec.accounts.forEach((a, i) => {
				if (!a || typeof a !== "object") return errors.push(`Account ${i + 1} must be an object.`);
				if (!/^[a-z0-9][a-z0-9_-]{0,30}$/i.test(a.id ?? "")) errors.push(`Account ${i + 1}: "id" is required (a short name like "admin").`);
				else if (accountIds.has(a.id.toLowerCase())) errors.push(`Account "${a.id}" is listed twice${a.id.toLowerCase() === "guest" ? ' ("guest" is reserved for signed out)' : ""}.`);
				else accountIds.add(a.id.toLowerCase());
				// Email may be empty for a password-only login page.
				if (a.email !== undefined && a.email !== "" && (typeof a.email !== "string" || !a.email.includes("@"))) errors.push(`Account "${a.id ?? i + 1}": "email" must be an email address (or empty for a password-only login).`);
				if (typeof a.password !== "string") errors.push(`Account "${a.id ?? i + 1}": "password" is required.`);
			});
	}
	if (spec.login !== undefined && (typeof spec.login !== "object" || (spec.login.url !== undefined && !isUrl(spec.login.url)))) errors.push('"login" must be { "url": "https://.../login" } (optional "emailSelector", "passwordSelector", "submitSelector").');
	// Logins saved on the Logins page for this site count as accounts too (no password needed).
	const saved = isUrl(spec.url) ? savedLoginNames(spec.url) : [];
	for (const name of saved) accountIds.add(name);

	(spec.steps ?? []).forEach((step, i) => {
		const where = `Step ${i + 1}`;
		if (!step || typeof step !== "object") return errors.push(`${where} must be an object.`);
		const def = ACTIONS[step.action];
		if (!def) return errors.push(`${where}: unknown action "${step.action}". Use one of: ${Object.keys(ACTIONS).join(", ")}.`);
		for (const key of def.required) {
			if (step[key] === undefined || step[key] === "") errors.push(`${where} (${step.action}) needs "${key}", e.g. ${def.help}`);
		}
		if (step.action === "goto" && step.url !== undefined && step.url !== "" && !isUrl(step.url)) errors.push(`${where} (goto): "${step.url}" is not a full address (http://, https:// or file://).`);
		if (step.say !== undefined && (typeof step.say !== "string" || !step.say.trim())) errors.push(`${where}: "say" must be a non-empty string when present.`);
		if (step.ms !== undefined && !(Number.isFinite(step.ms) && step.ms >= 0)) errors.push(`${where}: "ms" must be a number of milliseconds.`);
		if (step.pause !== undefined && !(Number.isFinite(step.pause) && step.pause >= 0)) errors.push(`${where}: "pause" must be a number of milliseconds.`);
		if (step.action === "scroll" && step.selector === undefined && !Number.isFinite(step.y)) errors.push(`${where} (scroll) needs "selector" or "y" (pixels), e.g. ${def.help}`);
		// A switch with its own address (another site) uses the logins saved for that site.
		const siteSaved = step.action === "switch" && isUrl(step.url) ? savedLoginNames(step.url) : saved;
		if (step.action === "switch" && step.account && !accountIds.has(String(step.account).toLowerCase()) && !siteSaved.includes(String(step.account).toLowerCase())) {
			errors.push(
				`${where} (switch): no login "${step.account}" for ${isUrl(step.url) ? new URL(step.url).origin : "this site"}. Save one on the Logins page (sign in once, no password in the script), or add an Account: line.` +
					(siteSaved.length ? ` Saved logins for that site: ${siteSaved.join(", ")}.` : ""),
			);
		}
		if (step.action === "switch" && step.url !== undefined && !isUrl(step.url)) errors.push(`${where} (switch): "${step.url}" is not a full address.`);
		if (step.action === "blur") {
			const ok = Array.isArray(step.regions) && step.regions.length > 0 && step.regions.every((r) => ["x", "y", "w", "h"].every((k) => Number.isFinite(r?.[k]) && r[k] >= 0 && r[k] <= 100) && r.w > 0 && r.h > 0 && r.x + r.w <= 100.5 && r.y + r.h <= 100.5);
			if (!ok) errors.push(`${where} (blur): give each area as left top width height, in percent of the screen (0-100), e.g. blur 21 25 55 75`);
		}
		if (step.optional !== undefined && typeof step.optional !== "boolean") errors.push(`${where}: "optional" must be true or false.`);
	});
	spec.quality = RESOLUTIONS[spec.resolution];
	spec.slug = slugify(spec.title);
	return errors;
}
