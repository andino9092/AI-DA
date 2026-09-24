import { parseClockTime, parseDuration } from '../tools/info/timers';
import { findUnit } from '../tools/info/units';
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
  /\b(?:tab|file|folder|document|page|email|mail from|message|link|website for|new|video|song|music|movie|playlist|podcast|episode|stream)\b/;

/** Filler that speech recognition leaves behind ("can you open and..."): never an app name. */
const FILLER = /^(?:and|or|so|to|up|it|this|that|then|um|uh|something|anything|please|the|a|an)$/;

const DOMAIN =
  /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|app|ai|co|edu|gov|tv|me|gg|us|uk|ca)(?:\/\S*)?$/;

function clean(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/^(?:hey |ok |okay )?(?:aida|ada)[,!.]?\s+/, '')
      .replace(/^(?:please |can you |could you |would you |will you )+/, '')
      // Speech recognition sometimes drops "can" from "can you set a timer…".
      .replace(
        /^you (?=(?:set|open|close|play|pause|skip|start|stop|turn|mute|unmute|switch|move|snap|click|press|scroll|remind|cancel|show)\b)/,
        '',
      )
      .replace(/\s+please$/, '')
      .replace(/[.!?]+$/, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
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

const WHEN =
  /^(?:right now|now|today|tonight|this (?:morning|afternoon|evening|week|weekend)|the (?:week|weekend)|tomorrow(?: (?:morning|afternoon|evening|night))?|(?:on |this |next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))$/;

/** "tomorrow in paris", "in paris", "for saturday", "" → when/place, or null if it's something else. */
function weatherRest(rest: string | undefined): { when?: string; place?: string } | null {
  let r = (rest ?? '').replace(/^(?:outside|out) ?/, '').trim();
  if (!r) return {};
  let when: string | undefined;
  // The time can come first or last: "tomorrow in paris", "in paris tomorrow".
  const first = /^(.+?) (?=in |at |for )/.exec(r);
  if (first && WHEN.test(first[1]!)) {
    when = first[1];
    r = r.slice(first[0].length);
  } else {
    const last =
      / ((?:on |this |next )?\S+(?: (?:morning|afternoon|evening|night|week|weekend))?)$/.exec(r);
    if (last && WHEN.test(last[1]!)) {
      when = last[1];
      r = r.slice(0, last.index);
    }
  }
  r = r.replace(/^(?:for|on)(?: |$)/, '').trim();
  if (!r) return { when };
  if (WHEN.test(r)) return when ? null : { when: r };
  const place = /^(?:in|at) (.+)$/.exec(r);
  return place ? { ...(when ? { when } : {}), place: place[1]! } : null;
}

function parseWeather(clause: string): PlannedCall | null {
  const m =
    /^(?:(?:what(?:'s| is| will be)|how(?:'s| is)|check|get|tell me) )?(?:the )?(?:weather|forecast|temperature)(?: (?:going to be|gonna be|be))?(?: like)?(?: (.+))?$/.exec(
      clause,
    ) ??
    /^(?:is it|will it|is it going to|is it gonna) (?:rain|snow)(?:ing)?(?: (.+))?$/.exec(clause) ??
    /^do i need (?:an umbrella|a jacket|a coat)(?: (.+))?$/.exec(clause) ??
    /^how (?:hot|cold|warm) is it(?: (.+))?$/.exec(clause);
  if (!m) return null;
  const rest = weatherRest(m[1]);
  return rest ? { name: 'get_weather', args: rest } : null;
}

const AMOUNT = String.raw`(\d+(?:\.\d+)?|an?|one|half an?)`;

function amount(word: string | undefined): number {
  if (!word || /^(?:an?|one)$/.test(word)) return 1;
  if (word.startsWith('half')) return 0.5;
  return Number(word);
}

/** "convert 5 miles to km", "70 fahrenheit in celsius", "how many cups in a liter". */
function parseConversion(clause: string): PlannedCall | null {
  let m = new RegExp(
    String.raw`^(?:convert |what(?:'s| is) |how much is |how many \S+ (?:is|are) )?${AMOUNT} (.+?) (?:to|in|into|in to|as) (.+)$`,
  ).exec(clause);
  if (m && findUnit(m[2]!) && findUnit(m[3]!))
    return { name: 'convert_units', args: { value: amount(m[1]), from: m[2], to: m[3] } };
  m = new RegExp(
    String.raw`^how many (.+?) (?:are |is )?(?:in|are in|is in|make|makes|is|are) (?:${AMOUNT} )?(.+)$`,
  ).exec(clause);
  if (m && findUnit(m[1]!) && findUnit(m[3]!))
    return { name: 'convert_units', args: { value: amount(m[2]), from: m[3], to: m[1] } };
  return null;
}

/** "play the next song on spotify" is a media key, not a search. */
const NOT_A_SONG =
  /^(?:the |some |my |this )?(?:next |previous |last )?(?:music|songs?|tracks?|it|this|that|something|anything|video|media|playback|one)$/;

/** Spotify: search-and-play, queue, like, shuffle and repeat. */
function parseSpotify(clause: string): PlannedCall | null {
  let m: RegExpExecArray | null;
  if (
    /^(?:play|put on|shuffle) (?:me )?(?:my )?(?:liked|saved|favou?rite) (?:songs|tracks|music)(?: on spotify)?$/.test(
      clause,
    )
  )
    return { name: 'spotify_play', args: { query: 'liked songs', type: 'liked' } };
  if (
    (m = /^(?:play|put on) (?:my |the )?(.+?) playlist(?: on spotify)?$/.exec(clause)) &&
    !/youtube/.test(m[1]!)
  )
    return { name: 'spotify_play', args: { query: m[1], type: 'playlist' } };
  if (
    (m = /^play (?:the )?album (.+?)(?: on spotify)?$/.exec(clause)) ??
    (m = /^play (?:the )?(.+?) album(?: on spotify)?$/.exec(clause))
  )
    return { name: 'spotify_play', args: { query: m[1], type: 'album' } };
  if (
    (m = /^play (?:some )?(?:songs|music|something) (?:by|from) (.+?)(?: on spotify)?$/.exec(
      clause,
    ))
  )
    return { name: 'spotify_play', args: { query: m[1], type: 'artist' } };
  if ((m = /^play (.+) on spotify$/.exec(clause)) && !NOT_A_SONG.test(m[1]!))
    return { name: 'spotify_play', args: { query: m[1] } };

  if (
    (m = /^queue(?: up)? (.+?)(?: on spotify)?$/.exec(clause)) ??
    (m = /^add (.+?) to (?:the |my )?(?:spotify )?queue$/.exec(clause))
  )
    return NOT_A_SONG.test(m[1]!) ? null : { name: 'spotify_queue', args: { query: m[1] } };
  if (
    /^(?:like|save|heart) (?:this|the current|the) (?:song|track)(?: on spotify)?$|^add (?:this|the current) (?:song|track) to (?:my )?(?:liked songs|library|favou?rites)$/.test(
      clause,
    )
  )
    return { name: 'spotify_like', args: {} };

  if ((m = /^(?:turn |switch )?shuffle (on|off)$|^turn (on|off) shuffle$/.exec(clause)))
    return { name: 'spotify_mode', args: { shuffle: (m[1] ?? m[2]) === 'on' } };
  if (/^(?:stop|don't) shuffl(?:e|ing)$/.test(clause))
    return { name: 'spotify_mode', args: { shuffle: false } };
  if (/^(?:repeat|loop) (?:this|the) (?:song|track)$/.test(clause))
    return { name: 'spotify_mode', args: { repeat: 'song' } };
  if ((m = /^(?:turn )?(?:repeat|loop) (on|off)$|^turn (on|off) (?:repeat|loop)$/.exec(clause)))
    return { name: 'spotify_mode', args: { repeat: (m[1] ?? m[2]) === 'on' ? 'all' : 'off' } };
  if (/^stop (?:repeating|looping)$/.test(clause))
    return { name: 'spotify_mode', args: { repeat: 'off' } };
  return null;
}

/** "remember that I take my coffee black", "when I say my editor, I mean VS Code". */
function parseMemory(clause: string): PlannedCall | null {
  let m: RegExpExecArray | null;
  if (
    (m = /^remember that (.+)$/.exec(clause)) ??
    (m = /^remember ((?:my|i|i'm|i am|we|our) .+)$/.exec(clause))
  )
    return { name: 'remember', args: { fact: m[1] } };
  if ((m = /^when i say (.+?),? i mean (.+)$/.exec(clause)))
    return { name: 'set_nickname', args: { nickname: m[1], means: m[2] } };
  if (
    (m = /^forget (?:that |about |what i said about )?(.+)$/.exec(clause)) &&
    !/^(?:it|that|this|everything|all of it|all that)$/.test(m[1]!)
  )
    return { name: 'forget', args: { what: m[1] } };
  if (
    /^what do you (?:remember|know)(?: about me)?$|^what have i (?:asked|told) you to remember$/.test(
      clause,
    )
  )
    return { name: 'list_memories', args: {} };
  return null;
}

/** "wake me up at 7", "set an alarm for 6:30 am", "remind me at 5 pm to call mom". */
function parseAlarm(clause: string): PlannedCall | null {
  const isTime = (t: string) => parseClockTime(t, new Date()) !== null;
  let m: RegExpExecArray | null;
  if (
    (m = /^(?:set |make )?(?:an |my |the )?alarm (?:for |at )?(.+)$/.exec(clause)) &&
    isTime(m[1]!)
  )
    return { name: 'set_alarm', args: { time: m[1] } };
  if ((m = /^wake me(?: up)? (?:at |by )?(.+)$/.exec(clause)) && isTime(m[1]!))
    return { name: 'set_alarm', args: { time: m[1] } };
  if ((m = /^remind me ((?:tomorrow )?(?:at )?.+?) to (.+)$/.exec(clause)) && isTime(m[1]!))
    return { name: 'set_alarm', args: { time: m[1], label: m[2] } };
  if ((m = /^remind me to (.+) ((?:tomorrow )?at .+|tomorrow)$/.exec(clause)) && isTime(m[2]!))
    return { name: 'set_alarm', args: { time: m[2], label: m[1] } };
  return null;
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

  // Timers and reminders (before media, so "stop the timer" isn't "pause the music").
  if (
    /^(?:cancel|stop|delete|clear|turn off) (?:the |my |all )?(?:(?:my )?timers?|reminders?|alarms?)$/.test(
      clause,
    )
  )
    return { name: 'cancel_timer', args: {} };
  if (
    /^(?:how (?:much time is|long is|long's) left(?: on (?:the|my) timer)?|how long (?:until|till|left on) (?:the |my )?timer|check (?:the |my )?timers?|what timers do i have)$/.test(
      clause,
    )
  )
    return { name: 'list_timers', args: {} };
  if ((m = clause.match(/^remind me in (.+?) to (.+)$/)) && parseDuration(m[1]!))
    return { name: 'set_timer', args: { duration: m[1], label: m[2] } };
  if ((m = clause.match(/^remind me to (.+) in (.+)$/)) && parseDuration(m[2]!))
    return { name: 'set_timer', args: { duration: m[2], label: m[1] } };
  if (
    ((m = clause.match(/^(?:set |start )?(?:a |an )?(?:timer|alarm)(?: for| of)? (.+)$/)) ||
      (m = clause.match(/^(?:set |start )?(?:a |an )?(.+?) timer$/))) &&
    parseDuration(m[1]!)
  )
    return { name: 'set_timer', args: { duration: m[1] } };
  const alarm = parseAlarm(clause);
  if (alarm) return alarm;

  // Weather, unit conversion and Spotify (before media: "stop shuffling" isn't "pause").
  const info =
    parseWeather(clause) ?? parseConversion(clause) ?? parseMemory(clause) ?? parseSpotify(clause);
  if (info) return info;

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
  // Folders and files: "open my downloads", "open the taxes folder", "open budget.xlsx".
  if (
    (m = clause.match(
      /^(?:open|show(?: me)?|go to) (?:up )?((?:the |my )?(?!(?:a|an|new)\b).+? (?:folder|directory))$/,
    )) ||
    (m = clause.match(
      /^(?:open|show(?: me)?|go to) (?:up )?((?:the |my )(?:downloads|documents|desktop|pictures|photos|music|videos))$/,
    )) ||
    (m = clause.match(/^(?:open|show(?: me)?|go to) (?:up )?(downloads|documents|desktop)$/))
  )
    return { name: 'open_folder', args: { name: m[1] } };
  if (
    (m = clause.match(/^open (?:the |my )?file (?:called |named )?(.+)$/)) ||
    (m = clause.match(
      /^open (?:the |my )?(.+\.(?:pdf|docx?|xlsx?|pptx?|txt|csv|md|png|jpe?g|gif|mp4|mp3|zip))$/,
    ))
  )
    return { name: 'open_file', args: { name: m[1] } };

  // "start the video", "play the youtube video on zen": media, not an app called "video".
  if (
    (m = clause.match(
      /^(?:start|play|resume|unpause|continue) (?:the |my |this )?(youtube )?(?:video|movie|episode|stream|show|clip)(?: (?:on|in) (?:the |my )?(.+?))?$/,
    ))
  ) {
    const app = m[2] ?? (m[1] ? 'youtube' : undefined);
    return { name: 'media_control', args: { action: 'play', ...(app ? { app } : {}) } };
  }

  if ((m = clause.match(/^(?:open|launch|start|run|go to) (?:up )?(.+)$/))) {
    const what = m[1]!.replace(/^the /, '').trim();
    if (DOMAIN.test(what) && normalizeUrl(what)) return { name: 'open_url', args: { url: what } };
    if (/^(?:a|an|my|some) /.test(what) || NOT_AN_APP.test(what) || FILLER.test(what)) return null;
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
