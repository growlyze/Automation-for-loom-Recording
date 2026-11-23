// A permanent log of every video run, grouped by month and day (local time):
//   logs/2026-11/2026-11-23/151114-growlyze-property-ai-agent.log   the full log of one run
//   logs/runs.jsonl                                               one summary line per run event
// A run appends a "running" line when it starts and a final line when it ends; the last line for
// an id wins. A run whose process was killed stays "running" until it is marked "interrupted".
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./env.mjs";

export const LOGS = path.join(ROOT, "logs");
const INDEX = path.join(LOGS, "runs.jsonl");
const pad = (n, w = 2) => String(n).padStart(w, "0");

export function localParts(d = new Date()) {
	const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	return { month: day.slice(0, 7), day, time: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` };
}
/** "15:11:14.779" in local time. */
export const clockTime = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;

const appendIndex = (entry) => {
	mkdirSync(LOGS, { recursive: true });
	appendFileSync(INDEX, `${JSON.stringify(entry)}\n`);
};

/** Starts a run log. `name` labels the file until the video's slug is known. */
export function startRun({ script, pid = process.pid, kind = "video", title }) {
	const now = new Date();
	const { month, day, time } = localParts(now);
	const id = `${day.replaceAll("-", "")}-${time}-${Math.random().toString(36).slice(2, 6)}`;
	const dir = path.join(LOGS, month, day);
	mkdirSync(dir, { recursive: true });
	let file = path.join(dir, `${time}-${kind === "video" ? id.slice(-4) : `${kind}-${id.slice(-4)}`}.log`);
	const base = { id, kind, script, pid, month, day, startedAt: now.toISOString(), ...(title ? { title } : {}) };
	appendIndex({ ...base, status: "running" });
	let meta = { ...base };
	return {
		id,
		get file() {
			return file;
		},
		append(line) {
			appendFileSync(file, `${line}\n`);
		},
		/** Names the log file after the video once its slug is known, and records the title. */
		describe({ slug, title }) {
			meta = { ...meta, slug, title };
			const named = path.join(dir, `${time}-${slug}.log`);
			if (!existsSync(named)) {
				try {
					if (existsSync(file)) renameSync(file, named);
					file = named;
				} catch {}
			}
			appendIndex({ ...meta, status: "running", file: path.relative(LOGS, file).replaceAll("\\", "/") });
		},
		finish({ status, error = null, extra = {} }) {
			const endedAt = new Date();
			appendIndex({
				...meta,
				...extra,
				status,
				error,
				file: path.relative(LOGS, file).replaceAll("\\", "/"),
				endedAt: endedAt.toISOString(),
				durationMs: endedAt - now,
			});
		},
	};
}

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** Every run, newest first, one record each (the last line per id wins). */
export function listRuns() {
	if (!existsSync(INDEX)) return [];
	const byId = new Map();
	for (const line of readFileSync(INDEX, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line);
			byId.set(e.id, { ...byId.get(e.id), ...e });
		} catch {}
	}
	const runs = [...byId.values()];
	for (const r of runs) if (r.status === "running" && r.pid && !alive(r.pid)) r.status = "interrupted";
	return runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export function readRunLog(run) {
	if (!run?.file) return "";
	const file = path.join(LOGS, run.file);
	if (!path.resolve(file).startsWith(path.resolve(LOGS))) return "";
	return existsSync(file) ? readFileSync(file, "utf8") : "";
}
