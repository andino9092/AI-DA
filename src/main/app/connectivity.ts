const POLL_MS = 15_000;
/** After the AI providers couldn't be reached, show offline for this long (or until one works). */
const PROVIDER_DOWN_MS = 2 * 60_000;

/**
 * Online/offline for the tray icon: Windows' network status, plus whether the AI providers
 * actually answered recently (Wi-Fi can be "connected" with no internet). Local commands
 * (volume, media, apps, windows, timers) keep working either way.
 */
export class Connectivity {
  private providerDownUntil = 0;
  private last: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    /** Electron's net.isOnline(): false when there's no network connection at all. */
    private readonly networkUp: () => boolean,
    private readonly onChange: (online: boolean) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.last = this.online;
  }

  /** No network connection at all: don't even try the AI providers. */
  get hasNetwork(): boolean {
    return this.networkUp();
  }

  get online(): boolean {
    return this.networkUp() && this.now() >= this.providerDownUntil;
  }

  start(): void {
    this.timer ??= setInterval(() => this.check(), POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** An AI provider answered. */
  providerReached(): void {
    this.providerDownUntil = 0;
    this.check();
  }

  /** Every provider failed with a network error. */
  providerUnreachable(): void {
    this.providerDownUntil = this.now() + PROVIDER_DOWN_MS;
    this.check();
  }

  check(): void {
    const online = this.online;
    if (online === this.last) return;
    this.last = online;
    this.onChange(online);
  }
}
