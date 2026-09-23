import { describe, expect, it } from 'vitest';
import { acceleratorToBinding } from '../../../src/main/app/hotkeys';
import { matchSensitiveApp } from '../../../src/main/privacy/sensitive-apps';

describe('acceleratorToBinding', () => {
  it('maps Electron accelerators to virtual keys', () => {
    expect(acceleratorToBinding('ptt', 'Control+Alt+V')).toEqual({
      name: 'ptt',
      vk: 0x56,
      ctrl: true,
      alt: true,
      shift: false,
      win: false,
    });
    expect(acceleratorToBinding('ptt', 'CommandOrControl+Shift+F9')?.vk).toBe(0x78);
    expect(acceleratorToBinding('ptt', 'Alt+Space')?.vk).toBe(0x20);
    expect(acceleratorToBinding('ptt', 'Super+/')?.win).toBe(true);
  });

  it('gives up on keys it cannot map, so a normal shortcut is used', () => {
    expect(acceleratorToBinding('ptt', 'Control+MediaPlayPause')).toBeNull();
    expect(acceleratorToBinding('ptt', 'Control+Alt')).toBeNull();
    expect(acceleratorToBinding('ptt', 'A+B')).toBeNull();
  });
});

describe('matchSensitiveApp', () => {
  const list = ['1Password', 'bank', 'Proton Pass'];

  it('matches app names and whole title words', () => {
    expect(matchSensitiveApp({ process: '1Password', title: 'Vault' }, list)).toBe('1Password');
    expect(matchSensitiveApp({ process: 'chrome', title: 'Chase Bank - Chrome' }, list)).toBe(
      'bank',
    );
    expect(matchSensitiveApp({ process: 'ProtonPass', title: 'Proton Pass' }, list)).toBe(
      'Proton Pass',
    );
  });

  it('does not match parts of words', () => {
    expect(matchSensitiveApp({ process: 'chrome', title: 'Bankside Hotel' }, list)).toBeNull();
    expect(matchSensitiveApp({ process: 'Discord', title: '#general' }, list)).toBeNull();
  });
});
