import { z } from 'zod';
import type { OcrLine, UiElement, WindowInfo, WindowsBridge } from '../../native/win-host';
import { StaleElementError } from '../../native/win-host';
import { matchSensitiveApp, SensitiveWindowError } from '../../privacy/sensitive-apps';
import { matchScore, normalizeName } from '../../util/fuzzy';
import { findWindow, label } from '../windows/tools';
import type { ToolContext, ToolResult } from '../types';
import { defineTool } from '../types';

export interface UiToolDeps {
  win: WindowsBridge;
  sensitiveApps: () => readonly string[];
}

/** Controls whose click can't be taken back: always asked about first. */
const RISKY_CONTROL =
  /\b(?:send|pay|buy|purchase|order|checkout|check out|delete|remove|uninstall|erase|format|transfer|submit|sign out|log out|logout|install|publish|post|reply all|discard|reset|end call|leave|unsubscribe)\b/i;
const RISKY_KEYS =
  /(?:^|\s)(?:alt\+f4|ctrl\+w|ctrl\+q|ctrl\+shift\+w|shift\+delete|delete)(?:\s|$)/i;

const ELEMENT_MATCH_THRESHOLD = 0.7;
/** Finding a control by name looks at the whole window; read_screen shows the model fewer. */
const SEARCH_MAX = 3000;
const FIELD_ROLES = new Set(['edit', 'document', 'combobox']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The window a UI command is about: a named one, else the one the user was using. */
async function targetWindow(
  win: WindowsBridge,
  ctx: ToolContext,
  name: string | undefined,
): Promise<WindowInfo | null> {
  if (name) return findWindow(await win.listWindows(), name);
  const handle = ctx.activeWindow ?? (await win.foregroundWindow());
  return win.windowInfo(handle).catch(() => null);
}

function assertReadable(window: WindowInfo, deps: UiToolDeps): void {
  const hit = matchSensitiveApp(window, deps.sensitiveApps());
  if (hit) throw new SensitiveWindowError(hit);
}

function notFound(name: string | undefined): ToolResult {
  return {
    ok: false,
    speak: name ? `I couldn't find a window for ${name}.` : "I'm not sure which window you mean.",
    followUp: true,
  };
}

/** Best control for "the send button": name match first, actionable controls over plain text. */
export function findElement(
  elements: UiElement[],
  target: string,
  roles?: ReadonlySet<string>,
): { best: UiElement | null; candidates: string[] } {
  const scored = elements
    .filter((e) => e.name && (!roles || roles.has(e.role)))
    .map((e) => {
      let score = matchScore(target, e.name);
      if (e.role === 'text') score -= 0.05;
      if (!e.enabled) score -= 0.15;
      return { e, score };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored[0] && scored[0].score >= ELEMENT_MATCH_THRESHOLD ? scored[0].e : null;
  const candidates = [...new Set(scored.filter((s) => s.e.role !== 'text').map((s) => s.e.name))];
  return { best, candidates: candidates.slice(0, 20) };
}

/** Finds words on screen (OCR) and returns the middle of them. */
export function findText(
  lines: OcrLine[],
  target: string,
): { x: number; y: number; text: string } | null {
  const wanted = normalizeName(target).split(' ').filter(Boolean);
  if (wanted.length === 0) return null;
  for (const line of lines) {
    const words = line.words.map((w) => normalizeName(w.text));
    for (let i = 0; i + wanted.length <= words.length; i++) {
      if (wanted.every((w, k) => words[i + k] === w)) {
        const hit = line.words.slice(i, i + wanted.length);
        const left = Math.min(...hit.map((w) => w.x));
        const right = Math.max(...hit.map((w) => w.x + w.w));
        const top = Math.min(...hit.map((w) => w.y));
        const bottom = Math.max(...hit.map((w) => w.y + w.h));
        return {
          x: (left + right) / 2,
          y: (top + bottom) / 2,
          text: hit.map((w) => w.text).join(' '),
        };
      }
    }
  }
  return null;
}

/** One line per control for the LLM: `#12 button "Send"`. Field contents are scrubbed later. */
export function describeElement(e: UiElement): string {
  let line = `#${e.id} ${e.role} "${e.name}"`;
  if (e.password) line += ' (password field, contents hidden)';
  else if (e.value) line += ` = "${e.value}"`;
  if (!e.enabled) line += ' (disabled)';
  if (e.focused) line += ' (focused)';
  return line;
}

/** Wraps a tool body so a sensitive window gets a plain refusal instead of an error. */
async function guarded(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    const result = await run();
    // Anything these tools return as data was read off the screen.
    return result.data === undefined ? result : { ...result, fromScreen: true };
  } catch (err) {
    if (err instanceof SensitiveWindowError) return { ok: false, speak: err.message };
    if (err instanceof StaleElementError) return { ok: false, speak: err.message, followUp: true };
    throw err;
  }
}

async function bringToFront(win: WindowsBridge, window: WindowInfo): Promise<void> {
  const front = await win.foregroundWindow().catch(() => null);
  if (front === window.handle) return;
  await win.windowAction(window.handle, 'focus');
  await sleep(200);
}

export function uiTools(deps: UiToolDeps) {
  const { win } = deps;
  /** Names of the controls in the last read_screen, so clicks by id can be checked for risk. */
  let lastSnapshot: { handle: number; elements: Map<number, UiElement> } | null = null;

  const confirmRisky = async (ctx: ToolContext, name: string, window: WindowInfo) =>
    !RISKY_CONTROL.test(name) || ctx.confirm(`Click “${name}” in ${label(window)}`);

  return [
    defineTool({
      name: 'read_screen',
      description:
        'List the buttons, fields, links and text visible in a window, each with an #id you can pass to click. Use when you need to see what is on screen before acting.',
      risk: 'safe',
      input: z.object({
        window: z
          .string()
          .min(1)
          .optional()
          .describe('App or window name; omit for the active one'),
      }),
      describe: ({ window }) => `Look at ${window ?? 'the active window'}`,
      run: (args, ctx) =>
        guarded(async () => {
          const window = await targetWindow(win, ctx, args.window);
          if (!window) return notFound(args.window);
          assertReadable(window, deps);
          const snap = await win.uiSnapshot(window.handle);
          const controls = snap.elements.filter((e) => e.role !== 'text');
          if (controls.length >= 3) {
            lastSnapshot = {
              handle: window.handle,
              elements: new Map(snap.elements.map((e) => [e.id, e])),
            };
            return {
              ok: true,
              speak: `I looked at ${label(window)}.`,
              data: {
                window: { app: snap.window.process, title: snap.window.title },
                source: 'ui-automation',
                elements: snap.elements.map(describeElement),
                truncated: snap.truncated,
              },
              followUp: true,
            };
          }
          // Games and canvas apps expose no controls: read the text off the screen instead.
          await bringToFront(win, window);
          const lines = await win.ocrWindow(window.handle);
          lastSnapshot = null;
          return {
            ok: true,
            speak: `I read the text in ${label(window)}.`,
            data: {
              window: { app: window.process, title: window.title },
              source: 'ocr',
              note: 'No #ids: click by the visible text instead.',
              text: lines.slice(0, 80).map((l) => l.text),
            },
            followUp: true,
          };
        }),
    }),
    defineTool({
      name: 'click',
      description:
        'Click a button, link, tab, menu item or checkbox by its visible name (e.g. target "Send", window "Discord"), or by #id from read_screen. Falls back to finding the text on screen.',
      risk: 'safe',
      input: z.object({
        target: z.string().min(1).max(100).optional().describe('Visible name of the control'),
        element: z.number().int().positive().optional().describe('#id from read_screen'),
        window: z
          .string()
          .min(1)
          .optional()
          .describe('App or window name; omit for the active one'),
      }),
      describe: ({ target, element, window }) =>
        `Click ${target ? `“${target}”` : `#${element}`}${window ? ` in ${window}` : ''}`,
      run: (args, ctx) =>
        guarded(async () => {
          if (!args.target && !args.element)
            return { ok: false, speak: 'What should I click?', followUp: true };
          const window = await targetWindow(win, ctx, args.window);
          if (!window) return notFound(args.window);
          assertReadable(window, deps);

          const known =
            args.element && lastSnapshot?.handle === window.handle
              ? lastSnapshot.elements.get(args.element)
              : undefined;
          if (known) {
            if (!(await confirmRisky(ctx, known.name, window)))
              return { ok: false, cancelled: true, speak: "Okay, I won't click it." };
            await win.uiClick(known.id);
            return { ok: true, speak: `Clicked ${known.name || 'it'}.` };
          }
          if (!args.target)
            return {
              ok: false,
              speak: 'I need to look at the window again first.',
              followUp: true,
            };

          const snap = await win.uiSnapshot(window.handle, SEARCH_MAX);
          const { best, candidates } = findElement(snap.elements, args.target);
          if (best) {
            if (!(await confirmRisky(ctx, best.name, window)))
              return { ok: false, cancelled: true, speak: "Okay, I won't click it." };
            await win.uiClick(best.id);
            return { ok: true, speak: `Clicked ${best.name}.` };
          }

          await bringToFront(win, window);
          const spot = findText(await win.ocrWindow(window.handle), args.target);
          if (spot) {
            if (!(await confirmRisky(ctx, spot.text, window)))
              return { ok: false, cancelled: true, speak: "Okay, I won't click it." };
            await win.clickAt(spot.x, spot.y);
            return { ok: true, speak: `Clicked ${spot.text}.` };
          }
          return {
            ok: false,
            speak: `I couldn't find “${args.target}” in ${label(window)}.`,
            data: { visibleControls: candidates },
            followUp: true,
          };
        }),
    }),
    defineTool({
      name: 'type_text',
      description:
        'Type text into a window, optionally into a named field first (e.g. field "Message"). Set submit to press Enter afterwards (sends messages, so the user is asked first).',
      risk: 'safe',
      input: z.object({
        text: z.string().min(1).max(2000),
        field: z.string().min(1).max(100).optional().describe('Name of the text box to type into'),
        window: z
          .string()
          .min(1)
          .optional()
          .describe('App or window name; omit for the active one'),
        submit: z.boolean().optional().describe('Press Enter after typing'),
      }),
      describe: ({ text, field, window, submit }) =>
        `${submit ? 'Type and send' : 'Type'} “${text}”${field ? ` into ${field}` : ''}${window ? ` in ${window}` : ''}`,
      run: (args, ctx) =>
        guarded(async () => {
          const window = await targetWindow(win, ctx, args.window);
          if (!window) return notFound(args.window);
          if (args.submit) {
            const preview = args.text.length > 60 ? `${args.text.slice(0, 60)}…` : args.text;
            if (!(await ctx.confirm(`Send “${preview}” in ${label(window)}`)))
              return { ok: false, cancelled: true, speak: "Okay, I won't send it." };
          }
          await bringToFront(win, window);
          if (args.field) {
            assertReadable(window, deps);
            const snap = await win.uiSnapshot(window.handle, SEARCH_MAX);
            const { best, candidates } = findElement(snap.elements, args.field, FIELD_ROLES);
            if (!best)
              return {
                ok: false,
                speak: `I couldn't find a “${args.field}” box in ${label(window)}.`,
                data: { fields: candidates },
                followUp: true,
              };
            await win.uiFocus(best.id);
          }
          await win.typeText(args.text);
          if (args.submit) await win.sendKeys('enter');
          return { ok: true, speak: args.submit ? 'Sent.' : 'Typed it.' };
        }),
    }),
    defineTool({
      name: 'press_keys',
      description:
        'Press a key or shortcut in a window, e.g. "enter", "ctrl+t", "ctrl+shift+n", or several separated by spaces.',
      risk: 'safe',
      input: z.object({
        keys: z.string().regex(/^[a-z0-9+ ]{1,80}$/i, 'Use key names like ctrl+t or enter'),
        window: z
          .string()
          .min(1)
          .optional()
          .describe('App or window name; omit for the active one'),
      }),
      describe: ({ keys, window }) => `Press ${keys}${window ? ` in ${window}` : ''}`,
      run: (args, ctx) =>
        guarded(async () => {
          const window = await targetWindow(win, ctx, args.window);
          if (!window) return notFound(args.window);
          const keys = args.keys.toLowerCase().replace(/control/g, 'ctrl');
          if (RISKY_KEYS.test(keys) && !(await ctx.confirm(`Press ${keys} in ${label(window)}`)))
            return { ok: false, cancelled: true, speak: "Okay, I won't." };
          await bringToFront(win, window);
          await win.sendKeys(keys);
          return { ok: true, speak: 'Done.' };
        }),
    }),
    defineTool({
      name: 'scroll',
      description: 'Scroll a window up or down.',
      risk: 'safe',
      input: z.object({
        direction: z.enum(['up', 'down']),
        amount: z.number().int().min(1).max(20).optional().describe('Steps; default 5'),
        window: z
          .string()
          .min(1)
          .optional()
          .describe('App or window name; omit for the active one'),
      }),
      describe: ({ direction, window }) => `Scroll ${direction}${window ? ` in ${window}` : ''}`,
      run: (args, ctx) =>
        guarded(async () => {
          const window = await targetWindow(win, ctx, args.window);
          if (!window) return notFound(args.window);
          await win.uiScroll(window.handle, args.direction, args.amount ?? 5);
          return { ok: true, speak: `Scrolled ${args.direction}.` };
        }),
    }),
  ];
}
