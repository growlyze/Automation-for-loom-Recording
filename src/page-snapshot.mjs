// A compact, text description of what is on a page: headings and the visible interactive
// elements, each with a selector that was checked to match exactly that element. Used by the
// AI script converter (and scripts/look.mjs) to pick reliable selectors.

/** Returns a text snapshot of the page, at most `limit` elements. */
export async function snapshot(page, { limit = 160 } = {}) {
	const data = await page.evaluate((limit) => {
		const visible = (el) => {
			const r = el.getBoundingClientRect();
			const s = getComputedStyle(el);
			return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
		};
		const clean = (t) => (t ?? "").replace(/\s+/g, " ").trim();
		const nameOf = (el) =>
			clean(el.getAttribute("aria-label")) ||
			clean(el.innerText) ||
			clean(el.getAttribute("title")) ||
			clean(el.getAttribute("placeholder")) ||
			clean(el.value) ||
			clean(el.getAttribute("name")) ||
			"";
		const roleOf = (el) => {
			const r = el.getAttribute("role");
			if (r) return r;
			const t = el.tagName.toLowerCase();
			if (t === "a") return "link";
			if (t === "button") return "button";
			if (t === "select") return "select";
			if (t === "textarea") return "textarea";
			if (t === "input") return `input:${el.type || "text"}`;
			if (t === "summary") return "button";
			return t;
		};
		const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,[class*=CardHeader] [class*=title],legend")]
			.filter(visible)
			.map((h) => {
				const y = Math.round(h.getBoundingClientRect().y);
				return `${clean(h.innerText)}${y > innerHeight ? ` (below the fold, y=${y})` : ""}`;
			})
			.filter((t) => !t.startsWith(" ("))
			.slice(0, 25);
		const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=option],[contenteditable=true]';
		const out = [];
		const seen = new Set();
		for (const el of document.querySelectorAll(sel)) {
			if (!visible(el) || seen.has(el)) continue;
			seen.add(el);
			const r = el.getBoundingClientRect();
			out.push({
				i: out.length,
				role: roleOf(el),
				name: nameOf(el).slice(0, 80),
				id: el.id || null,
				nameAttr: el.getAttribute("name"),
				placeholder: el.getAttribute("placeholder"),
				type: el.getAttribute("type"),
				href: el.tagName === "A" ? el.getAttribute("href") : null,
				disabled: !!el.disabled,
				inForm: !!el.closest("form"),
				box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
			});
			if (out.length >= limit) break;
		}
		return { url: location.href, title: document.title, headings, elements: out, viewportHeight: innerHeight, scrollY: Math.round(scrollY), pageHeight: document.documentElement.scrollHeight };
	}, limit);

	// Pick the simplest selector that matches exactly one visible element.
	const unique = async (s) => {
		try {
			const loc = page.locator(s);
			const n = await loc.count();
			if (n === 1) return true;
			if (n > 1) {
				let visibleCount = 0;
				for (let k = 0; k < Math.min(n, 6); k++) if (await loc.nth(k).isVisible()) visibleCount++;
				return visibleCount === 1;
			}
		} catch {}
		return false;
	};
	const q = (s) => s.replace(/"/g, '\\"');
	for (const e of data.elements) {
		const cands = [];
		if (e.id && /^[A-Za-z][\w-]*$/.test(e.id)) cands.push(`#${e.id}`);
		if (e.name && e.name.length <= 40 && !e.role.startsWith("input")) {
			const role = { link: "link", button: "button", tab: "tab", menuitem: "menuitem" }[e.role];
			if (role) cands.push(`role=${role}[name="${q(e.name)}"]`);
			cands.push(`text="${q(e.name)}"`);
		}
		if (e.nameAttr) cands.push(`[name="${q(e.nameAttr)}"]`);
		if (e.placeholder) cands.push(`[placeholder="${q(e.placeholder)}"]`);
		if (e.role.startsWith("input") && e.type) cands.push(`input[type="${e.type}"]`);
		if (e.href && e.href.length < 80) cands.push(`a[href="${q(e.href)}"]`);
		e.selector = null;
		for (const c of cands) {
			if (await unique(c)) {
				e.selector = c;
				break;
			}
		}
	}
	const lines = [
		`URL: ${data.url}`,
		`Title: ${data.title}`,
		`Viewport height ${data.viewportHeight}px, page height ${data.pageHeight}px, scrolled ${data.scrollY}px`,
		data.headings.length ? `Headings: ${data.headings.join(" | ")}` : "Headings: (none)",
		"Interactive elements (role · name · selector):",
		...data.elements.map(
			(e) =>
				`  [${e.i}] ${e.role}${e.disabled ? " (disabled)" : ""} · "${e.name}"${e.placeholder && e.placeholder !== e.name ? ` placeholder="${e.placeholder}"` : ""} · ${e.selector ?? "(no unique selector)"}${e.inForm ? " · in form" : ""}${e.box[1] > data.viewportHeight ? ` · below the fold (y=${e.box[1]})` : ""}`,
		),
	];
	return lines.join("\n");
}
