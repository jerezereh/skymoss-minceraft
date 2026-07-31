/**
 * build-index — generate pack/index.toml and update the index hash in pack/pack.toml.
 *
 * This is a local stand-in for `packwiz refresh`. packwiz publishes no tagged binaries
 * (it is `go install` only), so the repo does not require a Go toolchain just to keep
 * the index current. CI installs real packwiz for exports, and `pack-validate.yml` runs
 * `packwiz refresh --build` to confirm this generator agrees with the reference tool.
 *
 * Index format: every file under pack/ except pack.toml and index.toml gets a [[files]]
 * entry with its sha256. Entries under mods/ that end in .pw.toml are marked
 * `metafile = true`, which is what tells packwiz to follow them to a download.
 *
 * Usage: node tools/build-index.ts [--pack pack] [--check]
 *   --check  exit non-zero if the index is stale instead of rewriting it (for CI)
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, relative, sep, posix } from 'node:path';

interface Entry {
  file: string;
  hash: string;
  metafile: boolean;
}

const EXCLUDE_FILES = new Set(['pack.toml', 'index.toml']);
// Runtime junk that must never be published as part of the pack even if it lands
// in pack/ by accident during an import.
const EXCLUDE_DIRS = new Set([
  'logs',
  'crash-reports',
  'cache',
  '.mixin.out',
  'local',
  'downloads',
  'dynamic-data-pack-cache',
  'dynamic-resource-pack-cache',
  'particular_cache',
  'simplebackups',
  'screenshots',
  'saves',
  '.connector',
]);

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

async function walk(root: string, dir = root, acc: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      await walk(root, join(dir, e.name), acc);
    } else if (e.isFile()) {
      const rel = relative(root, join(dir, e.name));
      if (EXCLUDE_FILES.has(rel)) continue;
      acc.push(rel);
    }
  }
  return acc;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** packwiz paths are always forward-slashed regardless of host OS. */
function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

function renderIndex(entries: Entry[]): string {
  const lines = ['hash-format = "sha256"', ''];
  for (const e of entries) {
    lines.push('[[files]]');
    lines.push(`file = ${JSON.stringify(e.file)}`);
    lines.push(`hash = ${JSON.stringify(e.hash)}`);
    if (e.metafile) lines.push('metafile = true');
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packDir = String(args.pack ?? 'pack');
  const check = Boolean(args.check);

  const files = (await walk(packDir)).map(toPosix).sort();

  const entries: Entry[] = [];
  for (const rel of files) {
    const buf = await readFile(join(packDir, rel));
    entries.push({
      file: rel,
      hash: sha256(buf),
      metafile: rel.startsWith('mods/') && rel.endsWith('.pw.toml'),
    });
  }

  const indexText = renderIndex(entries);
  const indexPath = join(packDir, 'index.toml');
  const indexHash = sha256(Buffer.from(indexText, 'utf8'));

  const packPath = join(packDir, 'pack.toml');
  const packText = await readFile(packPath, 'utf8');
  const newPackText = packText.replace(
    /(\[index\][\s\S]*?hash\s*=\s*)"[^"]*"/,
    `$1"${indexHash}"`,
  );

  if (check) {
    let stale = false;
    try {
      const existing = await readFile(indexPath, 'utf8');
      if (existing !== indexText) { console.error('index.toml is stale'); stale = true; }
    } catch { console.error('index.toml is missing'); stale = true; }
    if (packText !== newPackText) { console.error('pack.toml index hash is stale'); stale = true; }
    if (stale) { console.error('run: node tools/build-index.ts'); process.exit(1); }
    console.log(`index up to date (${entries.length} files)`);
    return;
  }

  await writeFile(indexPath, indexText, 'utf8');
  await writeFile(packPath, newPackText, 'utf8');

  const metafiles = entries.filter((e) => e.metafile).length;
  console.log(`index.toml: ${entries.length} files (${metafiles} mod metafiles)`);
  console.log(`index hash: ${indexHash}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
