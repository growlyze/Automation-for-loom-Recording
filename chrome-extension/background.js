// Growlyze Recorder - Save login.
// Copies one site's signed-in session (its cookies and local storage) from this Chrome profile to
// the recorder running on this PC, so videos can use the login without a password.
// It only ever sends to the recorder on localhost / 127.0.0.1, and only with the recorder's code.
//
// Two ways it runs:
//  1. Automatic: the recorder opens http://localhost:<port>/ext/capture?site=...&name=...&code=...
//     in this profile. The extension opens the site in that tab, copies its session and sends it.
//  2. By hand: on the site, click the extension button, give the login a name, click Save.

const isRecorder = (origin) => /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/.test(origin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SAME_SITE = { no_restriction: "None", lax: "Lax", strict: "Strict", unspecified: "Lax" };
function toPlaywrightCookie(c) {
	const sameSite = SAME_SITE[c.sameSite] ?? "Lax";
	return {
		name: c.name,
		value: c.value,
		domain: c.hostOnly ? c.domain.replace(/^\./, "") : c.domain.startsWith(".") ? c.domain : `.${c.domain}`,
		path: c.path,
		expires: c.session || !c.expirationDate ? -1 : Math.floor(c.expirationDate),
		httpOnly: c.httpOnly,
		secure: c.secure || sameSite === "None",
		sameSite,
	};
}

/** Waits until the tab has finished loading a page on `origin`. */
function waitForSite(tabId, origin, timeout = 45000) {
	return new Promise((resolve, reject) => {
		const done = (ok) => {
			chrome.tabs.onUpdated.removeListener(listener);
			clearTimeout(timer);
			ok ? resolve() : reject(new Error("The site took too long to load."));
		};
		const listener = (id, info, tab) => {
			if (id === tabId && info.status === "complete" && tab.url && new URL(tab.url).origin === origin) done(true);
		};
		const timer = setTimeout(() => done(false), timeout);
		chrome.tabs.onUpdated.addListener(listener);
	});
}

async function toast(tabId, text, ok = true) {
	await chrome.scripting
		.executeScript({
			target: { tabId },
			args: [text, ok],
			func: (text, ok) => {
				const el = document.createElement("div");
				el.textContent = text;
				el.style.cssText = `position:fixed;z-index:2147483647;top:18px;right:18px;max-width:380px;padding:12px 16px;border:2px solid #140827;border-radius:10px;box-shadow:4px 4px 0 #140827;font:600 14px system-ui,sans-serif;color:#140827;background:${ok ? "#86dbb2" : "#ffd9c7"}`;
				document.body.appendChild(el);
				setTimeout(() => el.remove(), 7000);
			},
		})
		.catch(() => {});
}

/** Copies the session of the site open in `tabId` and sends it to the recorder. */
async function captureTab(tabId, { name, recorder, code, profile }) {
	const tab = await chrome.tabs.get(tabId);
	const url = new URL(tab.url);
	if (!/^https?:$/.test(url.protocol)) throw new Error("Open the website first (an http or https page).");
	// Cookies this page receives, plus every cookie of its main domain (e.g. *.make.com).
	const main = url.hostname.split(".").slice(-2).join(".");
	const cookies = [...(await chrome.cookies.getAll({ url: url.href })), ...(await chrome.cookies.getAll({ domain: main }))];
	const unique = new Map(cookies.map((c) => [`${c.name}|${c.domain}|${c.path}`, c]));
	const [{ result: page }] = await chrome.scripting.executeScript({
		target: { tabId },
		func: () => ({
			localStorage: Object.entries(localStorage).map(([name, value]) => ({ name, value })),
			signedOut: [...document.querySelectorAll('input[type="password"]')].some((e) => e.offsetParent !== null),
		}),
	});
	if (page.signedOut) throw new Error("This site shows a sign-in form in this Chrome profile. Sign in here first, then save again.");
	const res = await fetch(`${recorder}/api/ext/import`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-recorder-code": code },
		body: JSON.stringify({
			name,
			site: url.origin,
			profile,
			state: { cookies: [...unique.values()].map(toPlaywrightCookie), origins: [{ origin: url.origin, localStorage: page.localStorage }] },
		}),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error || `The recorder answered ${res.status}.`);
	return data;
}

// Automatic mode: the recorder opened its capture page in this profile.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
	if (info.status !== "complete" || !tab.url) return;
	let u;
	try {
		u = new URL(tab.url);
	} catch {
		return;
	}
	if (!isRecorder(u.origin) || u.pathname !== "/ext/capture") return;
	const site = u.searchParams.get("site");
	const name = u.searchParams.get("name");
	const code = u.searchParams.get("code");
	const profile = u.searchParams.get("profile") || "";
	if (!site || !name || !code) return;
	await chrome.storage.local.set({ recorder: u.origin, code });
	let siteOrigin;
	try {
		siteOrigin = new URL(site).origin;
	} catch {
		return;
	}
	try {
		await chrome.tabs.update(tabId, { url: site });
		await waitForSite(tabId, siteOrigin);
		await sleep(2500); // let the site finish restoring its session
		const r = await captureTab(tabId, { name, recorder: u.origin, code, profile });
		await toast(tabId, `Saved to the Growlyze Recorder as "${r.name}". You can close this tab.`);
	} catch (e) {
		await toast(tabId, `Growlyze Recorder: ${e.message}`, false);
		fetch(`${u.origin}/api/ext/failed`, { method: "POST", headers: { "content-type": "application/json", "x-recorder-code": code }, body: JSON.stringify({ name, site: siteOrigin, error: e.message }) }).catch(() => {});
	}
});

// By hand: the popup asks the worker to capture the active tab.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
	if (msg?.type !== "capture") return;
	captureTab(msg.tabId, msg)
		.then((r) => reply({ ok: true, name: r.name }))
		.catch((e) => reply({ ok: false, error: e.message }));
	return true;
});
