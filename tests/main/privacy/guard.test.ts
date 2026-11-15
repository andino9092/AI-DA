import { describe, expect, it } from 'vitest';
import { PlaceholderSession, PrivacyGuard } from '../../../src/main/privacy/guard';

const guard = new PrivacyGuard(() => ({ maskContactInfo: false, customValues: [] }));

describe('PrivacyGuard', () => {
  it('always masks emails in text read off the screen, whatever the setting says', () => {
    const tabs = { elements: ['#14 tabitem "Inbox - someone@gmail.com - Gmail"'] };
    const said = guard.scrubJson({ text: 'email someone@gmail.com' }, new PlaceholderSession());
    expect(said).toContain('someone@gmail.com');
    const screen = guard.scrubJson(tabs, new PlaceholderSession(), { maskContactInfo: true });
    expect(screen).not.toContain('someone@gmail.com');
    expect(screen).toContain('[EMAIL_1]');
  });

  it('replaces sensitive values with typed placeholders', () => {
    const session = new PlaceholderSession();
    const { text, findings } = guard.scrub(
      'fill in 4111 1111 1111 1111 with cvv 123 and my password is s3cret!',
      session,
    );
    expect(text).toBe('fill in [CARD_1] with cvv [CVV_1] and my password is [PASSWORD_1]');
    expect(findings.map((f) => f.kind)).toEqual(['CARD', 'CVV', 'PASSWORD']);
  });

  it('masks a value it has already seen, however it is written later', () => {
    const session = new PlaceholderSession();
    guard.scrub('open AKIAIOSFODNN7EXAMPLE and pay GB82WEST12345698765432', session);
    // Lower-cased by the command parser, or repeated by a tool: no detector matches these.
    expect(guard.scrub("I couldn't find an app called akiaiosfodnn7example.", session).text).toBe(
      "I couldn't find an app called [API_KEY_1].",
    );
    expect(guard.scrub('sent to gb82 west 1234-5698 765432', session).text).toBe(
      'sent to [IBAN_1]',
    );
    // A different conversation has not seen them, so nothing is assumed.
    expect(guard.scrub('akiaiosfodnn7example', new PlaceholderSession()).text).toBe(
      'akiaiosfodnn7example',
    );
  });

  it('leaves short values, longer words and placeholders alone when masking by memory', () => {
    const session = new PlaceholderSession();
    guard.scrub('my cvv is 123 and my password is ACCOUNT', session);
    // A three-digit CVV is too short to chase through later text.
    expect(guard.scrub('set the volume to 123', session).text).toBe('set the volume to 123');
    // "account" inside a longer word, and inside a placeholder, is not the password.
    expect(guard.scrub('open my accounting app', session).text).toBe('open my accounting app');
    expect(guard.scrub('use [ACCOUNT_1] here', session).text).toBe('use [ACCOUNT_1] here');
    // On its own it is.
    expect(guard.scrub('type account now', session).text).toBe('type [PASSWORD_1] now');
  });

  it('reuses the same placeholder for the same value across messages', () => {
    const session = new PlaceholderSession();
    guard.scrub('card 4111-1111-1111-1111', session);
    const second = guard.scrub('again 4111111111111111 and 4242 4242 4242 4242', session);
    expect(second.text).toBe('again [CARD_1] and [CARD_2]');
  });

  it('leaves clean text untouched', () => {
    const session = new PlaceholderSession();
    expect(guard.scrub('open spotify', session).text).toBe('open spotify');
    expect(session.size).toBe(0);
  });

  it('rehydrates placeholders in nested tool arguments and flags it', () => {
    const session = new PlaceholderSession();
    guard.scrub('my card is 4111 1111 1111 1111', session);
    const result = guard.rehydrate(
      { field: 'card', text: 'type [CARD_1]', list: ['[CARD_1]', '[CARD_9]'] },
      session,
    );
    expect(result.value).toEqual({
      field: 'card',
      text: 'type 4111 1111 1111 1111',
      list: ['4111 1111 1111 1111', '[CARD_9]'],
    });
    expect(result.usedSensitive).toBe(true);
  });

  it('does not flag args without real placeholders', () => {
    const session = new PlaceholderSession();
    expect(guard.rehydrate({ name: 'spotify' }, session).usedSensitive).toBe(false);
  });

  it('scrubs strings inside JSON tool results', () => {
    const session = new PlaceholderSession();
    const out = guard.scrubJson(
      { windows: [{ title: 'Pay 4111 1111 1111 1111 - Chrome' }] },
      session,
    );
    expect(out).toBe('{"windows":[{"title":"Pay [CARD_1] - Chrome"}]}');
  });
});
