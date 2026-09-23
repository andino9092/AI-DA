# AI-DA

**AI Desktop Assistant**: a voice-first, privacy-first assistant that lives in the Windows system tray. It can open apps, click through UI, control volume and more, and it keeps sensitive information on your PC.

> v2 is a ground-up rewrite. See [PLAN.md](PLAN.md) for the architecture, features and roadmap.
> **Current phase: 0 (Foundation)**: tray app, settings window and encrypted API key storage.

## Development

Requires **Node 22.12+** (pinned in `.node-version`; [fnm](https://github.com/Schniz/fnm) picks it up automatically).

```bash
npm install
npm run dev
```

AI-DA starts in the tray. On first run the settings window opens. After that, click the tray icon or use its menu to open it. Windows 11 hides new tray icons under the `^` overflow arrow; drag the icon onto the taskbar to keep it visible.

| Script          | What it does                                         |
| --------------- | ---------------------------------------------------- |
| `npm run dev`   | Run with hot reload                                  |
| `npm run check` | Typecheck, lint, format check and tests (same as CI) |
| `npm test`      | Unit tests (Vitest)                                  |
| `npm run build` | Production build into `out/`                         |
| `npm run dist`  | Build the Windows installer into `release/`          |
| `npm run icons` | Regenerate tray and app icons                        |

## Layout

```
src/main/        Electron main process: tray, windows, IPC, settings store, secret vault
src/preload/     The typed `window.aida` bridge (context-isolated, sandboxed)
src/renderer/    React UI (settings window)
src/shared/      Types and contracts shared by all processes
resources/       Tray and app icons
tests/           Vitest unit tests
```

## Security model (so far)

- Renderers are sandboxed and context-isolated, with no Node access. They can only call the typed `window.aida` API, every IPC call is validated with zod, and calls from untrusted senders are rejected.
- API keys are encrypted with Windows DPAPI (`safeStorage`). Plaintext never touches disk and is never sent to a renderer; the UI only sees the last four characters.
- External links open only for an allow-list of HTTPS hosts.
- Launch at login is only registered by the installed app, never by dev builds.
