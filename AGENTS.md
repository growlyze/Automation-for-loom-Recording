# Growlyze Automatic Video Recorder

Turns a script (step format or plain English) into a narrated demo video: Playwright drives
Chrome, OpenScreen records, ElevenLabs narrates. Windows only. Web app: `npm run ui` →
http://localhost:4400.

- **Setting up this project, or "install / run this"**: follow [SETUP.md](SETUP.md) phase by
  phase, including its rules (ask before installing software, never print or commit secrets,
  verify each phase).
- **Pushing to GitHub**: follow "Pushing changes to GitHub" in [SETUP.md](SETUP.md) (secret
  scan first; `.env`, `.cache/`, `output/`, `logs/`, `shares.json`, `videos/*.json` and
  `videos/*.txt` stay private).
- **How things work**: [README.md](README.md) and
  [docs/flowchart/system-flowchart.png](docs/flowchart/system-flowchart.png).

Code map: `src/make.mjs` (pipeline), `src/ui-server.mjs` (web app), `src/browser.mjs`
(recording browser), `src/input.mjs` (script format), `src/logins.mjs` (saved logins),
`src/ai-convert.mjs` (Convert with AI), `ui/index.html` (interface), `chrome-extension/`.
