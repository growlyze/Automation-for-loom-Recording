import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const MIME = {
	".html": "text/html; charset=utf-8",
	".mp4": "video/mp4",
	".wav": "audio/wav",
	".png": "image/png",
	".jpg": "image/jpeg",
	".json": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".srt": "application/x-subrip; charset=utf-8",
	".vtt": "text/vtt; charset=utf-8",
	".openscreen": "application/json",
};

export const readJson = (f, fallback = null) => {
	try {
		return JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, ""));
	} catch {
		return fallback;
	}
};

export function sendJson(res, status, body) {
	res.writeHead(status, { "content-type": MIME[".json"], "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

export function sendText(res, status, text, ext = ".txt", downloadName = null, extra = {}) {
	const headers = { "content-type": MIME[ext] ?? MIME[".txt"], "cache-control": "no-store", ...extra };
	if (downloadName) headers["content-disposition"] = `attachment; filename="${downloadName}"`;
	res.writeHead(status, headers);
	res.end(text);
}

/** Streams a file with Range support, so a browser can seek in a video. */
export function serveFile(req, res, file, { download = false, downloadName = null, extra = {} } = {}) {
	if (!existsSync(file)) return sendJson(res, 404, { error: "Not found" });
	const size = statSync(file).size;
	const headers = { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "accept-ranges": "bytes", "cache-control": "no-store", ...extra };
	if (download) headers["content-disposition"] = `attachment; filename="${downloadName ?? path.basename(file)}"`;
	const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
	if (range && (range[1] || range[2])) {
		const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
		const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
		if (start >= size || start > end) {
			res.writeHead(416, { "content-range": `bytes */${size}` });
			return res.end();
		}
		res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
		if (req.method === "HEAD") return res.end();
		return createReadStream(file, { start, end }).pipe(res);
	}
	res.writeHead(200, { ...headers, "content-length": size });
	if (req.method === "HEAD") return res.end();
	createReadStream(file).pipe(res);
}

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
