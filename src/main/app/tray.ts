import { Menu, Tray, nativeImage, type NativeImage } from 'electron';
import { ASSISTANT_STATES, ASSISTANT_STATE_LABELS, type AssistantState } from '@shared/assistant';
import { paths } from './paths';

export interface TrayActions {
  openSettings(): void;
  setMicrophoneMuted(muted: boolean): void;
  setLaunchAtLogin(enabled: boolean): void;
  quit(): void;
}

interface TrayView {
  state: AssistantState;
  microphoneMuted: boolean;
  launchAtLogin: boolean;
}

export class TrayController {
  private readonly tray: Tray;
  private readonly icons: Record<AssistantState, NativeImage>;
  private view: TrayView;

  constructor(
    private readonly actions: TrayActions,
    initial: TrayView,
  ) {
    this.icons = Object.fromEntries(
      ASSISTANT_STATES.map((s) => [
        s,
        nativeImage.createFromPath(paths.resources('tray', `${s}.png`)),
      ]),
    ) as Record<AssistantState, NativeImage>;
    this.view = initial;
    this.tray = new Tray(this.icons[initial.state]);
    // Left-click opens settings for now; later phases will make it push-to-talk.
    this.tray.on('click', () => this.actions.openSettings());
    this.render();
  }

  update(patch: Partial<TrayView>): void {
    this.view = { ...this.view, ...patch };
    this.render();
  }

  destroy(): void {
    this.tray.destroy();
  }

  private render(): void {
    const { state, microphoneMuted, launchAtLogin } = this.view;
    this.tray.setImage(this.icons[state]);
    this.tray.setToolTip(`AI-DA — ${ASSISTANT_STATE_LABELS[state]}`);
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `AI-DA: ${ASSISTANT_STATE_LABELS[state]}`, enabled: false },
        { type: 'separator' },
        {
          label: 'Mute microphone',
          type: 'checkbox',
          checked: microphoneMuted,
          click: (item) => this.actions.setMicrophoneMuted(item.checked),
        },
        { label: 'Settings…', click: () => this.actions.openSettings() },
        { type: 'separator' },
        {
          label: 'Launch at login',
          type: 'checkbox',
          checked: launchAtLogin,
          click: (item) => this.actions.setLaunchAtLogin(item.checked),
        },
        { label: 'Quit AI-DA', click: () => this.actions.quit() },
      ]),
    );
  }
}
