/**
 * Skymoss bridge — entrypoint.
 *
 * Runs a Discord gateway client and an HTTP server side by side. The HTTP server
 * receives GitHub webhooks and CI events; the gateway client receives Discord
 * messages. Both feed the same Relay.
 */

import Fastify from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import { BridgeDb } from './db.ts';
import { DiscordSide } from './discord.ts';
import { GitHubSide } from './github.ts';
import { Relay } from './relay.ts';
import { handleCommand } from './commands.ts';
import { Poller } from './poller.ts';

/**
 * Constant-time signature comparison.
 *
 * A plain `===` on a signature leaks its correct prefix through timing, letting an
 * attacker forge one byte at a time. timingSafeEqual also throws on length
 * mismatch, so lengths are checked first.
 */
function verifySignature(payload: string, signature: string, secret: string, prefix: string): boolean {
  const expected = prefix + createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function main() {
  const db = new BridgeDb(config.databasePath);
  const discord = new DiscordSide();
  const github = new GitHubSide();
  const relay = new Relay(db, discord, github);

  await discord.login();
  await relay.init();

  discord.onMessage((msg) => relay.onDiscordMessage(msg));
  discord.onThreadCreate((thread) => relay.onDiscordThreadCreated(thread));

  await discord.registerCommands();
  discord.onCommand((interaction) =>
    handleCommand(interaction, { rcon: config.rcon, adminRoleId: config.adminRoleId || undefined, relay, discord }),
  );

  if (!config.adminRoleId) {
    console.warn('[bridge] ADMIN_ROLE_ID unset — /restart and /cmd are disabled for everyone');
  }
  if (!config.rcon.password) {
    console.warn('[bridge] RCON_PASSWORD unset — server commands will fail');
  }

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  });

  // The raw body is required for signature verification — re-serializing the parsed
  // JSON would change byte-for-byte content and break the HMAC.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, { raw: body as string, parsed: JSON.parse(body as string) });
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get('/health', async () => ({ ok: true }));

  // -------------------------------------------------------------------------
  // GitHub webhooks
  // -------------------------------------------------------------------------
  app.post('/webhook/github', async (req, reply) => {
    const { raw, parsed } = req.body as { raw: string; parsed: any };
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const event = req.headers['x-github-event'] as string | undefined;

    // Refuse rather than accept unverified payloads when no secret is configured —
    // an unauthenticated relay endpoint would let anyone post into Discord.
    if (!config.github.webhookSecret) {
      return reply.code(503).send({ error: 'webhooks disabled: GITHUB_WEBHOOK_SECRET not set' });
    }

    if (!signature || !verifySignature(raw, signature, config.github.webhookSecret, 'sha256=')) {
      db.logEvent({ source: 'github', eventType: event ?? 'unknown', outcome: 'error', detail: 'bad signature' });
      return reply.code(401).send({ error: 'invalid signature' });
    }

    // Acknowledge immediately; GitHub times webhooks out at 10s and relaying can
    // take longer than that when Discord is slow.
    reply.code(202).send({ ok: true });

    try {
      const action = parsed.action;
      if (event === 'issues' && action === 'opened') {
        await relay.onIssueOpened(parsed);
      } else if (event === 'issue_comment' && action === 'created') {
        await relay.onIssueComment(parsed);
      } else if (event === 'issues' && (action === 'closed' || action === 'reopened')) {
        await relay.onIssueStateChange(parsed, action);
      } else {
        db.logEvent({ source: 'github', eventType: `${event}.${action}`, outcome: 'ignored', detail: 'unhandled' });
      }
    } catch (err) {
      app.log.error({ err }, 'github webhook handler failed');
      db.logEvent({
        source: 'github',
        eventType: event ?? 'unknown',
        outcome: 'error',
        detail: String(err),
      });
    }
  });

  // -------------------------------------------------------------------------
  // CI events (posted by GitHub Actions)
  // -------------------------------------------------------------------------
  app.post('/events', async (req, reply) => {
    const { raw, parsed } = req.body as { raw: string; parsed: any };
    const signature = req.headers['x-skymoss-signature'] as string | undefined;

    if (!signature || !verifySignature(raw, signature, config.ciEventSecret, 'sha256=')) {
      return reply.code(401).send({ error: 'invalid signature' });
    }

    reply.code(202).send({ ok: true });

    try {
      await relay.onCiEvent(parsed);
    } catch (err) {
      app.log.error({ err }, 'ci event handler failed');
      db.logEvent({ source: 'ci', eventType: parsed?.kind ?? 'unknown', outcome: 'error', detail: String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // Monitoring alerts
  // -------------------------------------------------------------------------
  // Bearer token rather than HMAC: Uptime Kuma and comparable tools send plain
  // unsigned webhooks and cannot compute a signature.
  app.post('/alerts', async (req, reply) => {
    const { parsed } = req.body as { raw: string; parsed: any };

    if (!config.alertToken) {
      return reply.code(503).send({ error: 'alerts disabled: ALERT_TOKEN not configured' });
    }

    const auth = req.headers.authorization ?? '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const a = Buffer.from(provided);
    const b = Buffer.from(config.alertToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return reply.code(401).send({ error: 'invalid token' });
    }

    reply.code(202).send({ ok: true });

    try {
      await relay.onAlert(parsed);
    } catch (err) {
      app.log.error({ err }, 'alert handler failed');
      db.logEvent({ source: 'ci', eventType: 'alert', outcome: 'error', detail: String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------------
  app.post('/admin/backfill', async (req, reply) => {
    const { raw } = req.body as { raw: string };
    const signature = req.headers['x-skymoss-signature'] as string | undefined;
    if (!signature || !verifySignature(raw, signature, config.ciEventSecret, 'sha256=')) {
      return reply.code(401).send({ error: 'invalid signature' });
    }
    const created = await relay.backfill();
    return reply.send({ ok: true, created });
  });

  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[bridge] listening on :${config.port}`);

  // Polling is the default because it needs no inbound connectivity. Webhooks are
  // faster when a public hostname exists; running both is safe.
  let poller: Poller | null = null;
  if (config.github.pollIntervalSeconds > 0) {
    poller = new Poller(db, github, relay, config.github.pollIntervalSeconds * 1000);
    poller.start();
  } else if (!config.github.webhookSecret) {
    console.warn('[bridge] polling disabled and no webhook secret — GitHub→Discord is inactive');
  }

  const shutdown = async (signal: string) => {
    console.log(`[bridge] ${signal} received, shutting down`);
    poller?.stop();
    await app.close();
    await discord.destroy();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
