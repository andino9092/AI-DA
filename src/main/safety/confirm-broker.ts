import type { AssistantEvent } from '@shared/assistant';
import type { ConfirmRequest } from './executor';

const TIMEOUT_MS = 60_000;

/**
 * Turns a confirmation request into a Yes/No card in the UI and waits for the answer. Silence
 * means no: an unanswered confirmation is declined after a minute.
 */
export class ConfirmBroker {
  private readonly pending = new Map<string, (approved: boolean) => void>();

  constructor(
    private readonly present: (event: AssistantEvent) => void,
    private readonly holdUiOpen: () => () => void,
  ) {}

  request = (req: ConfirmRequest): Promise<boolean> => {
    const release = this.holdUiOpen();
    return new Promise<boolean>((resolve) => {
      const finish = (approved: boolean) => {
        clearTimeout(timer);
        this.pending.delete(req.id);
        release();
        this.present({ type: 'confirm-resolved', requestId: req.requestId, confirmId: req.id });
        resolve(approved);
      };
      const timer = setTimeout(() => finish(false), TIMEOUT_MS);
      this.pending.set(req.id, finish);
      this.present({
        type: 'confirm',
        requestId: req.requestId,
        confirmId: req.id,
        summary: req.summary,
        usesSensitiveValue: req.usesSensitiveValue,
      });
    });
  };

  resolve(confirmId: string, approved: boolean): void {
    this.pending.get(confirmId)?.(approved);
  }

  /** Declines everything still waiting (e.g. on quit). */
  cancelAll(): void {
    for (const finish of [...this.pending.values()]) finish(false);
  }
}
