import { normalizeUrl } from '../tools/apps/tools';

export interface PlannedCall {
  name: string;
  args: Record<string, unknown>;
}

const DEFAULT_STEP = 10;

/** Key names the Windows helper understands (see native/aida-win/Input.cs). */
const KEY_NAMES =
  /^(?:ctrl|alt|shift|win|[a-z0-9]|f(?:[1-9]|1[0-9]|2[0-4])|enter|tab|esc|escape|space|backspace|delete|insert|home|end|pageup|pagedown|up|down|left|right)$/;
const KEY_ALIASES: Record<string, string> = {
  control: 'ctrl',
  return: 'enter',
  windows: 'win',
  del: 'delete',
};

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

  // Per-app volume: "set spotify volume to 30", "discord volume 20", "mute chrome".
  if (
    (m = clause.match(
      /^(?:set |turn |put )?(?:the )?(.+?)(?:'s)? volume (?:to |at )?(\d{1,3})(?: ?%| percent)?$/,
    ))
  )
    return { name: 'set_app_volume', args: { app: m[1], level: num(m[2]) } };
  if (
    (m = clause.match(/^(un)?mute (?:the )?(.+?)(?: app)?$/)) &&
    !/^(?:my )?(?:mic|microphone|yourself|you)$/.test(m[2]!)
  )
    return { name: 'set_app_volume', args: { app: m[2], muted: !m[1] } };

  // Output device: "switch to my headphones", "play sound through the speakers".
  if (
    (m = clause.match(
      /^(?:switch|change|move|set) (?:the )?(?:audio|sound|output|playback)(?: output)? (?:to|over to) (?:the |my )?(.+)$|^(?:switch|change) (?:over )?to (?:the |my )?((?:.+ )?(?:speakers?|headphones|headset|earbuds))$|^(?:play|use) (?:the )?(?:audio|sound) (?:through|on|from) (?:the |my )?(.+)$|^use (?:the |my )?((?:.+ )?(?:speakers?|headphones|headset|earbuds))$/,
    ))
  )
    return { name: 'set_output_device', args: { device: m[1] ?? m[2] ?? m[3] ?? m[4] } };

  // Media: explicit play and pause (not the toggle key), optionally for a named app.
  const media = /^(.+?)(?: (?:on|in) ([a-z0-9]+(?: [a-z0-9]+)?))?$/.exec(clause);
  const mediaVerb = media?.[1] ?? clause;
  const app = media?.[2] ? { app: media[2] } : {};
  const noun = String.raw`(?: (?:the )?(?:music|song|track|video|playback|media|podcast))?`;
  if (new RegExp(String.raw`^(?:pause|stop)${noun}$`).test(mediaVerb))
    return { name: 'media_control', args: { action: 'pause', ...app } };
  // "pause spotify" names the app; "play despacito" names a song, so play needs "on <app>".
  if (
    (m = clause.match(/^(?:pause|stop) ([a-z0-9]+)$/)) &&
    !/^(?:it|this|that|everything)$/.test(m[1]!)
  )
    return { name: 'media_control', args: { action: 'pause', app: m[1] } };
  if (new RegExp(String.raw`^(?:play|resume|unpause|continue)${noun}$`).test(mediaVerb))
    return { name: 'media_control', args: { action: 'play', ...app } };
  if (
    /^(?:(?:play )?(?:the )?next(?: (?:song|track|video|one))?|skip(?: (?:this|the))?(?: (?:song|track|video|one))?)$/.test(
      mediaVerb,
    )
  )
    return { name: 'media_control', args: { action: 'next', ...app } };
  if (
    /^(?:(?:play )?(?:the )?(?:previous|last)(?: (?:song|track|video|one))?|go back a (?:song|track))$/.test(
      mediaVerb,
    )
  )
    return { name: 'media_control', args: { action: 'previous', ...app } };
  if (
    /^(?:what(?:'s| is) (?:playing|this song|the song|on)|what song is (?:this|playing)|who(?:'s| is) (?:this|singing)|what am i listening to)$/.test(
      clause,
    )
  )
    return { name: 'now_playing', args: {} };

  // Keys: "press enter", "press control shift t", "press ctrl+w".
  if ((m = clause.match(/^(?:press|hit) (.+)$/))) {
    const keys = m[1]!
      .replace(/\bpage (up|down)\b/g, 'page$1')
      .split(/[\s+]+/)
      .map((k) => KEY_ALIASES[k] ?? k);
    if (keys.length <= 4 && keys.every((k) => KEY_NAMES.test(k)))
      return { name: 'press_keys', args: { keys: keys.join('+') } };
  }

  // Scrolling
  if (
    (m = clause.match(
      /^scroll (up|down)(?: (a (?:little )?bit|a little|a lot|more|way down|way up))?(?: (?:in|on) (.+))?$/,
    ))
  ) {
    const amount =
      m[2]?.includes('bit') || m[2] === 'a little'
        ? 2
        : m[2]?.startsWith('a lot') || m[2]?.startsWith('way')
          ? 15
          : 5;
    const window = m[3] ? target(m[3]) : undefined;
    return { name: 'scroll', args: { direction: m[1], amount, ...(window ? { window } : {}) } };
  }

  // Clicking by name: "click the send button in discord", "press play on spotify".
  if (
    (m = clause.match(
      /^(?:click|tap|hit|press|select)(?: on)? (?:the )?(.+?)(?: (?:button|link|tab|icon|option|menu item|checkbox|box))?(?: (?:in|on) (?:the )?(.+?)(?: window| app)?)?$/,
    ))
  ) {
    const window = m[2] ? target(m[2]) : undefined;
    if (!/^(?:all|everything|it|this|that|them)$/.test(m[1]!))
      return { name: 'click', args: { target: m[1], ...(window ? { window } : {}) } };
  }

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
