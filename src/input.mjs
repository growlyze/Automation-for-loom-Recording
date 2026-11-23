// Reads and validates a video input file (JSON).
import { readFileSync } from "node:fs";
import { PipelineError } from "./openscreen.mjs";

export const ACTIONS = {
	goto: { required: ["url"], help: '{ "action": "goto", "url": "https://..." }' },
	click: { required: ["selector"], help: '{ "action": "click", "selector": "text=Sign up" }' },
	type: { required: ["selector", "text"], help: '{ "action": "type", "selector": "#email", "text": "demo@test.com" }' },
	press: { required: ["key"], help: '{ "action": "press", "key": "Enter" }' },
	hover: { required: ["selector"], help: '{ "action": "hover", "selector": ".menu" }' },
	scroll: { required: [], help: '{ "action": "scroll", "selector": "#pricing" }  or  { "action": "scroll", "y": 600 }' },
	wait: { required: [], help: '{ "action": "wait", "ms": 1500 }' },
};

const RESOLUTIONS = { "1920x1080": "good", "1280x720": "medium", source: "source" };

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
	});
	spec.quality = RESOLUTIONS[spec.resolution];
	spec.slug = slugify(spec.title);
	return errors;
}
