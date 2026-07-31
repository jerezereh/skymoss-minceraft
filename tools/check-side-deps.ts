/**
 * check-side-deps — find mods excluded from a side that something on that side needs.
 *
 * `side` comes from Modrinth's client_side/server_side, which describes whether a mod
 * *can* run there — not whether this pack needs it there. When a mod is marked
 * single-sided but another mod on the opposite side declares a required dependency on
 * it, the install is broken for everyone on that side, and the failure surfaces as a
 * missing-dependency screen rather than anything pointing at the manifest.
 *
 * Reads the actual jars rather than the metafiles, because dependency declarations
 * live inside them — in neoforge.mods.toml for NeoForge mods and fabric.mod.json for
 * Fabric mods running under Connector.
 *
 * Usage: node tools/check-side-deps.ts --jars <dir> [--pack pack]
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

type Side = 'both' | 'client' | 'server';

interface Dep {
  required: boolean;
  /**
   * Which side the dependency itself applies to. NeoForge dependency blocks carry
   * their own `side` (BOTH/CLIENT/SERVER), and it is not decoration: rechiseled
   * requires fusion only on CLIENT, SSRD requires sodium only on CLIENT. Ignoring it
   * reports every client-rendering library as a broken server dependency.
   */
  side: Side;
}

interface ModInfo {
  filename: string;
  side: Side;
  modIds: string[];
  deps: Map<string, Dep>;
}

/** Mod ids provided by the loader/game rather than by a jar in the pack. */
const BUILTIN = new Set(['minecraft', 'neoforge', 'forge', 'fabricloader', 'fabric', 'java', 'fml']);

function tomlGet(text: string, key: string): string | undefined {
  return text.match(new RegExp(`^\\s*${key}\\s*=\\s*"(.*?)"`, 'm'))?.[1];
}

function unzip(jar: string, entry: string): string | null {
  try {
    return execFileSync('unzip', ['-p', jar, entry], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function parseNeoforge(text: string): { modIds: string[]; deps: Map<string, Dep> } {
  const modIds: string[] = [];
  const deps = new Map<string, Dep>();

  for (const m of text.matchAll(/^\s*modId\s*=\s*"(.*?)"/gm)) modIds.push(m[1]);

  // Dependency blocks: [[dependencies.<owner>]] then modId/type/side lines until the
  // next block header. `type` filters out optional deps; `side` scopes the ones that
  // remain to the side they actually apply on.
  const blocks = text.split(/^\s*\[\[dependencies\./m).slice(1);
  for (const block of blocks) {
    const id = tomlGet(block, 'modId');
    const type = (tomlGet(block, 'type') ?? 'required').toLowerCase();
    const rawSide = (tomlGet(block, 'side') ?? 'BOTH').toUpperCase();
    const side: Side = rawSide === 'CLIENT' ? 'client' : rawSide === 'SERVER' ? 'server' : 'both';
    if (id) deps.set(id, { required: type === 'required', side });
  }

  // The [[mods]] modIds are also captured by the modId sweep above; remove any that
  // only appeared inside dependency blocks.
  const declared = [...text.matchAll(/\[\[mods\]\][\s\S]*?modId\s*=\s*"(.*?)"/g)].map((m) => m[1]);
  return { modIds: declared.length ? declared : modIds, deps };
}

function parseFabric(text: string): { modIds: string[]; deps: Map<string, Dep> } {
  const deps = new Map<string, Dep>();
  try {
    const j = JSON.parse(text);
    // fabric.mod.json has no per-dependency side, so these apply on both.
    for (const [id] of Object.entries(j.depends ?? {})) deps.set(id, { required: true, side: 'both' });
    for (const [id] of Object.entries(j.recommends ?? {})) deps.set(id, { required: false, side: 'both' });
    for (const [id] of Object.entries(j.suggests ?? {})) deps.set(id, { required: false, side: 'both' });
    return { modIds: j.id ? [j.id] : [], deps };
  } catch {
    return { modIds: [], deps };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const jarsDir = args[args.indexOf('--jars') + 1];
  const packDir = args.includes('--pack') ? args[args.indexOf('--pack') + 1] : 'pack';

  if (!jarsDir || jarsDir.startsWith('--')) {
    console.error('usage: node tools/check-side-deps.ts --jars <dir> [--pack pack]');
    process.exit(1);
  }

  // side per filename, from the manifest
  const sideByFile = new Map<string, Side>();
  const modsMeta = join(packDir, 'mods');
  for (const f of (await readdir(modsMeta)).filter((x) => x.endsWith('.pw.toml'))) {
    const text = await readFile(join(modsMeta, f), 'utf8');
    const filename = tomlGet(text, 'filename');
    const side = (tomlGet(text, 'side') ?? 'both') as Side;
    if (filename) sideByFile.set(filename, side);
  }

  const mods: ModInfo[] = [];
  for (const jar of (await readdir(jarsDir)).filter((f) => f.endsWith('.jar')).sort()) {
    const side = sideByFile.get(jar);
    if (!side) continue; // in the folder but not in the manifest

    const path = join(jarsDir, jar);
    const nf = unzip(path, 'META-INF/neoforge.mods.toml') ?? unzip(path, 'META-INF/mods.toml');
    const fab = unzip(path, 'fabric.mod.json');

    const a = nf ? parseNeoforge(nf) : { modIds: [], deps: new Map<string, Dep>() };
    const b = fab ? parseFabric(fab) : { modIds: [], deps: new Map<string, Dep>() };

    mods.push({
      filename: jar,
      side,
      modIds: [...new Set([...a.modIds, ...b.modIds])],
      deps: new Map([...a.deps, ...b.deps]),
    });
  }

  // modId -> the mod providing it
  const provider = new Map<string, ModInfo>();
  for (const m of mods) for (const id of m.modIds) provider.set(id, m);

  const problems: string[] = [];

  for (const m of mods) {
    // Which sides does this mod actually get installed on?
    const installedOn: Side[] = m.side === 'both' ? ['client', 'server'] : [m.side];

    for (const [depId, dep] of m.deps) {
      if (!dep.required || BUILTIN.has(depId)) continue;
      const p = provider.get(depId);
      if (!p) continue; // not in this pack at all; nothing we can fix by re-siding

      for (const s of installedOn) {
        // A dependency scoped to one side is only needed there.
        if (dep.side !== 'both' && dep.side !== s) continue;
        const depPresent = p.side === 'both' || p.side === s;
        if (!depPresent) {
          problems.push(
            `${m.filename}\n    side=${m.side}, requires "${depId}"\n` +
              `    provided by ${p.filename} (side=${p.side}) — MISSING on ${s}\n` +
              `    fix: set ${p.filename} to side = "both"`,
          );
        }
      }
    }
  }

  console.log(`checked ${mods.length} mods against the manifest`);
  const bySide = { both: 0, client: 0, server: 0 } as Record<Side, number>;
  for (const m of mods) bySide[m.side]++;
  console.log(`  sides: both=${bySide.both} client=${bySide.client} server=${bySide.server}`);
  console.log('');

  if (!problems.length) {
    console.log('No cross-side dependency breaks found.');
    return;
  }

  console.log(`${problems.length} broken dependency/dependencies:\n`);
  for (const p of [...new Set(problems)]) console.log('  ' + p + '\n');
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
