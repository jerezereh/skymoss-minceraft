/**
 * Which Discord channel a CI event belongs in.
 *
 * Kept as a pure function in its own module rather than inline in relay.ts, because
 * relay.ts imports config.ts, which throws on missing environment variables at
 * module load — so anything living there cannot be tested without standing up a
 * full environment. This is the one piece of the notification path with real
 * decision logic in it, and it fails silently when wrong: a misrouted outage lands
 * in a channel someone deliberately muted, and nobody finds out until it matters.
 */

/**
 * The branch the mirror and every server install are published from.
 *
 * Not read from config: this is about what a branch *means* to this project, not a
 * deployment setting, and a wrong value here misroutes alerts rather than failing
 * loudly.
 */
export const DEFAULT_BRANCH = 'main';

export interface CiEvent {
  kind: string;
  status?: string;
  name?: string;
  version?: string;
  url?: string;
  detail?: string;
  branch?: string;
}

/**
 * True when an event means "something is broken right now" rather than "here is
 * what happened".
 *
 * A failed build on the default branch qualifies: the mirror publishes from main,
 * so a broken manifest there breaks every install and every server restart. A
 * failure on a topic branch does not — that is what branches are for, and routing
 * it as an alert would train people to ignore the alert channel, which is the only
 * way this split can actually fail.
 */
export function isUrgentCiEvent(event: CiEvent): boolean {
  return event.status === 'failure' && event.branch === DEFAULT_BRANCH;
}
