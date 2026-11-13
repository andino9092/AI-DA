# Decisions

The decision log for AI-DA. Entries are numbered in order and never rewritten; a changed decision
gets a new entry and the old one is marked `Superseded by D-NNN`.

Decisions made before this log existed (platform, local ears and voice, cloud free-tier brain,
$0/month, Privacy Guard, no Picovoice) are in the "Decisions made" table of `PLAN.md` and still
stand unless an entry here says otherwise.

## D-001: Voice work targets noise robustness first

- **Date:** 2026-11-12
- **Status:** Accepted
- **Context:** Planning the next round of improvements. Asked which voice problems actually occur
  in daily use.
- **Decision:** The voice work targets, in this order of importance:
  1. Following the owner's voice through background noise, the way Claude's voice conversations do.
  2. Not transcribing ("hallucinating") background sounds as speech.
  3. Not ending a conversation early because of noise.
  4. Missed or false wake-ups.
  5. Wrong transcription.
- **Options considered:** "Feels slow" and "stilted conversation" were offered and not selected, so
  latency and turn-taking polish are not goals in their own right. They are only worked on where
  they serve the points above.
- **Consequences:** Voice changes are judged on noisy recordings, not quiet ones. Latency must not
  get noticeably worse, but it is not the thing being optimised.

## D-002: AI-DA should grow in four task directions

- **Date:** 2026-11-12
- **Status:** Accepted
- **Context:** Asked which kinds of new tasks AI-DA should handle well, because that decides how the
  agent loop has to grow.
- **Decision:** All four: longer multi-step UI tasks, answering questions (web search, summarising),
  personal data tasks (email, calendar, files, notes), and plug-in tools through MCP.
- **Options considered:** Picking a subset. Not chosen; the order they are built in is a planning
  matter, not a scope cut.
- **Consequences:** The agent loop needs observe-and-verify steps, write-capable tools with
  confirmations, and an MCP client. Each direction needs its own eval tasks (see D-004).

## D-003: The brain stays at $0/month; model choice is settled by measurement

- **Date:** 2026-11-12
- **Status:** Accepted
- **Context:** Harder tasks usually need a stronger model, and PLAN.md records a $0/month cloud
  free-tier brain. Asked whether to keep that, add paid escalation, or move to a local model. Andy's
  answer: ideally $0, and whether Groq offers better models for free.
- **Decision:** Keep $0/month. Groq does list a larger model at no cost (`openai/gpt-oss-120b`,
  next to the `qwen/qwen3.8-27b` in use), so free models are compared with the eval suite instead of
  picked by reputation.
- **Options considered:**
  - Opt-in escalation to a paid model: not chosen, it breaks $0.
  - A local model in Ollama as the brain: not chosen for now. 8 GB of VRAM is shared with Whisper
    and Kokoro, and small local models are weaker at tool calling.
- **Consequences:** The limit that matters on free tiers is tokens per minute (Groq's table shows
  8K), so prompt and tool-definition size stay a first-class cost. Revisit only if the evals show
  that no free model can do a task class.

## D-004: Agent task evals are the first validation layer

- **Date:** 2026-11-12
- **Status:** Accepted
- **Context:** A validation system can test three layers: the agent's decisions, the voice
  pipeline, or real usage through tracing. Asked which to build first.
- **Decision:** Agent task evals first: a dataset of typed commands with expected outcomes, run
  against the real LLM with fake tools, scored on task success, tool-call accuracy, steps, tokens
  and latency.
- **Options considered:**
  - Voice evals first (a corpus of recorded clips scored on false accepts, false rejects and word
    error rate): not first, but needed before the noise work in D-001 can be judged.
  - Production tracing first (timing and token counts in the action log): not first; it only finds
    problems after they happen.
- **Consequences:** The eval runner needs the assistant to be drivable without Electron, with tools
  replaced by fakes. Voice evals and tracing follow as later layers.
- **Note (2026-11-13):** "fake tools" above was loose wording from before the question was put
  properly. D-012 settles it: the tools are real and only Windows is fake.

## D-005: Noise robustness comes from upgrading the local voice pipeline

- **Date:** 2026-11-12
- **Status:** Accepted
- **Context:** D-001 asks for voice that follows the owner through background noise, like a voice
  chat app. PLAN.md's privacy decision says raw audio never leaves the PC.
- **Decision:** Keep the local pipeline (mic → speech detector → Whisper → LLM → Kokoro) and add
  stages to it: noise suppression, a gate that only counts the owner's voice as speech (using the
  existing voiceprint), Whisper confidence checks to drop hallucinated text, and a smarter
  end-of-turn detector.
- **Options considered:**
  - A cloud speech-to-speech model (e.g. Gemini Live): best conversational feel with the least
    code, but raw audio leaves the PC and free quotas are small. Not chosen.
  - Hybrid, with an opt-in cloud conversation mode: two code paths to build and test, and privacy
    becomes "local by default". Not chosen.
- **Consequences:** The privacy decision stands unchanged. Which specific models and libraries fill
  each new stage is still open and is decided stage by stage, on voice-eval numbers.

## D-006: Longer tasks are handled by strengthening the single agent loop

- **Date:** 2026-11-12
- **Status:** Accepted
- **Context:** D-002 adds longer multi-step tasks. Today's loop lets the model pick tools and see
  results up to 5 times, and never checks that the goal was reached.
- **Decision:** Keep one model in one loop (reason, act, observe) and add what it lacks: observing
  the screen after actions, a check that the goal was reached, a larger step budget, and trimming
  old history.
- **Options considered:**
  - Plan, then execute: more reliable on long tasks, but at least one extra LLM round trip on every
    hard request. Not chosen.
  - An orchestrator with specialist sub-agents: scales to many tools, but multiplies requests
    against small free quotas and is the hardest to debug. Not chosen.
- **Consequences:** Cheapest in free-tier tokens (D-003). Revisit if the evals show a class of tasks
  that the single loop cannot finish.

## D-007: Working mode is "Claude explains, Andy decides, Claude builds"

- **Date:** 2026-11-12
- **Status:** Accepted
- **Context:** Andy wants to learn how agentic systems are built by working on this project.
- **Decision:** Each phase opens with a short concept note and the decisions for Andy to make.
  Claude writes the code and walks through what was built and why.
- **Options considered:**
  - Andy builds the core and Claude reviews: deepest learning, slowest. Not chosen.
  - Choosing per phase: not chosen.
- **Consequences:** Every phase in the improvement plan lists its concept and its open decisions
  before any code is written.

## D-008: Eval tasks are TypeScript files

- **Date:** 2026-11-12
- **Status:** Accepted
- **Context:** Phase 1 needs a format for eval tasks. Phase 2 builds on it when a logged request
  is turned into a task.
- **Decision:** Tasks are typed objects in `evals/tasks/*.ts`: the command or commands, the
  starting state of the simulated PC, and the expectations. Common checks are declarative fields;
  an unusual check can be a small function.
- **Options considered:** JSON or YAML data files with a fixed vocabulary of checks. Easier to
  generate from logs and to edit without knowing the code, but every new kind of check extends the
  vocabulary and typos only show at run time. Not chosen.
- **Consequences:** The compiler catches a renamed tool or a typo in a task. Phase 2's
  log-to-task step has to emit TypeScript.

## D-009: Eval runs are graded by rules only, for now

- **Date:** 2026-11-12
- **Status:** Accepted
- **Context:** Each eval run has to be judged pass or fail.
- **Decision:** Code checks only: the simulated PC's end state, which tools were called with which
  arguments, whether a confirmation was requested, and whether the reply matches a pattern or asks
  a question.
- **Options considered:** Adding an LLM judge for spoken replies now. It catches wording that
  rules miss, but spends free-tier requests and needs its own checking. Not chosen for now.
- **Consequences:** Grading is free and repeatable. An LLM judge is reconsidered in Phase 5a, when
  answers to questions can't be checked by rule.

## D-010: Vitest runs the evals, with its own config

- **Date:** 2026-11-12
- **Status:** Accepted
- **Context:** The eval code needs something to compile and run TypeScript.
- **Decision:** Reuse Vitest with a separate config and an `npm run eval` script. The scorecard is
  written as a report file and printed at the end.
- **Options considered:** A standalone script run through `tsx`: cleaner control over output and
  rate limits, but a new dev dependency. Not chosen.
- **Consequences:** No new dependency. Evals stay out of `npm test` and `npm run check`, because
  they need API keys and spend quota.

## D-011: Embedding-based app matching waits for eval numbers

- **Date:** 2026-11-12
- **Status:** Accepted
- **Context:** Andy proposed adding embeddings to app matching, so that a description ("open my
  music app") finds the app without a model call. App matching today is fuzzy text matching (edit
  distance, prefixes, initials) in `src/main/util/fuzzy.ts`.
- **Decision:** Not now. The Phase 1 dataset gets tasks that describe an app instead of naming it.
  Embeddings are reconsidered in Phase 4 if those tasks turn out to be common and slow or
  unreliable through the model.
- **Options considered:** Adding a local embedding model now, with app-name vectors held in
  memory (no vector database is needed for a few hundred names). Not chosen yet: it is weak on
  typos, app names are little text to embed, a confident wrong match opens the wrong app, and it
  is one more model to download and keep loaded.
- **Consequences:** Described-app requests keep going to the cloud model for now. The eval
  dataset must include them so the choice can be made on numbers.

## D-012: Evals run AI-DA's real tools on a fake Windows

- **Date:** 2026-11-12
- **Status:** Accepted
- **Context:** The eval harness has to decide which layers run for real and which are stand-ins.
  The model and the agent loop are real by definition (D-004).
- **Decision:** The real tool code runs against an in-memory Windows object (the `FakeWindows`
  the unit tests already use). Tools that reach the internet (weather, Spotify, Gmail, Calendar)
  get small fake clients.
- **Options considered:**
  - Fake tools (stubs that record the call and return a canned sentence): simpler, but the eval
    would stop testing the real tool descriptions, error messages and look-again flags, where much
    agent behaviour comes from. Not chosen.
  - Real tools on the real PC: most realistic, but not repeatable, slow, and it moves windows and
    changes volume while running. Not chosen.
- **Consequences:** The eval measures what ships: a change to a tool's wording shows up in the
  score. `FakeWindows` becomes shared between tests and evals, and its starting state is what
  each task's `setup` adjusts.

## D-013: Evals read API keys from environment variables

- **Date:** 2026-11-12
- **Status:** Accepted
- **Context:** The app keeps the Gemini and Groq keys in a vault encrypted with Electron's
  `safeStorage`, which only opens inside Electron. The eval harness runs without Electron.
- **Decision:** The eval reads `GEMINI_API_KEY` and `GROQ_API_KEY` from the environment. Andy sets
  them himself. A model whose key is missing is skipped.
- **Options considered:**
  - A git-ignored `.env` file: convenient, but keys sit in plain text in the repo folder and a
    `.gitignore` mistake could commit them. Not chosen.
  - Running the eval inside Electron to read the vault: one place for keys, but slower and more
    complex. Not chosen.
- **Consequences:** No key is ever written into the repo. The same mechanism works in CI later.

## D-014: Each eval task runs 3 times per model

- **Date:** 2026-11-12
- **Status:** Accepted
- **Context:** Model answers vary from run to run, and free tiers allow roughly 500 requests a day
  on Gemini and 1,000 on Groq.
- **Decision:** 3 runs per task and model by default.
- **Options considered:** 5 runs (steadier, but about half of Gemini's daily allowance per eval
  run) and 1 run (cheap, but cannot show flakiness). Not chosen as the default.
- **Consequences:** About 30 tasks on 3 models is roughly 150 requests per model per eval run. The
  count stays configurable for a quick single run or a closer comparison.

## D-015: Instant-path commands are in the same dataset, with an expected route

- **Date:** 2026-11-12
- **Status:** Accepted
- **Context:** Some commands are handled by the local instant parser and never reach the model.
- **Decision:** One dataset. Every task states whether it should be handled instantly or by the
  model, and the eval checks the route as well as the outcome.
- **Options considered:**
  - Separate datasets for the parser and the model: cleaner reports per part, but nothing checks
    the hand-off, where commands get misrouted. Not chosen.
  - Bypassing the parser in evals: shows the model on everything, but no longer reflects real use
    and spends quota. Not chosen.
- **Consequences:** The eval measures AI-DA as it is used. Instant tasks cost no quota and can run
  with no API key at all.

## D-016: The Groq backup model is chosen after the loop fix

- **Date:** 2026-11-13
- **Status:** Accepted
- **Context:** Phase 1's evals compared the free models (results in `IMPROVEMENT_PLAN.md`). Gemini
  `gemini-3.5-flash-lite` passed 94% and stays the main model, as D-003 intended. The two Groq
  candidates for backup were close: `openai/gpt-oss-120b` 75%, `qwen/qwen3.8-27b` (the current
  backup) 70%.
- **Decision:** Keep Qwen as the backup for now. Decide again after Phase 4 fixes the loop's early
  exit, with a fresh eval run.
- **Options considered:** Switching to `openai/gpt-oss-120b` now. It is better on described apps
  and follow-ups and faster, but it calls one tool at a time, and today's loop then silently drops
  the remaining steps of a multi-part request. That is a worse failure than Qwen asking a
  question. Not chosen yet.
- **Consequences:** The early-exit fix in Phase 4 is what unblocks this. Groq's free allowance
  turned out to be about 50 requests a day per model at the current prompt size, so a full eval of
  a Groq model uses most of that model's day.
