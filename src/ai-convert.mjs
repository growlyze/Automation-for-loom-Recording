// Plain-English script -> step script, with Claude.
//
// Claude reads the script, then explores the real site in a hidden browser on this PC to find a
// selector for every button and field it mentions, and hands back a script in the step format
// (see parseScript in input.mjs). Exploring is read-only: the click tool refuses anything that
// would submit or change data, so converting never alters the site. The result goes through
// the same validator as a pasted script before it is accepted.
import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { chromium } from "playwright";
import { ensureSession } from "./accounts.mjs";
import { parseScript, slugify, validateSpec } from "./input.mjs";
import { PipelineError } from "./openscreen.mjs";
import { snapshot } from "./page-snapshot.mjs";
import { clockTime, startRun } from "./runlog.mjs";

export const CONVERT_MODEL = process.env.CONVERT_MODEL?.trim() || "claude-opus-5-5";
export const converterAvailable = () => !!process.env.ANTHROPIC_API_KEY?.trim();

// Words on buttons that change data. Links (plain navigation) are allowed whatever they say,
// except signing out.
const CHANGES_DATA = /\b(delete|remove|start|stop|approve|reject|decline|accept|complete|finish|hold|pay|confirm|submit|save|archive|terminate|send request|create|add payment|update|resolve|close ticket|mark)\b/i;
const SIGN_OUT = /\b(sign ?out|log ?out)\b/i;

const SYSTEM = `You turn a demo-video script written in plain English into a step script that a recorder plays back in a real browser, with an AI voice reading the narration.

## Output format (submit it with the submit_script tool)

Title: <video title>
URL: <site URL>
Captions: on
Account: <id> | <email> | <password>        (one line per account; id is a short lower-case role name, e.g. admin)

Then one step per line, narration after " | ":
  switch <account> [url] | narration     show that account's screen; accounts are signed in automatically before recording, so NEVER script a login. "switch guest <login page url>" shows the signed-out login page.
  click <selector> | narration
  type <selector> "text" | narration
  press <key>
  hover <selector>
  scroll <pixels> | narration             e.g. scroll 450 (scrolls the main content)
  wait <ms>
  say <narration>                         narration with no action
Add "?" after the action word (click?, type?) for steps that can only work once on the live data (e.g. starting a job, sending a quote, approving): on a re-run they are skipped and the narration still plays.
Lines starting with # are comments: use them to mark the script's sections.

## Rules
- Keep every narration line WORD FOR WORD as the script gives it. You may split a sentence at a comma or full stop so each part plays while its action happens, but never reword, add or drop narration.
- Do what the script says, in its order, and click only what it asks for. "Prep" notes and instructions to the presenter are not steps. Skip pages the script says to skip.
- Find every selector on the real site with your tools. Prefer, in order: role=link[name="..."], role=button[name="..."], [name="..."], [placeholder="..."], #id. When several elements match (e.g. the same button on many cards), scope it: .MuiCardContent-root:has-text("Clogged kitchen drain") >> role=button[name="Start"]. Use ">> nth=-1" only as a last resort.
- Test every selector you use with test_selector on the page where the step runs: it must match exactly one visible element.
- Forms: open them (click the button or link that opens them) and look for required fields (labels ending in *). Fill every required field the script doesn't mention with a short, realistic value, so the submit works.
- When narration mentions something the snapshot marks "below the fold", add a scroll step (with that part of the narration) so viewers see it.
- While exploring you cannot click anything that saves or changes data; the click tool refuses. That is expected: still use those elements' selectors in the script.
- Sign in with sign_in once per account, then use its id in the other tools. Logins are limited on some sites: never sign in the same account twice.
- Be efficient: look at each page once, and test selectors in batches with test_selector.
- When done, call submit_script. If it is rejected, fix the problems and submit again. Your final message after an accepted script is one short sentence.`;

export async function convertScript(prose, { onLine = () => {}, signal } = {}) {
	if (!converterAvailable()) {
		throw new PipelineError("Converting plain-English scripts needs an Anthropic API key. Add ANTHROPIC_API_KEY=... to .env (console.anthropic.com > API Keys), then restart the UI.");
	}
	const firstLine = String(prose).split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 80) ?? "script";
	const run = startRun({ script: "(pasted script)", kind: "convert", title: `Convert: ${firstLine}` });
	const write = (type, msg) => {
		const line = `[${clockTime()}] [${type}] ${msg}`;
		run.append(line);
		onLine(line);
	};
	const system = (msg) => write("SYSTEM", msg);
	const action = (msg) => write("ACTION", msg);

	const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true }).catch(() => chromium.launch({ headless: true }));
	const pages = new Map(); // account id -> { ctx, page }
	let lastLogin = 0;
	let accepted = null;

	const pageOf = async (account) => {
		const id = String(account).toLowerCase();
		if (pages.has(id)) return pages.get(id).page;
		if (id === "guest") {
			const ctx = await browser.newContext({ viewport: { width: 1920 / 1.5, height: 1080 / 1.5 } });
			const page = await ctx.newPage();
			pages.set(id, { ctx, page });
			return page;
		}
		throw new Error(`Unknown account "${account}". Call sign_in for it first (or use "guest").`);
	};
	const settle = async (page) => {
		await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
		await page.waitForTimeout(700);
	};
	const snap = async (page) => snapshot(page, { limit: 150 });
	const short = (u) => {
		try {
			return new URL(u).pathname;
		} catch {
			return u;
		}
	};

	const tools = [
		betaTool({
			name: "sign_in",
			description: "Sign an account in (reusing its saved session when it still works) and open the site as that account. Returns a snapshot of the page it lands on. Call once per account.",
			inputSchema: {
				type: "object",
				properties: {
					account: { type: "string", description: 'Short id for the account, e.g. "admin"' },
					email: { type: "string" },
					password: { type: "string" },
					site_url: { type: "string", description: "The site's address" },
					login_url: { type: "string", description: "Login page, if it is not where the site URL redirects to" },
				},
				required: ["account", "email", "password", "site_url"],
				additionalProperties: false,
			},
			run: async ({ account, email, password, site_url, login_url }) => {
				const id = account.toLowerCase();
				if (pages.has(id)) return `Already signed in as ${id}.\n${await snap(pages.get(id).page)}`;
				const wait = lastLogin + 3000 - Date.now();
				if (wait > 0) await new Promise((r) => setTimeout(r, wait));
				const before = Date.now();
				try {
					const state = await ensureSession(browser, { url: site_url, account: { id, label: id, email, password }, login: login_url ? { url: login_url } : {}, log: system });
					if (Date.now() - before > 4000) lastLogin = Date.now();
					const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, storageState: state });
					const page = await ctx.newPage();
					await page.goto(site_url, { waitUntil: "domcontentloaded", timeout: 60000 });
					await settle(page);
					pages.set(id, { ctx, page });
					action(`Signed in as ${id} (${email})`);
					return `Signed in as ${id}.\n${await snap(page)}`;
				} catch (e) {
					action(`Could not sign in as ${id}: ${e.message}`);
					return `Sign-in failed: ${e.message}`;
				}
			},
		}),
		betaTool({
			name: "open",
			description: 'Open a URL as an account ("guest" = signed out). Returns a snapshot of the page.',
			inputSchema: { type: "object", properties: { account: { type: "string" }, url: { type: "string" } }, required: ["account", "url"], additionalProperties: false },
			run: async ({ account, url }) => {
				const page = await pageOf(account);
				await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
				await settle(page);
				action(`[${account}] Opened ${url}`);
				return snap(page);
			},
		}),
		betaTool({
			name: "look",
			description: "Snapshot of the account's current page: URL, headings, and visible interactive elements with a tested selector each.",
			inputSchema: { type: "object", properties: { account: { type: "string" } }, required: ["account"], additionalProperties: false },
			run: async ({ account }) => {
				const page = await pageOf(account);
				action(`[${account}] Looked at ${short(page.url())}`);
				return snap(page);
			},
		}),
		betaTool({
			name: "click",
			description: "Click a link or a button that only navigates or opens something (a page, a tab, a dialog, a menu), to see what is there. Refuses anything that submits a form or changes data. Returns a snapshot afterwards.",
			inputSchema: { type: "object", properties: { account: { type: "string" }, selector: { type: "string" } }, required: ["account", "selector"], additionalProperties: false },
			run: async ({ account, selector }) => {
				const page = await pageOf(account);
				const matches = page.locator(`${selector} >> visible=true`);
				const n = await matches.count().catch(() => 0);
				if (!n) return `No visible element matches ${selector}.`;
				const el = matches.first();
				const info = await el.evaluate((e) => ({
					tag: e.tagName,
					type: (e.getAttribute("type") || "").toLowerCase(),
					inForm: !!e.closest("form"),
					text: (e.getAttribute("aria-label") || e.innerText || e.value || "").replace(/\s+/g, " ").trim().slice(0, 60),
				}));
				const submits = info.type === "submit" || (info.inForm && info.tag === "BUTTON" && info.type !== "button");
				const risky = SIGN_OUT.test(info.text) || (info.tag !== "A" && (submits || CHANGES_DATA.test(info.text)));
				if (risky) {
					action(`[${account}] Did not click "${info.text}" (it would change data) - noted its selector`);
					return `Not clicked: "${info.text}" looks like it submits or changes data. That's fine - use its selector in the script (add "?" if it can only happen once).`;
				}
				const before = page.url();
				await el.click({ timeout: 10000 });
				await settle(page);
				action(`[${account}] Clicked "${info.text || selector}" to see what it opens`);
				return `${n > 1 ? `Note: ${n} visible elements match; clicked the first.\n` : ""}${page.url() !== before ? `Navigated to ${page.url()}\n` : ""}${await snap(page)}`;
			},
		}),
		betaTool({
			name: "scroll_page",
			description: "Scroll the account's page by y pixels (negative = up) to see what is further down. Returns a snapshot.",
			inputSchema: { type: "object", properties: { account: { type: "string" }, y: { type: "number" } }, required: ["account", "y"], additionalProperties: false },
			run: async ({ account, y }) => {
				const page = await pageOf(account);
				await page.mouse.move(900, 450);
				await page.mouse.wheel(0, y);
				await page.waitForTimeout(600);
				action(`[${account}] Scrolled ${y > 0 ? "down" : "up"} ${Math.abs(y)} px on ${short(page.url())}`);
				return snap(page);
			},
		}),
		betaTool({
			name: "close_dialog",
			description: "Close an open dialog or menu without saving (presses Escape).",
			inputSchema: { type: "object", properties: { account: { type: "string" } }, required: ["account"], additionalProperties: false },
			run: async ({ account }) => {
				const page = await pageOf(account);
				await page.keyboard.press("Escape");
				await page.waitForTimeout(500);
				action(`[${account}] Closed the dialog`);
				return "Closed.";
			},
		}),
		betaTool({
			name: "test_selector",
			description: "Check selectors on the account's current page: how many visible elements each matches, and the first match's label. Pass several at once.",
			inputSchema: {
				type: "object",
				properties: { account: { type: "string" }, selectors: { type: "array", items: { type: "string" }, minItems: 1 } },
				required: ["account", "selectors"],
				additionalProperties: false,
			},
			run: async ({ account, selectors }) => {
				const page = await pageOf(account);
				const out = [];
				for (const s of selectors) {
					try {
						const loc = page.locator(`${s} >> visible=true`);
						const n = await loc.count();
						const label = n ? await loc.first().evaluate((e) => (e.getAttribute("aria-label") || e.innerText || e.getAttribute("placeholder") || e.getAttribute("name") || "").replace(/\s+/g, " ").trim().slice(0, 50)) : "";
						out.push(`${n === 1 ? "OK " : n ? `${n} matches` : "NONE"} · ${s}${label ? ` · "${label}"` : ""}`);
					} catch (e) {
						out.push(`INVALID · ${s} · ${e.message.split("\n")[0]}`);
					}
				}
				action(`[${account}] Tested ${selectors.length} selector(s) on ${short(page.url())}: ${out.filter((l) => l.startsWith("OK")).length} OK`);
				return out.join("\n");
			},
		}),
		betaTool({
			name: "submit_script",
			description: "Submit the finished step script. It is parsed and validated; you get back ACCEPTED or the list of problems to fix.",
			inputSchema: { type: "object", properties: { script: { type: "string" } }, required: ["script"], additionalProperties: false },
			run: async ({ script }) => {
				const { spec, errors } = parseScript(script);
				const problems = [...errors, ...(spec ? validateSpec(structuredClone(spec)) : [])];
				if (problems.length) {
					action(`Script submitted - ${problems.length} problem(s) to fix`);
					return `REJECTED. Fix these and submit again:\n- ${problems.join("\n- ")}`;
				}
				accepted = { script, spec };
				action(`Script submitted - accepted (${spec.steps.length} steps, ${spec.accounts?.length ?? 0} accounts)`);
				return "ACCEPTED.";
			},
		}),
	];

	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
	try {
		system(`Converting with ${CONVERT_MODEL}...`);
		const client = new Anthropic();
		const runner = client.beta.messages.toolRunner(
			{
				model: CONVERT_MODEL,
				max_tokens: 16000,
				betas: ["server-side-fallback-2026-07-01"],
				fallbacks: "default",
				output_config: { effort: "high" },
				cache_control: { type: "ephemeral" },
				system: SYSTEM,
				tools,
				messages: [{ role: "user", content: `Convert this script:\n\n${prose}` }],
				max_iterations: 70,
			},
			{ signal },
		);
		for await (const message of runner) {
			usage.turns++;
			const u = message.usage ?? {};
			usage.input += u.input_tokens ?? 0;
			usage.output += u.output_tokens ?? 0;
			usage.cacheRead += u.cache_read_input_tokens ?? 0;
			usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
			for (const b of message.content) if (b.type === "text" && b.text.trim()) system(`Claude: ${b.text.trim().replace(/\s+/g, " ").slice(0, 400)}`);
			if (message.stop_reason === "refusal") throw new PipelineError("Claude declined to convert this script.");
			if (message.stop_reason === "max_tokens") system("Claude's reply hit the length limit; continuing.");
		}
	} catch (e) {
		const msg =
			e instanceof Anthropic.AuthenticationError ? "The Anthropic API key in .env is wrong or revoked." :
			e instanceof Anthropic.PermissionDeniedError ? "This Anthropic API key isn't allowed to use the model (check the key's workspace and billing)." :
			e instanceof Anthropic.RateLimitError ? "Anthropic rate limit reached - wait a minute and try again." :
			e instanceof Anthropic.APIError ? `Anthropic API error ${e.status ?? ""}: ${e.message}` :
			e.message;
		system(`ERROR: ${msg}`);
		run.finish({ status: "failed", error: msg });
		throw new PipelineError(msg);
	} finally {
		await browser.close().catch(() => {});
	}
	// Opus 5.5 rates: $4/M input, $20/M output, cache writes $5/M, cache reads $0.20/M.
	const cost = (usage.input * 4 + usage.output * 20 + usage.cacheWrite * 5 + usage.cacheRead * 0.2) / 1e6;
	system(`Claude usage: ${usage.turns} turns, ${usage.input + usage.cacheRead + usage.cacheWrite} input tokens (${usage.cacheRead} from cache), ${usage.output} output tokens - about $${cost.toFixed(2)}.`);
	if (!accepted) {
		const msg = "Claude finished without a valid script. Try again, or write the steps by hand.";
		system(`ERROR: ${msg}`);
		run.finish({ status: "failed", error: msg });
		throw new PipelineError(msg);
	}
	run.describe({ slug: `convert-${slugify(accepted.spec.title ?? "script")}`, title: `Convert: ${accepted.spec.title}` });
	run.finish({ status: "success", extra: { steps: accepted.spec.steps.length, costUsd: Number(cost.toFixed(3)) } });
	return { script: accepted.script, spec: accepted.spec, usage, costUsd: cost };
}
