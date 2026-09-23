import { describe, expect, it } from 'vitest';
import { detectSensitive, type DetectOptions } from '../../../src/main/privacy/detectors';
import {
  isAbaRoutingValid,
  isIbanValid,
  isLuhnValid,
  isPlausibleSsn,
} from '../../../src/main/privacy/validators';

const defaults: DetectOptions = { maskContactInfo: false, customValues: [] };
const kinds = (text: string, options = defaults) =>
  detectSensitive(text, options).map((f) => [f.kind, f.value]);

describe('validators', () => {
  it('Luhn', () => {
    expect(isLuhnValid('4111 1111 1111 1111')).toBe(true);
    expect(isLuhnValid('378282246310005')).toBe(true);
    expect(isLuhnValid('4111 1111 1111 1112')).toBe(false);
    expect(isLuhnValid('0000000000000000')).toBe(false);
  });
  it('SSN', () => {
    expect(isPlausibleSsn('123-45-6789')).toBe(true);
    for (const bad of ['000-12-3456', '666-12-3456', '912-34-5678', '123-00-6789', '123-45-0000']) {
      expect(isPlausibleSsn(bad)).toBe(false);
    }
  });
  it('ABA routing', () => {
    expect(isAbaRoutingValid('021000021')).toBe(true);
    expect(isAbaRoutingValid('021000022')).toBe(false);
  });
  it('IBAN', () => {
    expect(isIbanValid('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(isIbanValid('DE89370400440532013000')).toBe(true);
    expect(isIbanValid('GB82 WEST 1234 5698 7654 33')).toBe(false);
  });
});

describe('detectSensitive: catches', () => {
  it.each([
    ['my card is 4111 1111 1111 1111', 'CARD', '4111 1111 1111 1111'],
    ['pay with 4242-4242-4242-4242 please', 'CARD', '4242-4242-4242-4242'],
    ['amex 378282246310005', 'CARD', '378282246310005'],
    ['cvv is 123', 'CVV', '123'],
    ['expiration 09/28', 'EXPIRY', '09/28'],
    ['my ssn is 123-45-6789', 'SSN', '123-45-6789'],
    ['social security number 123456789', 'SSN', '123456789'],
    ['routing number 021000021', 'ROUTING', '021000021'],
    ['send it to GB82 WEST 1234 5698 7654 32', 'IBAN', 'GB82 WEST 1234 5698 7654 32'],
    ['swift code BOFAUS3N', 'SWIFT', 'BOFAUS3N'],
    ['checking account number is 000123456789', 'ACCOUNT', '000123456789'],
    ['my password is hunter2!', 'PASSWORD', 'hunter2!'],
    ['password: Tr0ub4dor&3', 'PASSWORD', 'Tr0ub4dor&3'],
    ['my pin is 4821', 'PASSWORD', '4821'],
    ['username is andy_l', 'PASSWORD', 'andy_l'],
    ['the verification code is 482913', 'OTP', '482913'],
    ['key AKIAIOSFODNN7EXAMPLE', 'API_KEY', 'AKIAIOSFODNN7EXAMPLE'],
    ['use gsk_abcdefghijklmnopqrstuvwx1234', 'API_KEY', 'gsk_abcdefghijklmnopqrstuvwx1234'],
    ['passport number X12345678', 'GOV_ID', 'X12345678'],
    ['token Zq8vN3kP2mL9xR4tW7yB1cF6hJ0dS5aG', 'SECRET', 'Zq8vN3kP2mL9xR4tW7yB1cF6hJ0dS5aG'],
  ])('%s', (text, kind, value) => {
    expect(kinds(text)).toContainEqual([kind, value]);
  });

  it('finds several values in one sentence without overlap', () => {
    const found = kinds('card 4111111111111111 exp 12/27 cvv 999 for account 12345678');
    expect(found).toEqual([
      ['CARD', '4111111111111111'],
      ['EXPIRY', '12/27'],
      ['CVV', '999'],
      ['ACCOUNT', '12345678'],
    ]);
  });

  it('masks private key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----';
    expect(kinds(`here ${pem} ok`)).toEqual([['PRIVATE_KEY', pem]]);
  });

  it('matches custom values regardless of spacing and case', () => {
    const options = { ...defaults, customValues: ['9876 5432 10', '42 Wallaby Way'] };
    expect(kinds('acct 98765-43210 at 42 wallaby  way', options)).toEqual([
      ['CUSTOM', '98765-43210'],
      ['CUSTOM', '42 wallaby  way'],
    ]);
  });

  it('only masks emails and phones when asked to', () => {
    const text = 'email andy@example.com or call 555-123-4567';
    expect(kinds(text)).toEqual([]);
    expect(kinds(text, { ...defaults, maskContactInfo: true })).toEqual([
      ['EMAIL', 'andy@example.com'],
      ['PHONE', '555-123-4567'],
    ]);
  });
});

describe('detectSensitive: leaves everyday commands alone', () => {
  it.each([
    'open spotify and set volume to 30',
    'open the password manager',
    'snap chrome to the left',
    'open visual studio code',
    'vs code is slow, restart it',
    'what time is it',
    'play the next song',
    'set a timer for 1500 seconds',
    'open https://github.com/andino9092/AI-DA',
    'install version 2.0.0-alpha.0',
    'switch to account 2',
    'turn the volume down by 15 percent',
    'move discord to my second monitor',
  ])('%s', (text) => {
    expect(kinds(text)).toEqual([]);
  });
});
