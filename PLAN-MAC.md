# AI-DA for macOS: Plan

Status: **proposal, nothing built yet** (written 2026-09-25). This extends "macOS port" (Later #10 in [PLAN.md](PLAN.md)) now that Siri AI shipped in macOS 27.

---

## Can Siri already do all of this?

**About half of it.** macOS 27 (Golden Gate, September 2026) shipped **Siri AI** as a beta: a rebuilt Siri, made with Google's Gemini, that runs on the Mac and on Apple's Private Cloud Compute. It understands what's on screen, remembers context from your Mail, Messages and Notes, and can act inside apps. The catch is that it can **only act inside apps that expose actions through App Intents**. Siri AI needs an M1 or later Mac (the best on-device model needs M3 and 12 GB), and for now it's English only.

| AI-DA feature | Siri on macOS 27 | Notes |
|---|---|---|
| Volume, mute | ✅ Yes | |
| Play, pause, skip, "what's playing" | ✅ Mostly | Apple Music and the system's Now Playing app. Spotify only as far as its Mac app supports it |
| Open apps | ✅ Yes | |
| Open files and folders | ✅ Yes | Siri AI searches files and folders across the system |
| Timers, alarms, reminders | ✅ Yes | Clock app on the Mac |
| Weather, unit conversion, time | ✅ Yes | |
| Routines ("gaming mode") | ✅ Yes, through Shortcuts | Name a shortcut and say it |
| Memory ("remember that…") | 🟡 Different | Siri knows personal context from your apps, but has no explicit fact list or nicknames you control |
| Spotify search and play | 🟡 Depends on Spotify | Only if Spotify's Mac app adopts App Intents |
| **Click, type or scroll in any app by name** ("click Send in Discord") | ❌ No | Only in apps that adopted App Intents. **This is AI-DA's biggest difference** |
| **Per-app volume** ("mute Discord") | ❌ No | macOS itself has no per-app volume |
| **Switch output device** ("switch to my headphones") | ❌ Not reliably | |
| **Snap and move windows** | ❌ No | macOS has tiling, but only by mouse or keyboard |
| **Your own wake word, hold-to-talk, panic key** | ❌ No | "Siri" / "Hey Siri" only |
| **Privacy Guard** (scrub before the cloud, sensitive-apps list) | 🟡 Different model | Apple's approach (on-device plus Private Cloud Compute, nothing stored) is strong, but you can't see or control what it sends |
| **Choice of AI model**, your own free Gemini/Groq key | ❌ No | |
| **Same assistant on your Windows PC** | ❌ No | Siri doesn't exist on Windows |
| Intel Macs, languages other than English | ❌ No | macOS 27 dropped Intel |

### What that means

Porting all of AI-DA to the Mac and competing with Siri on timers and weather would be wasted effort. On the Mac, AI-DA should be **the assistant for what Siri won't do**, plus the same memory, routines and settings you have on Windows. The everyday features still come along, because they're already platform-free TypeScript and cost almost nothing to keep.

**Recommendation: a Mac companion that works _with_ Siri, not a clone.**

---

## Three ways to use Siri

| # | Direction | What it gives us | Cost |
|---|---|---|---|
| 1 | **AI-DA → Shortcuts** | A `run_shortcut` tool that calls the built-in `shortcuts` command-line tool (`shortcuts list`, `shortcuts run "<name>"`). Aida can reach anything Siri can reach through Shortcuts (Home, Reminders, Messages, Focus modes, every app with App Intents) without us building those tools. Routines can include shortcuts. | **Small.** One tool, one instant-parser rule. Shortcut output goes through the Privacy Guard like any tool result. |
| 2 | **Siri → AI-DA** | AI-DA exposes its own **App Intents** ("Ask Aida", "Click in app", "Set app volume", "Switch output", "Snap window", "Run routine"). Siri AI can then call them and chain them with other apps: "Siri, mute Discord and click Join in Zoom." They also show up in Shortcuts and Spotlight. On the Mac, **Siri can be the voice**, and AI-DA supplies the hands. | **Medium, needs a spike.** App Intents are Swift-only and have to live in an app bundle. The likely route is a small Swift App Intents extension inside the Electron app that forwards each intent to the running AI-DA over a local socket with a per-install token. Siri may only discover intents from a signed app (see Decisions). |
| 3 | **Apple's on-device model as a brain** | Apple's Foundation Models framework gives apps the on-device Apple Intelligence model with tool calling, **free, offline and private**. It's an `LlmProvider` behind the existing interface, and it covers "Fully offline brain" (Later #7) on the Mac. | **Medium.** Called through the Swift helper. Needs testing on how well the small model picks between ~40 tools; the plan is to send only the tools a command needs (already on the backlog). |

Not planned: replacing AI-DA's own voice with Siri everywhere. The Windows PC still needs it, and on the Mac it's mostly shared code (see M4). Siri is an extra way in, not the only one.

---

## What ports as-is

Most of AI-DA is already platform-free TypeScript.

| Works unchanged | Needs a Mac version |
|---|---|
| Privacy Guard, egress, leak tests | The native helper (`aida-win.exe` → `aida-mac`) |
| Instant parser (key names need a Mac mapping) | App index and launching (Start menu → `/Applications` and Spotlight) |
| Agent loop, router, quota, Gemini/Groq providers | Recent files (Windows' Recent folder → Spotlight's "last used" date, `mdfind`) |
| Timers, weather, units, memory, routines, Spotify Web API | Steam library path (`~/Library/Application Support/Steam`) |
| Settings, secret vault (`safeStorage` uses the Keychain on the Mac) | Speech-to-text runtime (CUDA whisper.cpp → Metal build, or Apple's speech recognizer) |
| Overlay, palette and settings windows | Tray → menu bar (template icons) |
| Silero VAD, Kokoro TTS (CPU; Apple Silicon is faster than the Zen 3 CPU) | Hotkeys (key codes, hold-to-talk hook) and default shortcuts |
| Launch at login (`setLoginItemSettings`) | Packaging, signing, auto-update |

### Refactor first (on Windows, no Mac needed)

`WindowsBridge` is almost the right interface, but it leaks Windows details: virtual-key codes in `HotkeyBinding`, `win` as a modifier, and `.exe` names. `src/main/index.ts` also calls `explorer.exe`, `reg.exe` and the Windows Recent folder directly.

- Rename `WindowsBridge` → `PlatformBridge` and move it to `src/main/platform/`, with `win/` and `mac/` implementations.
- Add **capabilities** (`perAppVolume`, `outputSwitching`, `ocr`, …) so tools register only what the platform supports, and the AI is never offered a tool that can't work.
- Hotkeys: key names instead of vk codes; the helper maps them. `win` becomes `meta` (⌘ on the Mac).
- Move `launcher`, `recentDir`, the Steam path and the whisper binary name behind the platform module.
- CI: run typecheck, lint and tests on `macos-latest` as well as `windows-latest` (free for public repos).

---

## The Mac helper: `aida-mac`

The same design as `aida-win.exe`: a small precompiled process speaking the same JSON-RPC over stdio, so almost no TypeScript changes. **Swift**, because Accessibility, Core Audio, Vision, App Intents and Foundation Models are all Swift/Objective-C APIs. It's built with `swiftc` from the free Xcode command-line tools, the way `csc.exe` builds the Windows helper today. Everything else stays in TypeScript.

| Bridge area | Windows today | macOS | Difficulty |
|---|---|---|---|
| Volume, mute | Core Audio | Core Audio (`kAudioDevicePropertyVolumeScalar`) | Easy |
| Output devices | Core Audio policy config | Core Audio `kAudioHardwarePropertyDefaultOutputDevice` | Easy |
| Per-app volume | Audio sessions | **No system API.** Core Audio process taps (macOS 14.2+) can mute an app's output; setting a level means re-playing its audio | Mute: medium. Level: hard, later |
| Ducking while Aida listens | Per-app volume | Pause what's playing and resume after (level ducking later, with process taps) | Easy |
| Media sessions | WinRT media sessions | AppleScript for Spotify and Music (both scriptable, give track names); media-key events for everything else. The private MediaRemote framework was locked down in macOS 15.4, so avoid it | Medium |
| Window list, focus, move, snap, minimize | Win32 | `CGWindowListCopyWindowInfo` + Accessibility (`AXUIElement` position/size). Window titles need Screen Recording permission | Medium |
| UI tree, click, focus, read values | UI Automation | Accessibility API (`AXUIElement`, `AXPress`). Chromium/Electron apps need `AXManualAccessibility` set to build their tree (the same issue fixed on Windows). Password fields are `AXSecureTextField`: never read | Medium–hard |
| OCR | Windows.Media.Ocr | Vision (`VNRecognizeTextRequest`) on a ScreenCaptureKit capture. Stays inside the helper | Medium |
| Typing, keys, clicks | SendInput | `CGEvent` | Easy |
| Hold-to-talk, panic key | Low-level keyboard hook | `CGEventTap` (needs Input Monitoring) | Medium |
| App list | Start menu | Spotlight (`kMDItemContentType == com.apple.application-bundle`), launch with `open -b <bundle id>` | Easy |
| Sensitive apps | Process names, title words | Bundle ids (`com.1password.1password`, `com.bitwarden.desktop`) plus the same title words | Easy |
| Speech-to-text | whisper.cpp CUDA 12.4 | whisper.cpp **Metal** build (we build `whisper-server` in CI; there's no official Mac binary) **or** Apple's on-device speech recognizer through the helper, which needs no model download. Decide with a spike | Medium |
| Brain (optional) | — | Foundation Models (on-device) | Medium |
| Siri intents | — | App Intents extension | Medium, spike |

### Permissions the user grants (once, in System Settings → Privacy & Security)

Microphone, **Accessibility** (click, type, windows), **Screen Recording** (window titles, OCR), **Input Monitoring** (hold-to-talk). The first-run setup gets a Mac step that checks each one, explains why and opens the right settings pane. AI-DA keeps working with any of them missing and only drops the tools that need them.

---

## Phases

Each phase ends with something you can run.

**M0: Platform refactor** *(Windows only, no Mac needed)*
- `PlatformBridge`, capabilities, key names, platform module, macOS CI job.
- ✅ *Done when:* Windows behaves exactly as before, and typecheck and tests pass on `macos-latest`.

**M1: Text mode on the Mac**
- Menu bar icon, settings, palette (`⌃⌥A`), Privacy Guard, Gemini/Groq.
- `aida-mac` basics: volume, output device, media (AppleScript + media keys), app list and launching, windows.
- Timers, weather, units, memory, routines, Spotify and files come along unchanged.
- ✅ *Done when:* typing "open Spotify and set volume to 30" works on the Mac.

**M2: Siri and Shortcuts**
- `run_shortcut` tool (Siri way 1).
- Spike, then build the App Intents extension (Siri way 2): "Ask Aida" first, then the tools Siri doesn't have.
- ✅ *Done when:* "Siri, ask Aida to mute Discord" works, and Aida can run one of your shortcuts.

**M3: Control any app** *(AI-DA's main reason to exist on the Mac)*
- Accessibility tree, click/type/scroll by name, Vision OCR fallback, sensitive apps, confirmations, panic key.
- ✅ *Done when:* "click the Send button in Discord" works, and nothing is read while 1Password is in front.

**M4: AI-DA's own voice**
- Audio window, VAD and wake phrase are shared code. Speech-to-text as decided in the spike. Kokoro on CPU. Hold-to-talk through `CGEventTap`.
- ✅ *Done when:* "Hey Aida, pause the music" works hands-free.

**M5: Packaging**
- `.dmg` for Apple Silicon, Mac-specific first-run steps, and auto-update if signing is decided (see below).

**M6: On-device brain** *(optional)*
- Foundation Models provider (Siri way 3), used offline or as a private first choice.

M0 is useful even if the Mac version waits: it cleans up the Windows code.

---

## Decisions needed

| # | Question | Recommendation |
|---|---|---|
| 1 | **Do you have a Mac to build and test on?** Which chip and macOS version? | Needed from M1 on. CI can build and run unit tests, but not grant permissions or test voice |
| 2 | **Pay for the Apple Developer Program ($99/year)?** Without it: macOS blocks the app on first open (right-click → Open works), **auto-update doesn't work on the Mac**, the permissions above have to be granted again after every update (macOS ties them to the signature), and Siri may not pick up AI-DA's intents. This breaks the $0/month target | Develop unsigned. Decide before the first public Mac release. Worth it if you'll use the Mac version daily |
| 3 | **Speech-to-text on the Mac:** whisper.cpp with Metal (same model as Windows, ~0.6 GB download; no CUDA runtime needed) or Apple's speech recognizer (no download, but closed) | Spike both in M4, pick by accuracy on "Hey Aida" and latency |
| 4 | **Minimum macOS:** 27 only (Siri AI, newest APIs) or 26 too | 26 and later. Siri features light up when available |

---

## Risks

| Risk | How it's handled |
|---|---|
| Embedding App Intents in an Electron app doesn't work, or needs signing | Spike first in M2. Fallback: way 1 (Shortcuts) plus a small "Ask Aida" shortcut we ship that calls AI-DA through a URL scheme |
| Apple locks down more private APIs (as it did with MediaRemote) | Only public APIs and AppleScript |
| Siri AI grows into the gaps (per-app actions spread as developers adopt App Intents) | Fine: AI-DA hands those to Siri through Shortcuts. The any-app UI control, audio routing, own voice and cross-platform setup remain |
| Accessibility trees in Chromium apps are incomplete | Same fix as Windows (wake the tree), then OCR |
| Permission prompts put people off | One setup step that explains each and degrades gracefully |

## Sources (September 2026)

- [macOS 27: Siri AI top features (9to5Mac)](https://9to5mac.com/2026/09/17/macos-27-golden-gate-siri-ai-top-features-apples-assistant-finally-comes-to-life-video/)
- [Siri AI is here (Apple Newsroom)](https://www.apple.com/newsroom/2026/09/siri-ai-a-profoundly-more-capable-and-personal-assistant-is-here/)
- [How to get Siri AI (Apple Support)](https://support.apple.com/en-us/127893)
- [macOS Golden Gate features and compatibility (Macworld)](https://www.macworld.com/article/3139330/macos-27-mac-features-siri-apple-intelligence-release-date-compatibility.html)
- [Siri AI and the AI-native OS: App Intents reach (SoftwareSeni)](https://www.softwareseni.com/siri-ai-and-the-ai-native-operating-system-in-ios-27-and-macos-27/)
- [WWDC 2026: App Intents replaces SiriKit (Tech Times)](https://www.techtimes.com/articles/318005/20260608/wwdc-2026-app-intents-replaces-sirikit-gemini-siri-migration-clock-starts.htm)
- [Native code and Electron: Swift on macOS (Electron docs)](https://www.electronjs.org/docs/latest/tutorial/native-code-and-electron-swift-macos)
