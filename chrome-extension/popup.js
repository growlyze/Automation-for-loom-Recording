const $ = (id) => document.getElementById(id);

(async () => {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	let host = "";
	try {
		host = new URL(tab.url).hostname;
		$("site").textContent = new URL(tab.url).origin;
	} catch {
		$("site").textContent = "(open a website first)";
	}
	const saved = await chrome.storage.local.get(["code", "recorder"]);
	if (saved.code) $("code").value = saved.code;
	if (saved.recorder) $("recorder").value = saved.recorder;
	$("name").value = host.replace(/^www\./, "").split(".")[0] || "";

	$("save").onclick = async () => {
		const name = $("name").value.trim().toLowerCase();
		const code = $("code").value.trim();
		const recorder = $("recorder").value.trim().replace(/\/+$/, "");
		if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(name)) return ($("msg").textContent = 'Name: lower-case letters, digits, "-" or "_".');
		if (!code) return ($("msg").textContent = "Paste the code from the recorder's Logins page.");
		await chrome.storage.local.set({ code, recorder });
		$("msg").textContent = "Saving…";
		const r = await chrome.runtime.sendMessage({ type: "capture", tabId: tab.id, name, code, recorder, profile: "" });
		$("msg").textContent = r.ok ? `Saved as "${r.name}". Scripts can use: switch ${r.name}` : r.error;
	};
})();
