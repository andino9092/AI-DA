import { normalizeUrl } from '../tools/apps/tools';

export interface PlannedCall {
  name: string;
  args: Record<string, unknown>;
}

const DEFAULT_STEP = 10;

/** Words that mean "the window I was just using". */
const THIS_WINDOW =
  /^(?:it|this|that|this window|that window|the window|current window|the current window|this app)$/;

/** "open a new tab", "open my resume" etc. need real understanding, not a Start-menu lookup. */
const NOT_AN_APP =
  /\b(?:tab|file|folder|document|page|email|mail from|message|link|website for|new)\b/;

const DOMAIN =
  /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|app|ai|co|edu|gov|tv|me|gg|us|uk|ca)(?:\/\S*)?$/;

function clean(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/^(?:hey |ok |okay )?(?:aida|ada)[,!.]?\s+/, '')
    .replace(/^(?:please |can you |could you |would you |will you )+/, '')
    .replace(/\s+please$/, '')
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function num(value: string | undefined, fallback = DEFAULT_STEP): number {
  const n = value ? Number(value) : fallback;
  return Math.max(0, Math.min(100, n));
}

function target(raw: string): string | undefined {
  const t = raw
    .replace(/^(?:the |my )/, '')
    .replace(/ (?:window|app)$/, '')
    .trim();
  return THIS_WINDOW.test(raw.trim()) || THIS_WINDOW.test(t) ? undefined : t;
}

function parseClause(clause: string): PlannedCall | null {
  let m: RegExpMatchArray | null;

  // Volume
  if (
    (m = clause.match(
      /^(?:set |change |put |turn )?(?:the )?(?:volume|sound)(?: level)? (?:to |at )?(\d{1,3})(?: ?%| percent)?$/,
    ))
  )
    return { name: 'set_volume', args: { level: num(m[1]) } };
  if (
    (m = clause.match(
      /^(?:turn |put )?(?:the )?(?:volume|sound|it) (up|down)(?: by (\d{1,3})(?: ?%| percent)?)?$/,
    ))
  )
    return { name: 'change_volume', args: { delta: (m[1] === 'up' ? 1 : -1) * num(m[2]) } };
  if (
    (m = clause.match(
      /^turn (up|down) (?:the )?(?:volume|sound)(?: by (\d{1,3})(?: ?%| percent)?)?$/,
    ))
  )
    return { name: 'change_volume', args: { delta: (m[1] === 'up' ? 1 : -1) * num(m[2]) } };
  if ((m = clause.match(/^(?:make it |a (?:bit|little) )?(louder|quieter|softer)$/)))
    return {
      name: 'change_volume',
      args: { delta: m[1] === 'louder' ? DEFAULT_STEP : -DEFAULT_STEP },
    };
  if (/^mute(?: (?:the )?(?:sound|volume|audio|computer|pc))?$/.test(clause))
    return { name: 'set_mute', args: { muted: true } };
  if (/^unmute(?: (?:the )?(?:sound|volume|audio|computer|pc))?$/.test(clause))
    return { name: 'set_mute', args: { muted: false } };
  if (
    /^(?:what(?:'s| is) the volume(?: at)?|(?:current )?volume level|how loud is it)$/.test(clause)
  )
    return { name: 'get_volume', args: {} };

  // Media
  if (
    /^(?:play|pause|resume|stop)(?: (?:the )?(?:music|song|track|video|playback|media))?$/.test(
      clause,
    )
  )
    return { name: 'media_control', args: { action: 'play_pause' } };
  if (
    /^(?:(?:play )?(?:the )?next(?: (?:song|track|video|one))?|skip(?: (?:this|the))?(?: (?:song|track|video|one))?)$/.test(
      clause,
    )
  )
    return { name: 'media_control', args: { action: 'next' } };
  if (
    /^(?:(?:play )?(?:the )?(?:previous|last)(?: (?:song|track|video|one))?|go back a (?:song|track))$/.test(
      clause,
    )
  )
    return { name: 'media_control', args: { action: 'previous' } };

  // Time
  if (/^(?:what time is it|what(?:'s| is) the time|time)$/.test(clause))
    return { name: 'get_time', args: {} };

  // Windows
  if ((m = clause.match(/^snap (.+?) (?:to )?(?:the )?(left|right)(?: side)?$/))) {
    return { name: 'window_action', args: { action: `snap_${m[2]}`, target: target(m[1]!) } };
  }
  if ((m = clause.match(/^snap (?:to )?(?:the )?(left|right)(?: side)?$/)))
    return { name: 'window_action', args: { action: `snap_${m[1]}` } };
  if (
    (m = clause.match(
      /^move (.+?) to (?:the |my )?(?:other|next|second) (?:monitor|screen|display)$/,
    ))
  )
    return { name: 'window_action', args: { action: 'next_monitor', target: target(m[1]!) } };
  if (
    (m = clause.match(
      /^(minimi[sz]e|maximi[sz]e|restore|focus|switch to|go to|bring up)(?: (.+))?$/,
    ))
  ) {
    const verb = m[1]!;
    const action = verb.startsWith('minimi')
      ? 'minimize'
      : verb.startsWith('maximi')
        ? 'maximize'
        : verb === 'restore'
          ? 'restore'
          : 'focus';
    const t = m[2] ? target(m[2]) : undefined;
    if (action === 'focus' && !t) return null;
    return { name: 'window_action', args: t ? { action, target: t } : { action } };
  }

  // Apps and websites
  if ((m = clause.match(/^(?:close|quit|exit) (.+)$/))) {
    const t = target(m[1]!);
    return t && !NOT_AN_APP.test(t) ? { name: 'close_app', args: { name: t } } : null;
  }
  if ((m = clause.match(/^(?:open|launch|start|run|go to) (?:up )?(.+)$/))) {
    const what = m[1]!.replace(/^the /, '').trim();
    if (DOMAIN.test(what) && normalizeUrl(what)) return { name: 'open_url', args: { url: what } };
    if (/^(?:a|an|my|some) /.test(what) || NOT_AN_APP.test(what)) return null;
    // "open spotify and play my liked songs": the rest is a request, not part of the name.
    if (
      /\b(?:and|then)\s+(?:play|set|turn|open|close|search|find|go|type|send|make|put|show|start)\b/.test(
        what,
      )
    ) {
      return null;
    }
    return { name: 'open_app', args: { name: what } };
  }

  return null;
}

/**
 * Turns common commands into tool calls without any LLM, so they run instantly, cost nothing
 * and never leave the PC. Returns null when unsure; the agent then asks the LLM.
 * Compound commands ("open spotify and set volume to 30") are handled only if every part parses.
 */
export function parseInstant(text: string): PlannedCall[] | null {
  const cleaned = clean(text);
  if (!cleaned) return null;

  const parts = cleaned
    .split(/\s*,\s*(?:and |then )?|\s+and then\s+|\s+then\s+|\s+and\s+/)
    .filter(Boolean);
  if (parts.length > 1) {
    const calls = parts.map(parseClause);
    if (calls.every((c): c is PlannedCall => c !== null)) return calls;
  }
  const single = parseClause(cleaned);
  return single ? [single] : null;
}
