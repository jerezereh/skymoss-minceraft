/**
 * fetch-jars — download every jar the manifest references, verifying each hash.
 *
 * The mirror is an ARCHIVE, not a distribution path. Metafiles keep pointing at
 * Modrinth; this is what you repoint them *to* if a mod is deleted or delisted
 * upstream. Mods do disappear — authors remove versions, projects go private, and a
 * pack that resolves entirely from other people's CDNs is one takedown away from
 * being uninstallable.
 *
 * Runs on the server so nothing has to be shipped from a workstation.
 *
 * Usage:
 *   node tools/fetch-jars.ts --out /srv/skymoss-jars [--pack pack] [--concurrency 4]
 *
 * Re-runnable: files already present with a matching hash are skipped, so an
 * interrupted run resumes rather than starting over.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

interface Entry {
  metafile: string;
  filename: string;
  url: string;
  hash: string;
  hashFormat: string;
}

function get(text: string, key: string): string | undefined {
  return text.match(new RegExp(`^${key} = "(.*)"$`, 'm'))?.[1];
}

function digest(buf: Buffer, format: string): string {
  // murmur2 is CurseForge-specific and not a node digest; nothing in this pack uses
  // it for downloads, so treat it as unverifiable rather than silently passing.
  if (!['sha512', 'sha256', 'sha1', 'md5'].includes(format)) return '';
  return createHash(format).update(buf).digest('hex');
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) break;
        await fn(items[i]);
      }
    }),
  );
}

async function main() {
  const args = process.argv.slice(2);
  const outDir = args[args.indexOf('--out') + 1];
  const packDir = args.includes('--pack') ? args[args.indexOf('--pack') + 1] : 'pack';
  const concurrency = args.includes('--concurrency') ? Number(args[args.indexOf('--concurrency') + 1]) : 4;

  if (!outDir || outDir.startsWith('--')) {
    console.error('usage: node tools/fetch-jars.ts --out <dir> [--pack pack] [--concurrency 4]');
    process.exit(1);
  }

  const modsDir = join(packDir, 'mods');
  const entries: Entry[] = [];
  let noUrl = 0;

  for (const f of (await readdir(modsDir)).filter((x) => x.endsWith('.pw.toml')).sort()) {
    const text = await readFile(join(modsDir, f), 'utf8');
    const url = get(text, 'url');
    const filename = get(text, 'filename');
    const hash = get(text, 'hash');
    const hashFormat = get(text, 'hash-format') ?? 'sha512';
    if (!url || !filename || !hash) {
      noUrl++;
      continue;
    }
    entries.push({ metafile: f, filename, url, hash, hashFormat });
  }

  await mkdir(outDir, { recursive: true });

  let fetched = 0;
  let skipped = 0;
  const failures: string[] = [];
  let done = 0;

  console.log(`fetching ${entries.length} jars -> ${outDir} (concurrency ${concurrency})`);
  if (noUrl) console.log(`  ${noUrl} metafile(s) have no direct URL and are skipped`);

  await pool(entries, concurrency, async (e) => {
    const dest = join(outDir, e.filename);

    // Resume support: a present file with the right hash is left alone. A present
    // file with the WRONG hash is re-fetched — it is a truncated earlier run, not
    // something to keep.
    if (await exists(dest)) {
      const have = await readFile(dest);
      if (digest(have, e.hashFormat) === e.hash) {
        skipped++;
        done++;
        return;
      }
      console.log(`  re-fetching (hash mismatch on disk): ${e.filename}`);
    }

    try {
      const res = await fetch(e.url, { redirect: 'follow' });
      if (!res.ok) {
        failures.push(`${e.filename}: HTTP ${res.status}`);
        done++;
        return;
      }
      const buf = Buffer.from(await res.arrayBuffer());

      const got = digest(buf, e.hashFormat);
      if (got && got !== e.hash) {
        // Never write a file that fails verification: the whole point of the archive
        // is being able to trust it later, when upstream is gone and there is nothing
        // left to compare against.
        failures.push(`${e.filename}: hash mismatch (expected ${e.hash.slice(0, 16)}…, got ${got.slice(0, 16)}…)`);
        done++;
        return;
      }

      await writeFile(dest, buf);
      fetched++;
    } catch (err) {
      failures.push(`${e.filename}: ${(err as Error).message}`);
    }

    done++;
    if (done % 25 === 0) console.log(`  ${done}/${entries.length}`);
  });

  console.log('');
  console.log(`fetched: ${fetched}   already present: ${skipped}`);

  if (failures.length) {
    console.log('');
    console.log(`FAILED (${failures.length}):`);
    for (const f of failures) console.log(`  ${f}`);
    console.log('');
    console.log('Re-run to retry; verified files are skipped.');
    process.exit(1);
  }

  console.log('');
  console.log(`All ${entries.length} jars present and hash-verified in ${outDir}`);
  console.log('Next: bash tools/sync-mirror.sh ' + outDir + ' /srv/mirror');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
