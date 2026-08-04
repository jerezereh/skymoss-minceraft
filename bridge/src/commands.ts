/**
 * Discord slash commands for server administration, over RCON.
 *
 * ## Permissions
 *
 * `/status` and `/players` are read-only and open to everyone.
 *
 * `/restart` and `/cmd` are gated behind ADMIN_ROLE_ID. `/cmd` in particular is a
 * full RCON console: it can op, ban, deop, and stop the server. Anyone who can run
 * it effectively controls the server, so it is denied by default and requires the
 * role to be configured explicitly — an unset ADMIN_ROLE_ID means nobody can use it,
 * which is the safe direction to fail.
 */

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { rconCommand, stripFormatting, RconAuthError, type RconOptions } from './rcon.ts';
import type { Relay } from './relay.ts';

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Is the server up, and how is it doing?'),

  new SlashCommandBuilder()
    .setName('players')
    .setDescription("Who's online right now?"),

  new SlashCommandBuilder()
    .setName('file')
    .setDescription('File this thread as a GitHub issue, copying its whole history as comments'),

  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close the GitHub issue for this thread'),

  new SlashCommandBuilder()
    .setName('reopen')
    .setDescription('Reopen the GitHub issue for this thread'),

  new SlashCommandBuilder()
    .setName('restart')
    .setDescription('Restart the Minecraft server (admin only)'),

  new SlashCommandBuilder()
    .setName('cmd')
    .setDescription('Run a server console command (admin only)')
    .addStringOption((o) =>
      o.setName('command').setDescription('Command to run, without the leading /').setRequired(true),
    ),
].map((c) => c.toJSON());

/** Commands that can change server state, and so require the admin role. */
const PRIVILEGED = new Set(['restart', 'cmd']);

export interface CommandDeps {
  rcon: RconOptions;
  adminRoleId?: string;
  relay: Relay;
  discord: { setThreadArchived(threadId: string, archived: boolean): Promise<void> };
}

function isAdmin(interaction: ChatInputCommandInteraction, adminRoleId?: string): boolean {
  // Fail closed: with no role configured, nobody gets privileged commands.
  if (!adminRoleId) return false;
  const member = interaction.member as GuildMember | null;
  if (!member || !('roles' in member)) return false;
  return member.roles.cache.has(adminRoleId);
}

async function rcon(deps: CommandDeps, command: string): Promise<string> {
  const raw = await rconCommand(deps.rcon, command);
  return stripFormatting(raw).trim();
}

export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  const name = interaction.commandName;

  if (PRIVILEGED.has(name) && !isAdmin(interaction, deps.adminRoleId)) {
    await interaction.reply({
      content: deps.adminRoleId
        ? '⛔ That command is admin-only.'
        : '⛔ Admin commands are disabled — `ADMIN_ROLE_ID` is not configured.',
      ephemeral: true,
    });
    return;
  }

  // RCON round-trips can exceed Discord's 3-second reply window, especially while
  // the server is starting, so acknowledge first and edit the reply afterwards.
  await interaction.deferReply();

  try {
    switch (name) {
      case 'status': {
        // `list` doubles as a liveness probe: a reply at all means the server is up.
        const list = await rcon(deps, 'list');
        const tps = await rcon(deps, 'neoforge tps').catch(() => '');
        const lines = ['🟢 **Server is up**', '', list];
        if (tps) lines.push('', '```', tps.slice(0, 1200), '```');
        await interaction.editReply(lines.join('\n'));
        break;
      }

      case 'players': {
        const list = await rcon(deps, 'list');
        await interaction.editReply(list || 'No response from the server.');
        break;
      }

      case 'file': {
        const result = await deps.relay.fileThreadAsIssue(interaction.channelId);

        if (!result.ok) {
          const message =
            result.reason === 'already-linked'
              ? `ℹ️ Already tracked as [#${result.issueNumber}](${result.url}).`
              : result.reason === 'not-a-thread'
                ? '⛔ `/file` only works inside a thread.'
                : '⛔ Nothing to file — this thread has no messages from a person yet.';
          await interaction.editReply(message);
          break;
        }

        await interaction.editReply(
          `📮 Filed as [#${result.issueNumber}](${result.url}) — backfilled ${result.backfilled} comment${result.backfilled === 1 ? '' : 's'}.`,
        );
        break;
      }

      case 'close':
      case 'reopen': {
        const action = name === 'close' ? 'closed' : 'reopened';
        const actorName = (interaction.member as GuildMember | null)?.displayName ?? interaction.user.username;
        const result = await deps.relay.setIssueStateFromDiscord(interaction.channelId, action, actorName);

        if (!result.ok) {
          await interaction.editReply(
            result.reason === 'not-linked'
              ? "⛔ This thread isn't linked to a GitHub issue."
              : `ℹ️ Already ${action === 'closed' ? 'closed' : 'open'}.`,
          );
          break;
        }

        await interaction.editReply(`🔒 **${actorName}** ${action} [#${result.issueNumber}](${result.url})`);
        // After the reply, not before: sending into an already-archived thread can
        // un-archive it right back.
        await deps.discord.setThreadArchived(interaction.channelId, action === 'closed').catch(() => {});
        break;
      }

      case 'restart': {
        // No docker socket in this container by design. Instead the server is asked
        // to stop, and Compose's `restart: unless-stopped` policy brings it back —
        // which also means a crash-restart and an admin restart take the same path.
        await interaction.editReply('♻️ Restarting — the server will be back in a few minutes.');
        await rcon(deps, 'say §eServer restarting shortly…').catch(() => {});
        await rcon(deps, 'save-all flush').catch(() => {});
        await rcon(deps, 'stop');
        break;
      }

      case 'cmd': {
        const command = interaction.options.getString('command', true);
        const out = await rcon(deps, command);
        await interaction.editReply(
          [`\`> ${command}\``, '```', (out || '(no output)').slice(0, 1800), '```'].join('\n'),
        );
        break;
      }

      default:
        await interaction.editReply('Unknown command.');
    }
  } catch (err) {
    const message =
      err instanceof RconAuthError
        ? '❌ RCON authentication failed — check `RCON_PASSWORD`.'
        : `❌ Could not reach the server: ${(err as Error).message}`;

    // A failed `list` is the normal signal that the server is down, not an error
    // worth an alarming message.
    if (name === 'status') {
      await interaction.editReply(`🔴 **Server is not responding**\n\n${message}`);
    } else {
      await interaction.editReply(message);
    }
  }
}
