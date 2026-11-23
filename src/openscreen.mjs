// Finding and running OpenScreen: the CLI (record, export, captions) and its MCP server.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export class PipelineError extends Error {}

const usable = (file) => {
	try {
		// accessSync, not existsSync: existsSync reports the Store execution alias as missing.
		accessSync(file, constants.F_OK);
		return true;
	} catch {
		return false;
	}
};

let cached;
/** Path of the OpenScreen executable, or a clear error saying how to install it. */
export function findOpenScreen() {
	if (cached) return cached;
	const checked = [];
	const tryFile = (f) => {
		checked.push(f);
		return usable(f) ? f : null;
	};
	if (process.env.OPENSCREEN_EXE) {
		cached = tryFile(process.env.OPENSCREEN_EXE);
	} else {
		const local = process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local");
		cached =
			tryFile(path.join(local, "Programs", "Openscreen", "Openscreen.exe")) ??
			tryFile(path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Openscreen", "Openscreen.exe")) ??
			tryFile(path.join(local, "Microsoft", "WindowsApps", "openscreen.exe"));
	}
	if (!cached) {
		throw new PipelineError(
			`OpenScreen is not installed (looked in: ${checked.join(", ")}).\n` +
				"Install it with:  winget install --source msstore OpenScreen\n" +
				"or set OPENSCREEN_EXE in .env to the path of Openscreen.exe.",
		);
	}
	return cached;
}

/** Environment for OpenScreen: without ELECTRON_RUN_AS_NODE, which VS Code sets and which turns the app into plain Node. */
export function openScreenEnv() {
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	return env;
}

/**
 * Runs an OpenScreen CLI command with --json and resolves with its `done` event.
 * onEvent gets every NDJSON event as it arrives.
 */
export function runCli(args, { onEvent, log } = {}) {
	const exe = findOpenScreen();
	return new Promise((resolve, reject) => {
		const child = spawn(exe, [...args, "--json"], {
			env: openScreenEnv(),
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let done = null;
		let lastError = null;
		let stderr = "";
		let buf = "";
		child.stdout.on("data", (chunk) => {
			buf += chunk.toString();
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i).trim();
				buf = buf.slice(i + 1);
				if (!line.startsWith("{")) continue;
				let ev;
				try {
					ev = JSON.parse(line);
				} catch {
					continue;
				}
				log?.(`openscreen ${args[0]}: ${line.length > 400 ? `${line.slice(0, 400)}…` : line}`);
				if (ev.event === "done") done = ev;
				if (ev.event === "error") lastError = ev.message;
				onEvent?.(ev);
			}
		});
		child.stderr.on("data", (c) => {
			stderr += c.toString();
			if (stderr.length > 20000) stderr = stderr.slice(-20000);
		});
		child.on("error", (e) => reject(new PipelineError(`Could not start OpenScreen (${exe}): ${e.message}`)));
		child.on("close", (code) => {
			if (stderr) log?.(`openscreen ${args[0]} stderr (tail):\n${stderr.slice(-3000)}`);
			if (code === 0 && done?.success !== false) return resolve(done ?? {});
			const why = done?.error ?? lastError ?? stderr.trim().split("\n").slice(-3).join(" ") ?? "";
			reject(new PipelineError(`openscreen ${args[0]} failed (exit ${code}): ${why}`));
		});
		runCli.lastChild = child;
	});
}

/** Starts `openscreen record` and returns a handle to stop it and wait for its result. */
export function startRecording(args, { log } = {}) {
	let startedResolve;
	let startedReject;
	const started = new Promise((res, rej) => {
		startedResolve = res;
		startedReject = rej;
	});
	const finished = runCli(["record", ...args], {
		log,
		onEvent: (ev) => {
			if (ev.event === "log" && /recording started/i.test(ev.message ?? "")) startedResolve(Date.now());
		},
	});
	const child = runCli.lastChild;
	finished.catch((e) => startedReject(e));
	return {
		started,
		finished,
		stop() {
			if (child.exitCode === null) child.stdin.write("stop\n");
			return finished;
		},
	};
}

/** Connects to `openscreen mcp` over stdio. */
export async function connectOpenScreen() {
	const transport = new StdioClientTransport({
		command: findOpenScreen(),
		args: ["mcp"],
		env: openScreenEnv(),
		stderr: "pipe",
	});
	const client = new Client({ name: "demo-recorder", version: "1.0.0" });
	await client.connect(transport);
	return {
		client,
		/** Calls a tool and returns its parsed JSON result, throwing on a tool error. */
		async call(name, args, { timeoutMs = 10 * 60 * 1000 } = {}) {
			const res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
			const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
			if (res.isError) throw new PipelineError(`OpenScreen ${name} failed: ${text}`);
			if (res.structuredContent) return res.structuredContent;
			// Some tools answer with a JSON line followed by a sentence of advice.
			for (const candidate of [text, text.split("\n")[0]]) {
				try {
					return JSON.parse(candidate);
				} catch {
					// Try the next form.
				}
			}
			return { text };
		},
		close: () => client.close(),
	};
}

export function ffmpegPath() {
	const ff = process.env.FFMPEG || "ffmpeg";
	if (spawnSync(ff, ["-version"], { stdio: "ignore" }).error) {
		throw new PipelineError("ffmpeg was not found on the PATH. Install it (winget install Gyan.FFmpeg) or set FFMPEG in .env.");
	}
	return ff;
}
