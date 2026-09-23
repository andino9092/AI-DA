import { describe, expect, it } from 'vitest';
import { displayAccelerator, toAccelerator } from '../../src/renderer/settings/shortcut';

const press = (
  key: string,
  code: string,
  mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {},
) =>
  toAccelerator({
    key,
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  });

describe('toAccelerator', () => {
  it('builds Electron accelerators from key presses', () => {
    expect(press('v', 'KeyV', { ctrlKey: true, altKey: true })).toBe('Control+Alt+V');
    expect(press(' ', 'Space', { ctrlKey: true, shiftKey: true })).toBe('Control+Shift+Space');
    expect(press('1', 'Digit1', { altKey: true })).toBe('Alt+1');
    expect(press('F9', 'F9')).toBe('F9');
    expect(press('ArrowUp', 'ArrowUp', { metaKey: true, altKey: true })).toBe('Alt+Super+Up');
  });

  it('uses the physical key, so Alt combinations on other layouts still work', () => {
    expect(press('å', 'KeyA', { altKey: true })).toBe('Alt+A');
  });

  it('rejects shortcuts that would hijack normal typing', () => {
    expect(press('a', 'KeyA')).toBeNull();
    expect(press('A', 'KeyA', { shiftKey: true })).toBeNull();
    expect(press('Control', 'ControlLeft', { ctrlKey: true })).toBeNull();
    expect(press('Enter', 'Enter', { ctrlKey: true })).toBeNull();
  });

  it('displays accelerators the Windows way', () => {
    expect(displayAccelerator('Control+Alt+V')).toBe('Ctrl+Alt+V');
    expect(displayAccelerator('Super+Shift+S')).toBe('Win+Shift+S');
  });
});
