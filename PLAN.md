# AI-DA v2 — Reinvention Plan

**AI-DA (AI Desktop Assistant)** is a voice-first assistant for Windows that runs from the system tray. It hears you, understands what you mean and acts on your PC: it opens apps, clicks through UI, changes volume and more. It can also be controlled from your phone through Tailscale when you're away from your desk.

Status: **v2.0 feature-complete: Phases 0–3 plus the remaining MVP items (timers, files and folders, Steam games, offline indicator, first-run setup). Phase 4 (Tailscale remote) skipped for now (decided 2026-09-23)** (last updated 2026-09-24).

## Decisions made

| Topic | Decision |
|---|---|
| Platform | **Windows only** for v2. Platform-specific code stays behind interfaces so macOS can be added later. |
| Brain | **Cloud LLM on a free tier** (Gemini Flash-Lite, with Groq as backup). This is the only part of the default setup that uses the internet. |
| Ears and voice | **Local.** The wake word, VAD, speech-to-text (Whisper on your RTX 3070 Ti) and text-to-speech (Kokoro) all run on your PC. They're faster, private and have no quota. |
| Cost target | **$0/month** for normal personal use, with no required paid API keys. |
| Privacy | **Sensitive information never leaves the PC**: card, bank and Social Security numbers, logins, passwords, keys and screen images. One code path, the **Privacy Guard**, enforces it for everything that goes out. |
| Remote access | **Tailscale**, as an on/off option in Settings (release 2.1, right after the MVP). |
| Scope | **Smaller MVP.** Everything that doesn't serve the core loop moves to the "Later" list. |
| Picovoice | **Dropped completely.** |
| Old code | It stays on the `main` and `basic_functions` branches. v2 is built on the `v2` branch. |

---

## How a request flows (default setup)

```
 mic ─► wake word / hotkey ─► VAD ─► Whisper STT ─► Privacy Guard ─► Instant parser ──hit──► tool ─► Kokoro speaks
        (local)                (local)  (local GPU)   (local)            (local)       │
                                                                                      miss
                                                                                       ▼
                                                                      Gemini Flash-Lite (cloud)
                                                                      receives ONLY scrubbed text
                                                                                       │
                                                                                 tool calls ─► local execution
```

Fallbacks are **not steps in the chain**. They're only tried when the primary fails (a 429, a timeout or no internet), so they add no time to normal requests.

| Stage | Primary | Only if that fails |
|---|---|---|
| Speech-to-text | whisper.cpp `large-v3-turbo` q5 on GPU (local, CUDA 12.4 build, ~150 ms per utterance) | Local Whisper on CPU. Groq Whisper is opt-in and sends raw audio off the PC. |
| Brain | Gemini `gemini-3.5-flash-lite` (~500 free req/day) | Groq `qwen/qwen3.8-27b` (~1,000 free req/day; supports parallel tool calls) |
| Text-to-speech | Kokoro 82M fp32 on CPU (local, ~0.4× real time) | Reply shown in the status pill |

---

## Privacy Guard

**Goal:** nothing sensitive reaches any third party: no AI provider, no telemetry, no logs that sync anywhere.

### One way out
- Every AI provider request goes through a single `egress` module.
- Providers accept only a `ScrubbedPayload`, a branded TypeScript type that **only the Privacy Guard can create**. Code that tries to send a raw string to a provider **won't compile**.
- The router also refuses any cloud payload that contains an image, and there's no setting to override that.

### What gets scrubbed (all local and deterministic, under 5 ms)

| Category | How it's detected |
|---|---|
| **Payment cards** | 13–19 digit runs (spaces and dashes allowed) that pass the **Luhn checksum**, plus CVV and expiry values near card keywords |
| **SSN / ITIN** | `###-##-####` and 9-digit runs, with invalid ranges (000, 666, 9xx) excluded, plus words like "social" nearby |
| **Bank details** | US routing numbers (**ABA checksum**), **IBAN** (mod-97 check), SWIFT/BIC, and account numbers next to words like "account", "acct", "checking" |
| **Logins and secrets** | Text after "password / PIN / passcode / login / username is…", one-time codes near "code", API keys (known prefixes like `sk-`, `ghp_`, `AKIA`), JWTs, private-key blocks, and long high-entropy strings |
| **Government IDs** | Passport and driver's-license formats near their keywords |
| **Your own values** | A local "**Sensitive values**" list in Settings (your account numbers, address, etc.), encrypted with `safeStorage` and matched exactly, even when you say them without context |
| **Contact info** (optional, off by default) | Emails and phone numbers. They're left unmasked by default because commands like "email John" need them. |

### Where it's applied
It applies to **everything** that could leave the PC: your spoken commands, clipboard text, screen text from the UI tree or OCR, file contents a tool reads, MCP tool results and conversation history. It also applies to local logs, so the action log stores only scrubbed text.

### What the cloud sees instead
Each sensitive value is swapped for a typed placeholder. For example:
> "Fill in card `[CARD_1]` expiring `[EXPIRY_1]` on this page"

- The real value lives **only in memory**, for the length of that one request.
- The cloud model can still plan ("type `[CARD_1]` into textbox#4").
- The **local** tool executor swaps the real value back in when typing. Typing a sensitive value is always a `confirm`-level action, so Aida asks you first.

### Collected-never rules (stronger than scrubbing)
- **Password fields** (UI Automation `IsPassword`) are never read.
- While a **sensitive app** is in focus (password managers, banking sites, anything on your list), Aida reads nothing from the screen at all.
- **Raw audio** never leaves the PC by default, because speech-to-text runs locally. That matters because audio can't be scrubbed.
- **Screen images** never leave the PC.

### Honest limits
Pattern matching can't catch everything. For example, a random-looking account number said without any context won't be recognized. That's why there are several layers: local speech-to-text, keyword context, your sensitive-values list, and never-collect rules for sensitive apps and fields. A test suite of fake sensitive data runs on every build, and the build fails if any of it reaches an outbound payload.

---

## Speed: what actually adds latency

More features do **not** make each request slower. A request only runs the modules it needs, and fallbacks only run on failure. What does add time:
1. **Network round trips to the LLM**, about 0.5–1.2 s each. This is the biggest cost.
2. **How many round trips** a request needs (plan → act → reply).
3. **The size of the prompt** (how many tools are described).
4. **Cold starts** (loading models).

### Latency budget (from the end of speech to the first audio)

| Path | Steps | Target |
|---|---|---|
| **Instant command** ("volume 30", "pause", "open Spotify") | VAD end (~400 ms) + Whisper GPU (~200–400 ms) + parser + action + Kokoro first audio (~150 ms) | **under 1 s** |
| **Simple LLM command** ("open whatever I used for music yesterday") | + 1 Flash-Lite round trip | **~1.5–2 s** |
| **Multi-step task** ("open Discord and message #general that I'm running late") | + 2–3 round trips, with a spoken "on it" right away | first audio **under 1.5 s**, done in ~3–5 s |

### How it stays fast
- **Instant tier:** about half of commands never reach an LLM.
- **Local speech in and out:** no audio upload or download, and it isn't affected by network slowness.
- **Tools report their own result:** a tool returns a sentence Aida can say ("Volume set to 30"), so there's **no second LLM round trip** just to phrase the reply.
- **Small prompts:** only the 5–10 tools relevant to a request are sent, picked by a local keyword pre-filter.
- **Streaming:** Kokoro starts speaking the first sentence while the rest is still being generated.
- **Warm start:** Whisper and Kokoro load when AI-DA starts and stay in memory. They're unloaded when a full-screen game needs the GPU, and reloaded when you're back.
- **Early "on it":** multi-step tasks give immediate audio feedback, so they feel responsive even while they're still running.

---

## Architecture

```
┌──────────────────────────── Electron (tray app) ─────────────────────────┐
│  Tray icon · menu · global hotkeys · panic key                           │
│                                                                           │
│  ┌─ Audio window (hidden) ──────────┐      ┌─ Overlay window ─────────┐  │
│  │ mic → AudioWorklet 16 kHz        │      │ pill: state, transcript, │  │
│  │ openWakeWord "Hey Aida" (ONNX)   │      │ confirm cards            │  │
│  │ Silero VAD (ONNX)                │      └───────────▲──────────────┘  │
│  └──────────────┬───────────────────┘                  │                 │
│                 │ utterance PCM                         │ state           │
│  ┌──────────────▼──────────── Main process ────────────┴──────────────┐  │
│  │ STT (whisper.cpp) → Privacy Guard → Instant parser ─hit─┐          │  │
│  │                                        │ miss            ▼          │  │
│  │                                   Agent loop ──► Tool registry      │  │
│  │                                        │         permission gate    │  │
│  │                           egress (ScrubbedPayload only)  action log │  │
│  │                                        │                            │  │
│  │                              Gemini / Groq (cloud)                   │  │
│  │ TTS (Kokoro) ◄── tool result / reply                                │  │
│  └──────────────┬─────────────────────────────────┬────────────────────┘  │
│                 │ JSON-RPC over stdio              │ (2.1)                 │
│  ┌──────────────▼──────────────┐     ┌─────────────▼──────────────────┐   │
│  │ aida-win.exe (C# sidecar)   │     │ Remote gateway, tailnet only   │   │
│  │ Core Audio · UI Automation  │     │ phone PWA                      │   │
│  │ Windows OCR · Win32 windows │     └────────────────────────────────┘   │
│  └─────────────────────────────┘                                          │
└───────────────────────────────────────────────────────────────────────────┘
```

### Design rules
1. **Every capability is a tool.** A tool has a `name`, a zod `schema`, a `risk` level (`safe | confirm | blocked`), a `handler`, optional `instantPatterns` and a `speak()` result.
2. **Providers sit behind interfaces** (`SttProvider`, `LlmProvider`, `TtsProvider`), so adding Claude, Gemini Live or Ollama later doesn't touch the core.
3. **A native .NET sidecar** handles Windows APIs: exact volume, per-app volume, UI Automation, OCR, windows across monitors and DPI scaling.
4. **Privacy Guard is the only way out** (see above).

---

## MVP (v2.0): core features

Kept deliberately small: *hear → understand → act → answer*, done fast and privately.

1. **Tray app and settings.** Tray icon with a state indicator (idle, listening, thinking, speaking, muted, offline), a menu, launch at login, a single instance, and a first-run wizard (API key, mic test, model download). Settings covers keys, audio devices, hotkeys, voice, wake word sensitivity, sensitive apps and sensitive values.
2. **Voice in.** The "Hey Aida" wake word, a push-to-talk hotkey (`Ctrl+Alt+Space`), VAD, and local Whisper on the GPU.
3. **Voice out.** Local Kokoro with streaming and barge-in (talking over Aida stops her).
4. **Privacy Guard.** Scrubbing, placeholders, never-collect rules and the build-time leak test.
5. **Instant command parser.** Handles volume, media, open/close app, window snapping and time/timers without an LLM.
6. **Agent loop.** Gemini Flash-Lite with a Groq fallback, tool calling, short multi-step chains and a follow-up question when a request is unclear. A command palette (`Ctrl+Alt+A`) lets you type instead of talk.
7. **System and media control.** Exact volume, mute, per-app volume, output device, and media play/pause/next/prev with the name of what's playing.
8. **Apps and windows.** A fuzzy app index (Start menu, Store apps, Steam); open, close, focus, minimize, maximize, snap and move between monitors; open files, folders and URLs.
9. **UI interaction.** Click, type and scroll by element name through UI Automation, with **Windows OCR** as a fallback. Both are local, and the cloud only sees a scrubbed text summary.
10. **Safety.** Risk levels, confirmation by voice or overlay, a **panic hotkey** and a scrubbed action log.
11. **Overlay.** A minimal always-on-top pill: state, transcript and confirmation cards.

## Release 2.1: away from the desk
12. **Tailscale remote (on/off in Settings)**
    - AI-DA detects Tailscale and shows setup steps if it's missing.
    - When on, the gateway listens **only on the tailnet interface** (optional `tailscale serve` HTTPS).
    - Pairing uses a QR code and a one-time token, and each device can be revoked.
    - Phone PWA: push-to-talk or text commands, a volume slider, play/pause, lock and sleep, "what's on my screen?" (the image goes only to your phone) and the action log.
    - Remote commands go through the same permission gate and Privacy Guard.

## Later (in rough priority order; each one is a separate module)
1. Weather and info skills (Open-Meteo: free, no key; location is a city you set, never IP lookup. Reminders, alarms, unit conversion). Small enough to pull into Phase 3 if wanted.
   - Spotify search-and-play ("play my liked songs", "play Daft Punk"): Spotify Web API with your own free developer app. Playback control needs Spotify Premium. Plain play/pause/next and "what's playing" don't need it: they come from Windows media sessions in Phase 3.
2. Memory: preferences and app nicknames (local SQLite, never stores sensitive values)
3. Routines ("Gaming mode", "Good morning")
4. Local vision model (Ollama on your 3070 Ti) for "what's on my screen?" and hard-to-find UI
5. Claude power mode (Agent SDK on your Pro plan, opt-in, counts toward your Pro limits)
6. Conversation mode (Gemini Live, audio only)
7. Fully offline brain (Ollama LLM)
8. Clipboard and selection tools, notification digest, proactive alerts
9. MCP servers in Settings
10. Speaker verification, multi-language support, macOS port

---

## Disk and memory footprint

Target machine: RTX 3070 Ti (8 GB), 32 GB RAM, 100 GB free on C:, and more on D: and Z:.

| Component | Disk | While running |
|---|---|---|
| openWakeWord ("Hey Aida") + Silero VAD | ~5 MB | ~50 MB RAM |
| Whisper `large-v3-turbo` q5 | 574 MB | ~1 GB VRAM (measured) |
| whisper.cpp CUDA 12.4 runtime (incl. cuBLAS; zip deleted after unpacking) | ~1.2 GB | — |
| Kokoro-82M fp32 (voices ship inside the app, 28 MB) | 326 MB | ~500 MB RAM (CPU) |
| .NET sidecar | ~30–70 MB | ~50 MB RAM |
| Electron app | ~300 MB | ~200–300 MB RAM |
| **MVP total** | **~2.0 GB measured** (models folder) | **~1 GB VRAM, ~1 GB RAM** |
| *Later:* local vision model (Ollama) | +4–8 GB | 4–6 GB VRAM, loaded only when needed |
| *Later:* offline LLM | +5–9 GB | shares VRAM with the vision model |

- Models are **downloaded by the first-run wizard, not bundled**, so the installer stays around 150 MB. The wizard also lets you choose Whisper quality: q5 (the default) or f16.
- The **models folder can be moved** (default `%LOCALAPPDATA%\AI-DA\models`) so it can live on D: or Z:.
- Models unload from VRAM when a full-screen app needs the GPU.

---

## Tech stack

| Concern | Choice |
|---|---|
| Shell | Electron (latest), electron-vite, TypeScript (strict), React 19 |
| UI | Tailwind CSS + shadcn/ui |
| Wake word and VAD | `onnxruntime-web`: openWakeWord ("Hey Aida", custom-trained) and Silero VAD |
| STT | whisper.cpp (CUDA build), `large-v3-turbo`, run as a warm local process |
| TTS | Kokoro (ONNX, local) |
| LLM | `@google/genai` (Gemini Flash-Lite), `groq-sdk` (fallback) |
| Privacy | In-house `privacy-guard` package (detectors, validators, placeholder vault) |
| Tools | zod schemas |
| Native | `aida-win.exe`: C# compiled at build time by the .NET Framework 4.8 compiler that ships with Windows (no SDK). Core Audio, System.Windows.Automation, Windows.Media.Ocr and media sessions (WinRT), Win32, low-level keyboard hook |
| Storage | Validated JSON files (settings, quota counters), daily JSON Lines logs (actions, outbound requests; 30-day retention), `safeStorage` (keys and sensitive values). SQLite arrives with Memory. |
| Remote (2.1) | Fastify + WebSocket, Tailscale CLI/LocalAPI, PWA |
| Quality | Vitest, Playwright for Electron, ESLint + Prettier, GitHub Actions (Windows runner) |
| Packaging | electron-builder (NSIS), auto-update through GitHub Releases |

## Repo layout

```
AI-DA/
├─ src/
│  ├─ main/
│  │  ├─ app/            # tray, windows, hotkeys, lifecycle
│  │  ├─ agent/          # agent loop, instant parser, tool pre-filter
│  │  ├─ privacy/        # Privacy Guard: detectors, validators, placeholder vault, egress
│  │  ├─ providers/      # stt/ llm/ tts/
│  │  ├─ tools/          # system/ media/ apps/ windows/ ui/
│  │  ├─ safety/         # permission gate, action log, sensitive-app list
│  │  ├─ remote/         # (2.1) gateway, tailscale, pairing
│  │  └─ native/         # sidecar process + JSON-RPC client
│  ├─ preload/
│  ├─ renderer/          # audio/ overlay/ settings/
│  └─ shared/            # types, IPC contracts
├─ native/aida-win/      # C# sidecar sources (scripts/build-native.mjs)
├─ mobile/               # (2.1) phone PWA
├─ models/               # wake word, VAD, (downloaded) whisper + kokoro
└─ resources/
```

---

## Roadmap

Each phase ends with something you can run and use.

**Phase 0: Foundation**
- Scaffold electron-vite, React and TypeScript, then set up the tray, a single instance, launch at login, settings with the `safeStorage` key vault, lint, tests and CI.
- ✅ *Done when:* the tray icon appears, the settings window opens and keys save. *(done 2026-09-23)*

**Phase 1: Brain, text only, private from day one** ✅ *(done 2026-09-23)*
- Build the Privacy Guard and egress, including the leak-test corpus.
- Build the tool registry, permission gate, action log and instant parser.
- Add the Gemini and Groq providers and the command palette.
- Add first tools: volume and media (temporary PowerShell version), open app, window control.
- ✅ *Done when:* typing "open spotify and set volume to 30" works, and typing a fake card number shows `[CARD_1]` in the outbound log.
- *Built:* Windows control runs through a long-lived Windows PowerShell process that compiles `resources/native/AidaWin.cs` once (Core Audio volume, media keys, window management, Start-menu app list). Phase 3's .NET sidecar replaces it behind the same `WindowsBridge` interface.

**Phase 2: Voice** ✅ *(done 2026-09-23)*
- Build the audio window, then add VAD, push-to-talk, whisper.cpp, Kokoro with streaming and barge-in.
- Train and integrate the "Hey Aida" wake word.
- Build the overlay.
- Measure the latency budget and add it to CI as a benchmark.
- ✅ *Done when:* "Hey Aida, pause the music" works hands-free in under 1 s.
- *Built:* **Wake word = Whisper phrase check** (decided 2026-09-23): Silero VAD cuts speech into utterances, local Whisper transcribes them, and only text starting with "Hey Aida"/"Aida," is acted on; everything else is dropped unlogged. No training needed; a trained openWakeWord model can be added later to save GPU. Push-to-talk is **Ctrl+Alt+V** (Ctrl+Alt+Space was taken on this PC); both shortcuts are rebindable in Settings. Barge-in: push-to-talk or "Hey Aida, stop". A question from Aida opens the mic for the answer. Models download in Settings → Voice with pinned SHA-256s.
- *Wake-word tuning (2026-09-23):* Settings → Voice → **Mic check** shows the live mic level and what Whisper heard (✓/✗ and peak dB), in memory only, never logged. **Sensitivity** (low/normal/high) sets the speech-detector threshold and whether close misspellings count ("Hey Aita", "Hey Aiden", "Hayda"). Quiet recordings are raised toward full scale (up to 10×) before transcription.
- *Measured (injected clip, not a live mic):* end of speech → reply text 0.4–0.7 s, → first audio 1.1–1.5 s. Misses the 1 s target because Kokoro runs on the CPU (see backlog). Latency isn't in CI: CI runners have no GPU.

**Phase 3: Real computer control → v2.0 release**
- Build the .NET sidecar (Core Audio, UI Automation, OCR, windows) and replace the temporary PowerShell tools.
- Add UI tree summarization and redaction, confirmation flows, the panic hotkey and the sensitive-app list.
- Add the installer and auto-update.
- ✅ *Done when:* "click the Send button in Discord" works, and nothing is read while your password manager is in focus.
- *Built (2026-09-23):*
  - **Sidecar:** `aida-win.exe`, compiled from `native/aida-win/*.cs` by `csc.exe` from .NET Framework 4.8 (in every Windows 10/11), so building needs no .NET SDK and the exe is 40 KB. Starts in ~0.1 s (the PowerShell helper took 2–3 s). WinRT (media sessions, OCR) is reached through the `.winmd` files in `System32\WinMetadata` with a hand-written await helper, because the usual `AsTask` helpers need the Windows SDK.
  - **Media:** Windows media sessions give explicit play/pause per app ("pause Spotify"), "what's playing?", and track names in replies ("Next up: …"). Media keys remain the fallback when no app reports a session.
  - **Screen tools:** `read_screen` (UI Automation list of controls with #ids, OCR fallback for apps without controls), `click` (by name, #id, or OCR text), `type_text` (optionally into a named field), `press_keys`, `scroll`. Local parsing for "click the send button in discord", "press ctrl shift t", "scroll down".
  - **Safety:** the sensitive-apps list (Settings → Privacy; defaults cover password managers and "bank"/"checkout"/"password" title words) blocks UI Automation, OCR and window titles for matching windows. Clicks on controls named like Send/Delete/Buy/Sign out, Enter-to-send and closing shortcuts ask first. Tools can ask mid-run once they know what they found. Voice commands are confirmed by voice ("…? Say yes or no"); anything but a clear yes is a no. **Panic key** (Ctrl+Alt+Backspace) stops the running command, queued commands, speech and pending questions.
  - **Audio:** per-app volume and mute through Windows audio sessions, and switching the default output device (the same call the Sound settings page makes).
  - **Hold-to-talk:** push-to-talk goes through the sidecar's keyboard hook (the key is swallowed so apps don't see it); hold to talk through pauses, or tap then speak as before.
  - **Replies:** short replies are cached as audio after the first time, and common ones ("Okay.", "Paused.") are prepared at startup.
  - **Installer:** `npm run dist` → `AI-DA Setup <version>.exe` (149 MB; 500 MB installed, mostly Electron). Native modules are unpacked from asar; unused onnxruntime-web and non-x64 binaries are left out. Auto-update checks GitHub Releases every 6 hours (installed builds, can be turned off) and installs on quit or from the tray.
  - *Live test by Andy (2026-09-23):* panic key ✅, Bitwarden refused ✅, media play/pause/skip/"what's playing" ✅, output switching ✅. Problems found and fixed the same day:
    - **Clicks missed buttons:** Chromium/Electron apps (Claude, Discord) build their accessibility tree only when asked, so the first look saw just the title bar; Firefox-based Zen marks every control "offscreen" when its window isn't in front, so it showed nothing. The helper now wakes the tree (`AccessibleObjectFromWindow` on the page window), waits up to 2.5 s for it to fill, judges visibility by position, filters by control type inside the search (YouTube page: 4.7 s → 2.9 s), and click/type search all controls instead of the first 250.
    - **"Play the video on Zen" failed:** Zen's media session reports only an id (`F0DC299D809B9700`); sessions are now named through the Start-menu list, "browser"/"YouTube"/"Zen browser" resolve to it, and a video that was never started is played by focusing the page (F6 out of the address bar) and pressing YouTube's `k`. YouTube hides its player buttons from accessibility tools, so clicking isn't possible there.
    - **Hold-to-talk sometimes stayed on "Listening…":** holding now records everything until release (the speech detector only trims silence), releasing Ctrl or Alt also ends the hold, a 25 s cap stops a stuck hold, and silence gives "I didn't hear anything." instead of waiting 7 s.
    - **Videos and music were heard as commands** (follow-up listening picked up YouTube speech): other apps are now turned down while Aida listens or talks (Settings → Voice, on by default), restored afterwards, and restored on the next start if AI-DA quit mid-way.
    - **"Start the video" opened Movie Maker; "open and…" opened Fax and Scan:** media words and filler words are no longer app names.
    - **Tab titles sent your email address to Gemini:** text read off the screen now always has emails and phone numbers masked.
    - **The action log stopped being written** while another program held the file open; it now falls back to a second file instead of dropping lines.
  - *Second live test (2026-09-24):* ducking ✅, hold-to-talk ✅, Claude "type and send" ✅, "close Spotify" confirmation ✅. Fixed:
    - **Skipping named the old song:** Spotify updates its track info a second or two after a skip. The helper now waits (up to 3 s) until the title changes, and says just "Skipped." if it never does.
    - **"Play the YouTube video" resumed a different video:** a browser has one media session, and Zen's belonged to another video (a feed preview or another tab). If the session's title isn't the page's, Aida now presses play on the page itself and doesn't announce the other title.
  - *Still to verify live:* Discord Send, hold-to-talk after the fix, spoken confirmations, the installed build.

**Finishing v2.0: remaining MVP items** ✅ *(built 2026-09-24)*
- **Timers and reminders:**  /  / , parsed locally ("set a timer for 10 minutes", "remind me in 20 minutes to take out the laundry", "how much time is left"). Saved to , so they survive a restart; one that went off while AI-DA was closed is announced on the next start if it's under 10 minutes late. Going off plays an alarm chime, is spoken when Aida isn't busy, and shows a Windows notification.
- **Files and folders:**  (Downloads, Documents, Desktop, Pictures, Music, Videos, home, or any folder by name) and  (recent files from Windows' Recent items, then Desktop/Documents/Downloads up to 4 levels, skipping node_modules/.git/AppData). Two equally good matches → Aida asks which; programs and scripts ask before running.
- **Steam games:** Steam's Start-menu shortcuts are  links, which couldn't be launched through the Apps folder; link ids are now opened as links. The Steam libraries (from ) are also scanned for games without a shortcut (27 found on Andy's PC).
- **Offline indicator:** the tray shows "Offline (local commands still work)" when Windows has no network or no AI provider answered in the last 2 minutes. With no network at all, requests that need the AI are answered right away instead of waiting on a timeout.
- **First-run setup:** Welcome (privacy promises) → AI key → voice download → mic check → shortcuts. Every step can be skipped; Settings → General → "Run setup again".

**Phase 4: Tailscale remote → v2.1 release** *(skipped for now, decided 2026-09-23)*
- Add Tailscale detection, the tailnet-only gateway, QR pairing and the phone PWA.
- ✅ *Done when:* you can pause music and lock the PC from your phone on cellular data.

**After that:** pick features from the "Later" list one at a time.

## Known limitations (backlog)

Found while building. Each should be fixed in the phase noted.

| Limitation | Why | Fix (phase) |
|---|---|---|
| ~~"Pause" and "play" both press the play/pause toggle~~ | Media keys only toggle | ✅ Fixed in Phase 3: Windows media sessions send an explicit play or pause |
| ~~Commands wait ~2–3 s after startup~~ | The PowerShell helper compiled `AidaWin.cs` on launch | ✅ Fixed in Phase 3: the precompiled helper starts in ~0.1 s |
| ~~If another app owns Ctrl+Alt+A, the command box only opens from the tray~~ | Global shortcuts are first come, first served | ✅ Fixed in Phase 2: both shortcuts are rebindable in Settings, which warns when one is taken |
| ~~The LLM doesn't see commands that ran locally~~ | The instant path skipped the conversation history | ✅ Fixed in Phase 2: instant commands and replies are added (scrubbed) to the history |
| Spoken replies start 1.1–1.5 s after you stop talking (target: under 1 s) | Kokoro runs at ~0.4× real time on the CPU; DirectML can't run its `ConvTranspose` layers, and the q8 model is slower than real time on Zen 3 CPUs (no VNNI) | Partly fixed in Phase 3: short replies are cached and common ones prepared at startup. Still to do: run Kokoro on WebGPU in the audio window for new sentences (Later) |
| ~~Push-to-talk is "press, then speak", not "hold while speaking"~~ | Electron global shortcuts only report key presses | ✅ Fixed in Phase 3: the helper's keyboard hook reports key-up |
| While "Hey Aida" listening is on, all nearby speech is transcribed on the GPU (locally, then discarded) | The wake word is a Whisper phrase check, not a dedicated detector | Optional trained openWakeWord model as a cheap first gate (Later) |
| "Hey Aida" is hard to catch over loud music or video from speakers | Echo cancellation only removes AI-DA's own audio, not Spotify or games | Use a headset mic, or push-to-talk. Later: echo cancellation using the system's audio output as a reference (sidecar loopback capture) |
| Voice is English only | whisper-server is started with `-l en` | Language setting (Later: multi-language) |
| ~~The installer must unpack native modules from the asar archive~~ | Native `.node` files can't load from inside asar | ✅ Fixed in Phase 3 (`asarUnpack` for onnxruntime-node and sharp) |
| Auto-update only works once releases are published | electron-updater reads `latest.yml` from GitHub Releases | Publish with `npx electron-builder --win --publish always` (needs `GH_TOKEN`); the repo's releases must be public |
| The installer isn't code-signed | No signing certificate | Windows SmartScreen shows "unknown publisher" on first install. A certificate (or Azure Trusted Signing) fixes it (Later) |
| ~~Media sessions name browsers by an id, so replies say "your browser"~~ | Browsers report a hashed app id | ✅ Fixed: ids are matched to Start-menu entries ("Zen") |
| Reading a big web page takes ~3 s (YouTube: ~1,000 controls) | UI Automation walks the page across processes | Search near the focused area first, or cache per page (Later) |
| Playing a never-started video only works on sites with a known key (YouTube `k`; space on Twitch/Netflix/etc.) | Browsers only report media sessions after playback starts, and YouTube hides its player buttons from accessibility tools | Good enough for now |
| ~~Per-app volume and output-device switching (MVP item 7) weren't built~~ | Phase 3 focused on UI control first | ✅ Fixed in Phase 3: `set_app_volume` ("mute Discord", "Spotify volume 30"), `set_output_device` ("switch to my headphones"), `list_audio` |

## Risks and how they're handled

| Risk | How it's handled |
|---|---|
| A sensitive value isn't detected | Layered defense (local STT, context keywords, your sensitive-values list, never-collect rules) plus a build-failing leak-test corpus |
| Free-tier limits change or shrink | Limits live in config, not code. The router learns from 429 responses, and the instant tier keeps the basics working with no LLM. |
| Free Gemini tier trains on what it receives | It only ever gets scrubbed text, never audio or images |
| GPU contention with games | Whisper and Kokoro unload when a full-screen app is using the GPU, with CPU fallback |
| Wake word false triggers | Adjustable sensitivity, a VAD double-check, and a "that wasn't for you" command that logs false positives for retraining |
| AI clicks the wrong thing | UI Automation by element name first, confirmations for risky actions, the panic key and the action log |
| Remote access security | Tailnet only, per-device tokens, the same gate and guard, and off by default |
