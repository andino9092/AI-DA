import { createServer, type Server } from 'node:http';

const PAGE = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>AI-DA</title><body style="font:16px system-ui;margin:3em;color:#222">${message}</body>`;

export interface RedirectOptions {
  /** Shown in messages: "Spotify", "Google". */
  service: string;
  /** Port on 127.0.0.1; 0 picks a free one (Google allows any loopback port). */
  port: number;
  /** Must come back unchanged, so a stale or forged redirect is refused. */
  state: string;
  timeoutMs: number;
  /** Opens the sign-in page once the listener is up, with the port it got. */
  open(port: number): Promise<void>;
}

export interface PendingRedirect {
  /** The authorization code, or a readable error. */
  code: Promise<string>;
  cancel(): void;
}

/**
 * OAuth sign-in for a desktop app: listens once on 127.0.0.1 for the provider's redirect to
 * /callback and returns the authorization code. The listener closes as soon as it has an answer,
 * the sign-in is cancelled, or it times out.
 */
export function waitForRedirect(options: RedirectOptions): PendingRedirect {
  const { service } = options;
  let cancel: () => void = () => {};
  const code = new Promise<string>((resolve, reject) => {
    let server: Server | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const finish = (error: Error | null, value?: string) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      server?.close();
      server = null;
      if (error) reject(error);
      else resolve(value!);
    };
    cancel = () => finish(new Error('Sign-in was cancelled.'));

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const received = url.searchParams.get('code');
      if (url.searchParams.get('state') !== options.state) {
        res
          .writeHead(400, { 'Content-Type': 'text/html' })
          .end(PAGE('This sign-in link is out of date. Try again from AI-DA.'));
        return;
      }
      if (error || !received) {
        res
          .writeHead(200, { 'Content-Type': 'text/html' })
          .end(PAGE(`${service} was not connected. You can close this tab.`));
        finish(
          new Error(
            error === 'access_denied'
              ? `You cancelled the ${service} sign-in.`
              : `${service} said: ${error ?? 'no code'}.`,
          ),
        );
        return;
      }
      res
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end(PAGE(`${service} is connected to AI-DA. You can close this tab.`));
      finish(null, received);
    });
    server.on('error', (err: NodeJS.ErrnoException) =>
      finish(
        new Error(
          err.code === 'EADDRINUSE'
            ? `Port ${options.port} is in use by another program, so the sign-in can't finish.`
            : err.message,
        ),
      ),
    );
    server.listen(options.port, '127.0.0.1', () => {
      const address = server?.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      timer = setTimeout(
        () => finish(new Error(`The ${service} sign-in timed out.`)),
        options.timeoutMs,
      );
      options
        .open(port)
        .catch((err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
    });
  });
  return { code, cancel: () => cancel() };
}

export function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
