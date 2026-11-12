/**
 * Sends the AI only the tools a request is likely to need. Every request used to carry all ~40
 * tool definitions (~14 KB), which made it slower, used up free-tier token limits (Groq allows
 * 8,000 tokens a minute) and gave the model more ways to pick the wrong tool.
 *
 * Tools are grouped; a group is sent when the request mentions one of its words. When nothing
 * matches, everything is sent. The `more_tools` tool lets the model ask for a group it wasn't
 * given, so a wrong guess costs one extra round trip instead of a wrong answer.
 */

export interface ToolGroup {
  /** Shown to the model in more_tools, e.g. "audio: volume, mute, speakers". */
  summary: string;
  tools: readonly string[];
  words: RegExp;
}

export const TOOL_GROUPS = {
  audio: {
    summary: 'volume, mute, per-app volume, speakers and headphones',
    tools: [
      'set_volume',
      'change_volume',
      'set_mute',
      'get_volume',
      'set_app_volume',
      'set_output_device',
      'list_audio',
    ],
    words:
      /\b(?:volume|loud|louder|quiet|quieter|softer|mute|unmute|sound|audio|speakers?|headphones?|headset|earbuds?|output|hear)|\bturn (?:it |this |that |the \w+ )?(?:up|down)\b/,
  },
  media: {
    summary: 'play, pause, skip, what is playing, Spotify search/queue/like/shuffle',
    tools: [
      'media_control',
      'now_playing',
      'spotify_play',
      'spotify_queue',
      'spotify_like',
      'spotify_mode',
    ],
    words:
      /\b(?:play|playing|pause|resume|skip|next|previous|song|track|music|spotify|video|youtube|playlist|album|artist|band|queue|shuffle|repeat|loop|listen|podcast|episode|stream|watch|stop)/,
  },
  apps: {
    summary: 'open or close apps and games, find installed apps, open websites',
    tools: ['open_app', 'find_apps', 'close_app', 'open_url'],
    words:
      /\b(?:open|launch|start|run|close|quit|exit|app|apps|program|game|games|steam|website|site|url|browser|chrome|edge|firefox|zen|discord|spotify|install)|\.(?:com|org|net|io|dev)\b/,
  },
  windows: {
    summary: 'focus, minimize, maximize, snap and move windows, list windows',
    tools: ['window_action', 'list_windows'],
    words:
      /\b(?:window|windows|snap|minimi[sz]e|maximi[sz]e|restore|focus|switch|bring|monitor|screen|display|left|right|side|front)/,
  },
  screen: {
    summary: 'read what is on screen, click, type, press keys, scroll',
    tools: ['read_screen', 'click', 'type_text', 'press_keys', 'scroll'],
    words:
      /\b(?:click|tap|press|type|write|enter|button|scroll|screen|field|box|tab|menu|send|reply|message|search|select|shortcut|keys?|ctrl|control|link|page|form|checkbox|what(?:'s| is) (?:on|in)(?! (?:my |the )?(?:calendar|schedule|agenda|inbox))|read)/,
  },
  time: {
    summary: 'time and date, timers, alarms and reminders',
    tools: ['get_time', 'set_timer', 'set_alarm', 'list_timers', 'cancel_timer'],
    words:
      /\b(?:time|timer|timers|alarm|alarms|remind|reminder|minutes?|hours?|seconds?|clock|wake|o'?clock|tomorrow|tonight|morning|evening|date|day|today|[ap]\.?m\b)/,
  },
  files: {
    summary: 'open files and folders (Downloads, Documents, Desktop, recent files)',
    tools: ['open_folder', 'open_file'],
    words:
      /\b(?:files?|folders?|directory|document|documents|downloads?|desktop|pictures|photos|videos|pdf|docx?|xlsx?|spreadsheet|resume|recent)|\.\w{2,4}\b/,
  },
  info: {
    summary: 'weather and forecast, unit conversion',
    tools: ['get_weather', 'convert_units'],
    words:
      /\b(?:weather|forecast|rain|raining|snow|sunny|cloudy|temperature|degrees|hot|cold|warm|umbrella|jacket|convert|conversion|how many|how much|miles?|km|kilomet|meters?|feet|foot|inch|pounds?|lbs?|kg|kilo|grams?|ounces?|oz|cups?|liters?|litres?|gallons?|celsius|fahrenheit|mph)/,
  },
  memory: {
    summary: 'remember facts, nicknames, forget, list what is remembered',
    tools: ['remember', 'set_nickname', 'forget', 'list_memories'],
    words: /\b(?:remember|forget|nickname|call (?:it|him|her|them)|i mean|know about me|memory)/,
  },
  notifications: {
    summary: 'what did I miss, mute notifications, check Gmail, calendar events and next meeting',
    tools: ['read_notifications', 'mute_notifications', 'check_email', 'get_calendar'],
    words:
      /\b(?:notifications?|notify|miss|missed|e-?mails?|mail|inbox|gmail|unread|calendar|meetings?|events?|schedule|agenda|appointments?|standup|busy|free (?:today|tomorrow|at|on))/,
  },
  routines: {
    summary: 'create or delete routines (named lists of commands)',
    tools: ['create_routine', 'delete_routine'],
    words: /\b(?:routine|routines|mode|when i say|every time|macro)/,
  },
} as const satisfies Record<string, ToolGroup>;

export type ToolGroupName = keyof typeof TOOL_GROUPS;

const GROUP_NAMES = Object.keys(TOOL_GROUPS) as ToolGroupName[];

export const MORE_TOOLS = 'more_tools';

/** The group a tool belongs to, or null for tools outside every group (always sent). */
export function groupOf(tool: string): ToolGroupName | null {
  return (
    GROUP_NAMES.find((g) => (TOOL_GROUPS[g].tools as readonly string[]).includes(tool)) ?? null
  );
}

/**
 * Groups worth sending for these user messages (newest last) and the tools already used in the
 * conversation. Null means "send everything".
 */
export function selectGroups(
  userTexts: readonly string[],
  usedTools: readonly string[] = [],
): Set<ToolGroupName> | null {
  const picked = new Set<ToolGroupName>();
  // The newest message decides; the one before helps with follow-ups ("and make it louder").
  for (const text of userTexts.slice(-2)) {
    const t = text.toLowerCase();
    for (const g of GROUP_NAMES) if (TOOL_GROUPS[g].words.test(t)) picked.add(g);
  }
  for (const tool of usedTools) {
    const g = groupOf(tool);
    if (g) picked.add(g);
  }
  return picked.size > 0 ? picked : null;
}

/** Whether a tool is sent with this selection. */
export function isSelected(tool: string, groups: ReadonlySet<ToolGroupName> | null): boolean {
  if (!groups) return true;
  const g = groupOf(tool);
  return g === null || groups.has(g);
}

/** The tool the model calls to get a group it wasn't given. */
export function moreToolsSpec(missing: readonly ToolGroupName[]) {
  return {
    name: MORE_TOOLS,
    description: `Get more tools when none of yours fit. Groups: ${missing
      .map((g) => `${g} (${TOOL_GROUPS[g].summary})`)
      .join('; ')}.`,
    parameters: {
      type: 'object',
      properties: {
        groups: { type: 'array', items: { type: 'string', enum: [...missing] } },
      },
      required: ['groups'],
    },
  };
}

/** The group names in a more_tools call that exist. */
export function requestedGroups(args: Record<string, unknown>): ToolGroupName[] {
  const raw = Array.isArray(args['groups']) ? args['groups'] : [args['groups']];
  return raw.filter((g): g is ToolGroupName => GROUP_NAMES.includes(g as ToolGroupName));
}

export { GROUP_NAMES };
