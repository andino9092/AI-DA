import type { HotkeyBinding } from '../native/win-host';

const NAMED_KEYS: Record<string, number> = {
  space: 0x20,
  backspace: 0x08,
  tab: 0x09,
  enter: 0x0d,
  return: 0x0d,
  escape: 0x1b,
  esc: 0x1b,
  delete: 0x2e,
  insert: 0x2d,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  plus: 0xbb,
  '=': 0xbb,
  '-': 0xbd,
  ',': 0xbc,
  '.': 0xbe,
  '/': 0xbf,
  ';': 0xba,
  "'": 0xde,
  '[': 0xdb,
  ']': 0xdd,
  '\\': 0xdc,
  '`': 0xc0,
};

/**
 * Turns an Electron accelerator ("Control+Alt+V") into a key binding for the Windows helper's
 * keyboard hook, which (unlike Electron's global shortcuts) also reports when the key is let go.
 * Returns null for keys it can't map, so the caller falls back to a normal shortcut.
 */
export function acceleratorToBinding(name: string, accelerator: string): HotkeyBinding | null {
  const binding: HotkeyBinding = { name, vk: 0, ctrl: false, alt: false, shift: false, win: false };
  for (const raw of accelerator.split('+')) {
    const part = raw.trim().toLowerCase();
    if (['control', 'ctrl', 'commandorcontrol', 'cmdorctrl'].includes(part)) binding.ctrl = true;
    else if (['alt', 'option', 'altgr'].includes(part)) binding.alt = true;
    else if (part === 'shift') binding.shift = true;
    else if (['super', 'meta', 'win', 'windows'].includes(part)) binding.win = true;
    else if (binding.vk !== 0) return null;
    else if (/^[a-z0-9]$/.test(part)) binding.vk = part.toUpperCase().charCodeAt(0);
    else if (/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(part)) binding.vk = 0x6f + Number(part.slice(1));
    else if (NAMED_KEYS[part] !== undefined) binding.vk = NAMED_KEYS[part];
    else return null;
  }
  return binding.vk ? binding : null;
}
