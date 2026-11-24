# Setup: Growlyze Automatic Video Recorder

This file is written for an **AI coding agent** (Claude Code, OpenCode or similar) to set up
the recorder on a Windows PC from start to finish, and later to push changes to GitHub. A
person can follow it by hand too.

**What you'll have at the end:** the web app at **http://localhost:4400**, locked with a
password, able to record a demo video end to end.

---

## Rules for the agent (read first)

1. **Ask before installing software** (winget, Microsoft Store, global npm). Show the exact
   command and wait for a yes. `npm install` inside this folder doesn't need asking.
2. **Never print, log or commit secrets**: the ElevenLabs key, the Anthropic key, the UI
   password, saved logins. They live only in `.env` and `.cache/`, both git-ignored. When you
   need a value, ask the person to paste it into `.env` themselves, or write it there
   without echoing it.
3. **Check each phase** with its "Verify" command before moving on. If one fails, fix it, or
   stop and explain in plain words.
4. **Windows only.** OpenScreen recording here uses Windows Graphics Capture. Use PowerShell
   or Git Bash commands as written.
5. **VS Code terminals set `ELECTRON_RUN_AS_NODE=1`.** The app removes it itself, but if you
   run `openscreen.exe` by hand, first run `Remove-Item Env:ELECTRON_RUN_AS_NODE` (PowerShell).
6. At the end, give the person a short report: what was installed, what works, what still
   needs them (keys, the Chrome extension).

---

## Phase 1: Check what's already installed

Run each and note what's missing:

```powershell
node --version            # need v18 or newer (v20+ recommended)
git --version
ffmpeg -version           # first line is enough
Test-Path "$env:LOCALAPPDATA\Microsoft\WindowsApps\openscreen.exe"   # True = OpenScreen installed
Test-Path "C:\Program Files\Google\Chrome\Application\chrome.exe"    # Chrome (or Edge) needed
gh --version              # optional: only for GitHub tasks
```

## Phase 2: Install what's missing (ask first)

| Missing | Command |
|---|---|
| Node.js | `winget install OpenJS.NodeJS.LTS` |
| Git | `winget install Git.Git` |
| ffmpeg | `winget install Gyan.FFmpeg` |
| OpenScreen (2.1.0+) | `winget install --source msstore OpenScreen` |
| Google Chrome | `winget install Google.Chrome` |
| GitHub CLI (optional) | `winget install GitHub.cli` |
| cloudflared (optional, for share links) | `winget install Cloudflare.cloudflared` |

Add `--accept-package-agreements --accept-source-agreements` so winget doesn't stop to ask.
**After installing, open a new terminal**, so the updated PATH is picked up, then re-run
Phase 1.

**Verify:** every Phase 1 command succeeds, and `openscreen.exe` exists.

## Phase 3: Get the code

If the code isn't on this PC yet (the repository is private, so the person must have
access):

```powershell
gh auth status            # if not signed in: gh auth login  (the person does this step)
gh repo clone growlyze/Automation-for-loom-Recording
cd Automation-for-loom-Recording
```

Without `gh`: `git clone https://github.com/growlyze/Automation-for-loom-Recording.git`.

If the code is already here, just `cd` into the folder that has `package.json` and `SETUP.md`.

## Phase 4: Install the project's packages

```powershell
npm install
```

This installs Playwright (browser control), the MCP SDK (to talk to OpenScreen) and the
Anthropic SDK. Playwright drives the **installed Chrome or Edge**, so no extra browser
download is needed. Only if neither Chrome nor Edge exists, ask, then run
`npx playwright install chromium`.

**Verify:**
```powershell
node -e "require('playwright'); console.log('ok')"
```

## Phase 5: Create `.env` (settings and keys)

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Then fill in `.env`. **Ask the person** for each value, and don't echo them back:

| Setting | Needed? | Where it comes from |
|---|---|---|
| `UI_PASSWORD` | **Yes** | Any password the team chooses. It locks the web app. |
| `ELEVENLABS_API_KEY` | For the AI voice | elevenlabs.io → profile → **API Keys**. Without it, the free Windows voice is used. |
| `ELEVENLABS_VOICE_ID` | With the key | The default narrator. `npm run voices` lists the voices on the account. Cloned voices need a paid ElevenLabs plan (Starter or higher). |
| `ANTHROPIC_API_KEY` | Optional | console.anthropic.com → **API Keys**. Only for **Convert with AI** (plain-English scripts → steps). |
| `SHARE_TUNNEL_TOKEN`, `SHARE_BASE_URL` | Optional | A permanent share-link address via Cloudflare. See README → Share links. |

**Verify** (prints only which settings are set, never their values):
```powershell
node -e "require('fs').readFileSync('.env','utf8').split(/\r?\n/).forEach(l=>{const m=/^([A-Z_]+)=(.*)$/.exec(l); if(m) console.log(m[1].padEnd(24), m[2].trim()?'set':'-')})"
```
If ElevenLabs is set, also run `npm run voices`. It must list voices, not show an error.

## Phase 6: Check that OpenScreen works

```powershell
npm run mcp-tools
```
**Verify:** a list of OpenScreen tools appears (`startRecording`, `exportVideo`, …). If it
says OpenScreen is not installed, go back to Phase 2. If it starts plain Node instead, see
rule 5.

Optional 10-second recording test (it takes over the screen for about 15 seconds; tell the
person first):
```powershell
npm run smoke
```
It should end with `exportVideo … "format":"mp4"`.

## Phase 7: Start the web app

```powershell
npm run ui
```
Keep it running, in a background terminal if you're an agent. It prints
`Growlyze Automatic Video Recorder: http://localhost:4400`.

**Verify** (in another terminal):
```powershell
(Invoke-WebRequest http://localhost:4400/login -UseBasicParsing).StatusCode    # 200
```
Then tell the person: open **http://localhost:4400** and sign in with `UI_PASSWORD`.

## Phase 8: First real video (end-to-end test)

Tell the person the screen will be taken over for about a minute, then:
```powershell
npm run make -- videos/example.json
```
**Verify:** it ends with `Done: …\output\add-and-complete-a-todo\add-and-complete-a-todo.mp4`,
and the video appears on the **Videos** page. Every run is also on the **Logs** page.

## Phase 9 (optional): Chrome extension for logins

This lets videos use sites the person is already signed into in Chrome (e.g. Zapier, Box)
without passwords in scripts. **The person must do this themselves**, because Chrome doesn't
let software install it:

1. In the Chrome profile they use for work, open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this repository's `chrome-extension` folder.

Then, in the web app: **Logins → Use a login from your Chrome** → pick the Google account →
site address → **Open in my Chrome**.

## Phase 10: Report back

Tell the person, in a few lines: what was installed, the app address
(http://localhost:4400), which keys are set or missing, whether the test video worked, and
the optional steps left (Anthropic key, Chrome extension, permanent share links).

---

## Pushing changes to GitHub

When the person asks to push their changes:

1. **See what changed:** `git status` and `git diff --stat`.
2. **Never commit private files.** These must stay ignored; check with
   `git check-ignore .env .cache output logs shares.json`, which should print every one of
   them:
   `.env`, `.cache/` (saved logins, sessions, voice cache), `output/` (videos), `logs/`,
   `shares.json`, `edit-requests/`, `videos/*.json` and `videos/*.txt` (scripts can hold
   passwords; only `videos/example.json` and `videos/tests/` are shared).
3. **Scan the staged changes for secrets** before committing:
   ```powershell
   git add -A
   git grep --cached -n -I -E "sk_[a-f0-9]{20,}|sk-ant-|gho_[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|xi-api-key\"?: *\"[a-z0-9]{20}" -- . ":!SETUP.md"
   ```
   It must print nothing. If it finds something, unstage that file (`git restore --staged <file>`)
   and tell the person. Also look for client names or real customer data in new files.
4. **Commit** with a clear message saying what changed and why:
   ```powershell
   git commit -m "Short summary of the change" -m "Details: what and why"
   ```
   If git asks who you are, set it **for this repository only** with the person's GitHub
   name and their no-reply email (`<id>+<login>@users.noreply.github.com`). Get both with
   `gh api user --jq "[.id,.login]"`.
5. **Push:** confirm with the person, then:
   ```powershell
   git push origin main
   ```
   If they prefer a pull request: `git switch -c <branch>`, `git push -u origin <branch>`, then
   `gh pr create --fill`.
6. **Verify:** `git status -sb` shows the branch is not ahead of `origin`.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `OpenScreen is not installed` | `winget install --source msstore OpenScreen`, or set `OPENSCREEN_EXE` in `.env` to the full path of `Openscreen.exe`. |
| `openscreen.exe` prints Node's help | VS Code set `ELECTRON_RUN_AS_NODE=1`. Run `Remove-Item Env:ELECTRON_RUN_AS_NODE` first. |
| `ffmpeg was not found` | `winget install Gyan.FFmpeg`, then open a new terminal. |
| `ElevenLabs returned 401` | Wrong or revoked key, or a **cloned voice** on a free plan: pick a standard voice or upgrade. |
| `Port 4400 is already in use` | The app is already running. Use it, or set `UI_PORT` in `.env`. |
| `Recording did not start … No window title contains` | Don't minimise or cover the full-screen browser during a recording. |
| A saved login "expired" | **Logins** page → **Sign in again**. |
| Share links don't open from outside | The free Cloudflare tunnel is slow on some networks; see README → Share links for a permanent tunnel. |

More detail on every feature: [README.md](README.md). How the system works:
[docs/flowchart/system-flowchart.png](docs/flowchart/system-flowchart.png).
