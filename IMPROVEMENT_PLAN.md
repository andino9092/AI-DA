# AI-DA improvement plan

Written 2026-11-12. It follows `PLAN.md` (the v2 build history) and the decisions in `DECISIONS.md`
(D-001 to D-007).

## Goals

1. **Voice that works in noise.** Follow the owner's voice through background sound, stop
   transcribing other sounds as speech, and stop ending conversations early (D-001, D-005).
2. **More tasks, done well.** Longer multi-step UI tasks, answering questions, personal data tasks
   and MCP plug-in tools (D-002), on a strengthened single agent loop (D-006), at $0/month (D-003).
3. **A validation system.** Numbers that say whether tasks are handled effectively (did it do the
   right thing?) and efficiently (how many steps, tokens and seconds?). Agent task evals come first
   (D-004).
4. **Learning agentic systems.** Every phase starts with a concept and the decisions that are
   yours to make (D-007).

## Where the project stands

What the code shows today, and why it matters for the goals:

| Area                 | Today                                                                                                                             | Gap                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Working tree         | 51 modified and about 23 new files of v1.2 work are uncommitted, and `PLAN.md` marks much of it "not yet tested live"             | No stable baseline to measure against                                           |
| Agent loop           | `src/main/agent/assistant.ts`: up to 5 steps (`MAX_STEPS`). It returns as soon as every tool says ok, without checking the result | Long tasks run out of steps; nothing verifies the goal was reached              |
| Tool choice          | `tool-selection.ts` picks tool groups by keyword regex, with `more_tools` as the escape hatch                                     | Unmeasured: nobody knows how often the right tools are missing                  |
| Agent tests          | Vitest with fake providers. They test the plumbing, not the model's decisions                                                     | No test ever asks a real model to do a task                                     |
| Measurement          | The action log records commands, routes, tools and replies, with no durations and no token counts                                 | Efficiency can't be reported at all                                             |
| Speech detection     | Silero probability plus a silence timer (`speech-segmenter.ts`, 640 ms). Any sound that looks like speech counts                  | Music and TV open and extend segments                                           |
| Hallucination filter | `stt.ts` asks whisper.cpp for plain text only. The filter is a four-phrase regex in `wake-phrase.ts`                              | Whisper's own confidence signals are thrown away                                |
| Owner's voice        | The voiceprint is checked on "Hey Aida" only. Commands and follow-ups are not checked                                             | Background voices can answer a follow-up question                               |
| Conversation end     | An empty or unusable transcript in command mode shows "Sorry, I didn't catch that" and goes idle (`voice-controller.ts`)          | Likely cause of conversations ending early in noise. To be confirmed in Phase 3 |
| Wake word            | A Whisper transcript matched by regex                                                                                             | Every nearby sound is transcribed on the GPU                                    |

## The order, and why

Measurement comes before change. Without a baseline, an "improvement" is a guess, and a fix for one
case can quietly break three others. So each area gets its measuring tool first, then the changes.

```
Phase 0  Stable baseline
Phase 1  Agent task evals         ← first validation layer (D-004)
Phase 2  Tracing                  ← efficiency numbers from real use
Phase 3  Voice evals, then noise robustness
Phase 4  Stronger agent loop
Phase 5  New task directions      (questions → personal data → MCP)
Phase 6  Validation as a habit
```

Phases 3 and 4 don't depend on each other. If noise is the bigger daily annoyance, Phase 3 can run
right after Phase 1.

---

## Phase 0: Stable baseline

**Why:** every later number is compared with "before", so "before" has to be a commit.

- Run `npm run check` on the current tree and fix what fails.
- Live-test the v1.2 items `PLAN.md` lists as untested: echo-cancelled mic, voice recognition,
  Gmail and Calendar notifications, GPU speech.
- Commit v1.2 on `v2` in logical pieces.

**Done when:** the tree is clean and checks pass.

## Phase 1: Agent task evals

**Concept: evals.** A unit test checks code that always gives the same answer. An LLM doesn't, so
you test it the way you'd grade a person: give it many tasks, score each result, and track the
percentage. An eval has three parts: a **dataset** (tasks), a **harness** (runs the agent on each
task in a controlled world) and **graders** (decide pass or fail). The real model is used; only the
world is fake.

**Build:**

- A headless harness: the real `Assistant`, `LlmRouter`, Privacy Guard and tools, with no
  Electron. Only Windows is fake: the real tools act on a small simulated PC (apps, windows,
  volume, timers, a fake screen), as decided in D-012.
- A dataset of commands, starting from what you actually say. Categories: single tool, multi-tool,
  follow-up turn, ambiguous (should ask), impossible (should say so), risky (should confirm),
  privacy (placeholder must pass through unchanged).
- Graders, scoring per task:
  - **Effective:** end state of the fake PC is right; the right tools were called with the right
    arguments; the reply is acceptable.
  - **Efficient:** LLM round trips, tool calls, input and output tokens, wall time.
- `npm run eval`: runs the set several times per task (models vary run to run) and writes a report
  with pass rates per category and per model.
- First use: compare the free models (Gemini Flash-Lite, Groq `qwen/qwen3.8-27b`, Groq
  `openai/gpt-oss-120b`). This answers D-003's open question with data.
- Second use: measure tool selection. How often is the needed tool missing from the first request,
  and what does `more_tools` cost?

**Decisions for you:**

- Dataset file format and where it lives.
- How replies are graded: fixed rules, an LLM as judge, or both.
- How many free-tier requests an eval run may spend, and whether it runs in CI or only by hand.
- Whether the instant parser is graded in the same dataset or its own.

**Done when:** one command prints a scorecard, and the model comparison is written down.

### Phase 1 results (2026-11-12)

Built: `evals/` (harness, graders, 35 tasks, runner, report) and `npm run eval`. 14 tasks are
handled by the local parser and also run in `npm test`; 21 need a model, 3 runs each.

| Model                          | Pass rate      | Model calls per task | Seconds per call | Main weakness                                              |
| ------------------------------ | -------------- | -------------------- | ---------------- | ---------------------------------------------------------- |
| Gemini `gemini-3.5-flash-lite` | 59 of 63 (94%) | 1.3                  | 3.2              | Never asks on the ambiguous task                           |
| Groq `openai/gpt-oss-120b`     | 47 of 63 (75%) | 1.2                  | 0.5              | Fails multi-step tasks; 6 runs rejected for bad tool calls |
| Groq `qwen/qwen3.8-27b`        | 39 of 56 (70%) | 1.4                  | 0.6              | Asks instead of acting; fails follow-ups                   |

Seven Qwen runs could not be graded: the day's free token allowance for that model (200,000) ran
out. At about 3,900 tokens a request, that allowance is roughly 50 requests a day, not the 900
the settings assume.

Found in AI-DA itself (input to Phase 4):

- **Early exit drops steps.** The loop stops when every tool reports success. A model that calls
  one tool at a time (gpt-oss-120b) opens Discord and never gets to VS Code or the volume.
- **Keyword tool selection misses synonyms.** "Silence Discord" doesn't offer the mute tool. Most
  runs then ask for more tools (one extra round trip, 8 of 63 Gemini runs); one run closed Discord
  instead.
- **Replies leave out earlier passes.** After stopping the music and muting Discord over two
  passes, Aida says only "Muted Discord."
- **One invalid tool call fails the whole request on Groq**, with no retry.
- **The instant parser grabs descriptions.** "Open the program I write code in" is first tried as
  an app name.
- **Privacy held.** The test card number reached every model only as `[CARD_1]`.

Open: which Groq model is the backup (D-003).

## Phase 2: Tracing

**Concept: traces and spans.** A trace is the record of one request; a span is one timed stage in
it (transcribe, parse, LLM call, tool, speak). Evals tell you how the agent does on tasks you
thought of. Traces tell you what happens on the ones you really give it.

**Build:**

- Durations on every stage and token counts from each provider response, written through the
  existing scrubbed log.
- A report command: latency per stage (median and worst 5%), instant-versus-LLM share, steps per
  request, failures by kind, requests per day against free quotas.
- A way to turn a logged request that went wrong into an eval task. This is how the dataset grows.

**Decisions for you:**

- Extend the action log or add a third log file (a file-format decision).
- Whether Settings shows any of it.

**Done when:** the report runs over a week of real use.

## Phase 3: Voice evals, then noise robustness

**Concept: the signal chain and its error types.** Each stage can fail in two directions. Wake
detection has false accepts (the TV woke it) and false rejects (you were ignored). Transcription
has word error rate, plus hallucinations: text produced from sound that wasn't speech. End-of-turn
detection can cut you off or wait too long. Tuning one direction usually costs the other, which is
why changes are judged on a fixed set of recordings.

**3a. Measure**

- A recorder in Settings → Mic check that saves labelled clips to a local folder (never uploaded):
  you in quiet, you over music, you over a talking video, music alone, video alone, another person.
- A replay harness that feeds clips through the real segmenter → speaker check → Whisper → wake
  match and scores false accepts, false rejects, word error rate, hallucinated transcripts and
  early cut-offs.
- Reproduce the "conversation ends early" case from a recording and confirm its cause.

**3b. Improve, one stage at a time, keeping only what the numbers support**

| Step | Change                                                                                                                  | Targets                                  |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1    | Ask whisper.cpp for its confidence values (no-speech probability, average log-probability) and drop low-confidence text | Hallucinations                           |
| 2    | Check the voiceprint on commands and follow-ups, not only on "Hey Aida"                                                 | Background voices                        |
| 3    | In command and follow-up mode, treat unusable audio as "still listening", not as the end                                | Early endings                            |
| 4    | Noise suppression in front of the speech detector and Whisper                                                           | Hearing you through noise                |
| 5    | Owner-voice gating of the speech detector itself, so only your voice opens or extends a segment                         | Hearing you through noise, early endings |
| 6    | End-of-turn detection that looks at whether the sentence sounds finished, not only at silence                           | Cut-offs                                 |
| 7    | A small dedicated wake-word model in front of Whisper                                                                   | False wakes, GPU use                     |
| 8    | Bias Whisper toward your vocabulary (app names, nicknames, artists) and let the LLM repair likely mishearings           | Wrong transcription                      |

Steps 1 to 3 use what is already in the app. Steps 4 to 7 each add a model.

**Decisions for you:**

- For each of steps 4 to 7: which model, and whether it is worth its size and delay. I'll bring
  options with measured numbers.
- Where the corpus lives and whether it is ever committed (it is your voice).
- Target numbers, once the baseline is known.

**Done when:** the noisy-clip scores meet the targets you set, and the quiet-clip scores haven't
dropped.

## Phase 4: Stronger agent loop

**Concept: the agent loop.** An agent is a model in a loop: it reads the situation, picks an
action, sees the result, and repeats until done. Reliability on long tasks comes less from the
model than from the loop around it: what it is shown after each action, how it knows it is
finished, what happens on failure, and how much history it carries.

**Build (D-006), each change scored on Phase 1's suite plus new long-task evals:**

- **Observe after acting:** UI actions return what changed on screen, so the model sees the effect.
- **Verify before finishing:** for multi-step tasks, a check that the goal state was reached.
- **Step budget:** raised from 5 and tied to progress, with a clear spoken status on long tasks.
- **History trimming:** old screen readings are shortened so long tasks fit free-tier token limits.
- **Failure recovery:** tool errors written so the model can act on them ("no button named Send;
  visible buttons are…").
- **Tool descriptions:** reviewed against eval failures. Tool wording is prompt engineering.

**Decisions for you:**

- How verification works: a rule per tool, or one extra model call.
- The trimming strategy: drop, shorten, or summarise old results.
- Whether keyword tool selection stays or is replaced, based on Phase 1's numbers.

**Done when:** long-task pass rate reaches your target without making short commands slower.

## Phase 5: New task directions

In order of risk, lowest first. Each one adds eval tasks before it adds tools.

**5a. Answering questions.** Web search, summarise the page or the selected text, longer spoken
answers. _Concept: grounding_, answering from retrieved text instead of the model's memory.
Decisions: a search source that fits $0; how search queries pass the Privacy Guard; how long a
spoken answer may be.

**5b. Personal data tasks.** Draft and send email, create calendar events, find and move files.
_Concept: write actions and human-in-the-loop_: what needs a confirmation and what can be undone.
Decisions: Gmail access is headers-only today by design, and drafting replies needs message text,
which changes that; this conflicts with an earlier choice and comes back to you. Also: which
actions always confirm, and where notes live.

**5c. MCP plug-in tools.** _Concept: Model Context Protocol_, a standard way for an agent to
discover and call tools from separate servers, so you add capabilities without writing them.
Decisions: which client library; how untrusted tool servers are sandboxed and confirmed; how their
results pass the Privacy Guard; how dozens of extra tools stay out of every prompt.

## Phase 6: Validation as a habit

- A small, fast eval subset that must pass before a change is merged; the full suite before a
  release.
- The scorecard history kept in the repo, so a drop is visible.
- A weekly trace report, and failed real requests turned into eval tasks.

---

## Scorecard

Baselines are measured in Phases 1 to 3; targets are yours to set once they're known.

| Question                        | Metric                                                             | Source                          |
| ------------------------------- | ------------------------------------------------------------------ | ------------------------------- |
| Does it do the right thing?     | Task pass rate, per category                                       | Agent evals                     |
| Does it pick the right tool?    | Tool and argument accuracy; needed tool missing from first request | Agent evals                     |
| Is it economical?               | LLM round trips, tool calls, tokens per task                       | Agent evals, traces             |
| Is it fast?                     | Seconds per stage, median and worst 5%                             | Traces                          |
| Does it stay private?           | Leak-corpus values in outbound requests (must be 0)                | Existing leak test, agent evals |
| Does it hear me?                | False rejects on owner clips, in quiet and in noise                | Voice evals                     |
| Does it ignore everything else? | False accepts and hallucinated transcripts on noise-only clips     | Voice evals                     |
| Does it get the words right?    | Word error rate on owner clips                                     | Voice evals                     |
| Does it let me finish?          | Early cut-offs and early conversation endings                      | Voice evals                     |
