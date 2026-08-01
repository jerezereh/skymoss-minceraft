/**
 * Edge-triggered failure tracking for the poll streams.
 *
 * Extracted from the poller so it can be tested: poller.ts imports config.ts, which
 * throws on missing environment at module load.
 *
 * The two ways alerting goes wrong are both silent from the inside. Fire on every
 * failure and #alerts gets a message a minute until someone mutes it — at which
 * point the channel is worthless for the outage it exists to report. Fire only once
 * ever, or forget to reset, and the second outage never gets announced at all. Both
 * look like working code.
 */

/** What the caller should announce, if anything, after recording an outcome. */
export type StreamAction = 'none' | 'alert' | 'recovered';

export class StreamHealth {
  private threshold: number;
  private failures = new Map<string, number>();
  private announced = new Set<string>();

  constructor(threshold: number) {
    this.threshold = threshold;
  }

  /**
   * Record a failure. Returns 'alert' exactly once per outage, on the tick that
   * reaches the threshold — not before, and not again while it stays broken.
   */
  fail(stream: string): { action: StreamAction; count: number } {
    const count = (this.failures.get(stream) ?? 0) + 1;
    this.failures.set(stream, count);

    if (count >= this.threshold && !this.announced.has(stream)) {
      this.announced.add(stream);
      return { action: 'alert', count };
    }
    return { action: 'none', count };
  }

  /**
   * Record a success. Returns 'recovered' only if a failure was announced, so a
   * stream that blipped below the threshold and healed stays silent in both
   * directions rather than reporting a recovery from nothing.
   */
  succeed(stream: string): StreamAction {
    this.failures.delete(stream);
    if (this.announced.delete(stream)) return 'recovered';
    return 'none';
  }
}
