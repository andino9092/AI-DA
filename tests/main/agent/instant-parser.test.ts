import { describe, expect, it } from 'vitest';
import { parseInstant } from '../../../src/main/agent/instant-parser';

describe('parseInstant', () => {
  it.each([
    ['set volume to 30', [{ name: 'set_volume', args: { level: 30 } }]],
    ['Volume 45%', [{ name: 'set_volume', args: { level: 45 } }]],
    [
      'Hey Aida, turn the volume down by 15 percent.',
      [{ name: 'change_volume', args: { delta: -15 } }],
    ],
    ['turn it up', [{ name: 'change_volume', args: { delta: 10 } }]],
    ['louder please', [{ name: 'change_volume', args: { delta: 10 } }]],
    ['mute', [{ name: 'set_mute', args: { muted: true } }]],
    ['unmute the sound', [{ name: 'set_mute', args: { muted: false } }]],
    ["what's the volume", [{ name: 'get_volume', args: {} }]],
    ['pause the music', [{ name: 'media_control', args: { action: 'pause' } }]],
    ['resume', [{ name: 'media_control', args: { action: 'play' } }]],
    ['pause spotify', [{ name: 'media_control', args: { action: 'pause', app: 'spotify' } }]],
    ['stop it', null],
    [
      'pause the music on spotify',
      [{ name: 'media_control', args: { action: 'pause', app: 'spotify' } }],
    ],
    ['play on spotify', [{ name: 'media_control', args: { action: 'play', app: 'spotify' } }]],
    ['next song on spotify', [{ name: 'media_control', args: { action: 'next', app: 'spotify' } }]],
    ["what's playing", [{ name: 'now_playing', args: {} }]],
    ['what song is this', [{ name: 'now_playing', args: {} }]],
    ['play daft punk on spotify', null],
    [
      'click the send button in discord',
      [{ name: 'click', args: { target: 'send', window: 'discord' } }],
    ],
    ['click on settings', [{ name: 'click', args: { target: 'settings' } }]],
    ['press play on spotify', [{ name: 'click', args: { target: 'play', window: 'spotify' } }]],
    ['select all', null],
    ['press enter', [{ name: 'press_keys', args: { keys: 'enter' } }]],
    ['press control shift t', [{ name: 'press_keys', args: { keys: 'ctrl+shift+t' } }]],
    ['press ctrl+w', [{ name: 'press_keys', args: { keys: 'ctrl+w' } }]],
    ['scroll down', [{ name: 'scroll', args: { direction: 'down', amount: 5 } }]],
    // Media words are never app names; filler words never open anything.
    ['start the video', [{ name: 'media_control', args: { action: 'play' } }]],
    [
      'can you start the video on my browser',
      [{ name: 'media_control', args: { action: 'play', app: 'browser' } }],
    ],
    [
      'play the youtube video on zen',
      [{ name: 'media_control', args: { action: 'play', app: 'zen' } }],
    ],
    [
      'start the youtube video',
      [{ name: 'media_control', args: { action: 'play', app: 'youtube' } }],
    ],
    ['can you open and...', null],
    ['open the video', null],
    ['set a timer for 10 minutes', [{ name: 'set_timer', args: { duration: '10 minutes' } }]],
    // Speech recognition dropped "can" from "can you…".
    ['You set a timer for one minute.', [{ name: 'set_timer', args: { duration: 'one minute' } }]],
    ['10 minute timer', [{ name: 'set_timer', args: { duration: '10 minute' } }]],
    [
      'remind me in 20 minutes to take out the laundry',
      [{ name: 'set_timer', args: { duration: '20 minutes', label: 'take out the laundry' } }],
    ],
    [
      'remind me to call mom in an hour',
      [{ name: 'set_timer', args: { duration: 'an hour', label: 'call mom' } }],
    ],
    ['cancel the timer', [{ name: 'cancel_timer', args: {} }]],
    ['stop the timer', [{ name: 'cancel_timer', args: {} }]],
    ['how much time is left', [{ name: 'list_timers', args: {} }]],
    ['open my downloads', [{ name: 'open_folder', args: { name: 'my downloads' } }]],
    ['open downloads', [{ name: 'open_folder', args: { name: 'downloads' } }]],
    ['open the taxes folder', [{ name: 'open_folder', args: { name: 'the taxes folder' } }]],
    ['open budget.xlsx', [{ name: 'open_file', args: { name: 'budget.xlsx' } }]],
    ['open the file called resume', [{ name: 'open_file', args: { name: 'resume' } }]],
    ['open a new folder', null],
    ['set spotify volume to 30', [{ name: 'set_app_volume', args: { app: 'spotify', level: 30 } }]],
    ["discord's volume 20", [{ name: 'set_app_volume', args: { app: 'discord', level: 20 } }]],
    ['mute chrome', [{ name: 'set_app_volume', args: { app: 'chrome', muted: true } }]],
    ['unmute discord', [{ name: 'set_app_volume', args: { app: 'discord', muted: false } }]],
    ['mute my mic', null],
    ['switch to my headphones', [{ name: 'set_output_device', args: { device: 'headphones' } }]],
    ['switch audio to the speakers', [{ name: 'set_output_device', args: { device: 'speakers' } }]],
    ['play sound through my jbl', [{ name: 'set_output_device', args: { device: 'jbl' } }]],
    [
      'scroll up a bit in chrome',
      [{ name: 'scroll', args: { direction: 'up', amount: 2, window: 'chrome' } }],
    ],
    ['skip this song', [{ name: 'media_control', args: { action: 'next' } }]],
    ['previous track', [{ name: 'media_control', args: { action: 'previous' } }]],
    ['what time is it?', [{ name: 'get_time', args: {} }]],
    ['open Spotify', [{ name: 'open_app', args: { name: 'spotify' } }]],
    ['launch visual studio code', [{ name: 'open_app', args: { name: 'visual studio code' } }]],
    ['open github.com/andino9092', [{ name: 'open_url', args: { url: 'github.com/andino9092' } }]],
    ['close discord', [{ name: 'close_app', args: { name: 'discord' } }]],
    [
      'snap chrome to the left',
      [{ name: 'window_action', args: { action: 'snap_left', target: 'chrome' } }],
    ],
    ['snap this window right', [{ name: 'window_action', args: { action: 'snap_right' } }]],
    ['minimize this', [{ name: 'window_action', args: { action: 'minimize' } }]],
    [
      'maximise spotify',
      [{ name: 'window_action', args: { action: 'maximize', target: 'spotify' } }],
    ],
    [
      'switch to discord',
      [{ name: 'window_action', args: { action: 'focus', target: 'discord' } }],
    ],
    [
      'move discord to my second monitor',
      [{ name: 'window_action', args: { action: 'next_monitor', target: 'discord' } }],
    ],
  ])('%s', (text, expected) => {
    expect(parseInstant(text)).toEqual(expected);
  });

  it('handles compound commands when every part parses', () => {
    expect(parseInstant('open spotify and set volume to 30')).toEqual([
      { name: 'open_app', args: { name: 'spotify' } },
      { name: 'set_volume', args: { level: 30 } },
    ]);
    expect(parseInstant('pause, then snap chrome left')).toEqual([
      { name: 'media_control', args: { action: 'pause' } },
      { name: 'window_action', args: { action: 'snap_left', target: 'chrome' } },
    ]);
  });

  it('keeps "and" inside app names when splitting would not parse', () => {
    expect(parseInstant('open tom and jerry')).toEqual([
      { name: 'open_app', args: { name: 'tom and jerry' } },
    ]);
  });

  it.each([
    'open a new tab',
    'open my resume',
    'close this tab',
    'email John that I am running late',
    'what is the weather tomorrow',
    'open spotify and play my liked songs',
    'switch to',
    '',
  ])('leaves "%s" to the LLM', (text) => {
    expect(parseInstant(text)).toBeNull();
  });
});
