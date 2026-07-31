/**
 * check-urls — verify every download URL in the manifest is still reachable.
 *
 * The whole point of pinning a mirror is that mods vanish from upstream CDNs. This
 * turns "a friend can't install the pack" into "a PR check went red", which is a much
 * cheaper way to find out.
 *
 * Usage: node tools/check-urls.ts [--pack pack] [--concurrency 8] [--fail-on-dead]
 *
 * Exits 0 by default even when URLs are dead, because upstream CDNs return transient
 * 5xx and this runs on every PR. Pass --fail-on-dead in release workflows, where a
 * dead URL genuinely should stop the build.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface Entry {
  metafile: string;
  filename: string;
  url: string;
}

interface Result extends Entry {
  status: number | string;
  ok: boolean;
}

function get(text: string, key: string): string | undefined {
  return text.match(new RegExp(`^${key} = "(.*)"$`, 'm'))?.[1];
}

async function check(entry: Entry): Promise<Result> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);

    let res = await fetch(entry.url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal });

    // Some CDNs (notably CurseForge edge nodes) reject HEAD but serve GET fine, so a
    // 403/405 on HEAD is retried as a ranged GET before being called dead.
    if (res.status === 403 || res.status === 405) {
      res = await fetch(entry.url, {
        method: 'GET',
        redirect: 'follow',
        headers: { Range: 'bytes=0-0' },
        signal: ctrl.signal,
      });
    }

    clearTimeout(timer);
    return { ...entry, status: res.status, ok: res.ok || res.status === 206 };
  } catch (err) {
    return { ...entry, status: (err as Error).name === 'AbortError' ? 'timeout' : 'error', ok: false };
  }
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const packIdx = args.indexOf('--pack');
  const packDir = packIdx >= 0 ? args[packIdx + 1] : 'pack';
  const concIdx = args.indexOf('--concurrency');
  const concurrency = concIdx >= 0 ? Number(args[concIdx + 1]) : 8;
  const failOnDead = args.includes('--fail-on-dead');

  const modsDir = join(packDir, 'mods');
  const files = (await readdir(modsDir)).filter((f) => f.endsWith('.pw.toml')).sort();

  const entries: Entry[] = [];
  let skipped = 0;

  for (const f of files) {
    const text = await readFile(join(modsDir, f), 'utf8');
    const url = get(text, 'url');
    const filename = get(text, 'filename') ?? f;
    if (!url) {
      skipped++;
      continue;
    }
    entries.push({ metafile: f, filename, url });
  }

  console.log(`checking ${entries.length} urls (concurrency ${concurrency})…`);
  const results = await pool(entries, concurrency, check);

  const dead = results.filter((r) => !r.ok);

  console.log('');
  console.log(`reachable: ${results.length - dead.length}/${results.length}`);
  if (skipped) console.log(`no url (metadata-only): ${skipped}`);

  if (dead.length) {
    console.log('');
    console.log('UNREACHABLE:');
    for (const d of dead) console.log(`  [${d.status}] ${d.filename}\n        ${d.url}`);
    console.log('');
    console.log('Fix by re-pointing these at the mirror: tools/sync-mirror.sh');

    if (failOnDead) process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
