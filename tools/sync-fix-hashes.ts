/**
 * sync-fix-hashes — point the custom-fix metafiles at a GitHub release.
 *
 * GitHub publishes a sha256 `digest` for every release asset, so the value packwiz
 * needs already exists the moment a release is created. This reads it from the API
 * and writes url + filename + hash into the matching pack/mods/*.pw.toml.
 *
 * That replaces the previous approach of copying hashes out of a build log, which
 * required reproducible builds and a CI gate to catch mistakes. Reading the published
 * artifact's own digest is correct by construction: the hash describes the exact
 * bytes being served, so there is nothing to get out of step.
 *
 * Only mods whose jar actually changed are rewritten; anything already correct is
 * left alone, so untouched fixes keep pointing at whichever release they came from.
 *
 * Usage:
 *   node tools/sync-fix-hashes.ts --tag custom-fixes-v2 [--repo owner/name] [--check]
 *
 *   --check   report what would change and exit non-zero, without writing
 *
 * Requires `gh` to be authenticated (it is only used to call the API).
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

interface Asset {
  name: string;
  browser_download_url: string;
  digest: string | null;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function get(text: string, key: string): string | undefined {
  return text.match(new RegExp(`^${key} = "(.*)"$`, 'm'))?.[1];
}

function set(text: string, key: string, value: string): string {
  const re = new RegExp(`^${key} = ".*"$`, 'm');
  if (!re.test(text)) throw new Error(`no "${key}" line to update`);
  return text.replace(re, `${key} = ${JSON.stringify(value)}`);
}

async function main() {
  const tag = arg('tag');
  const repo = arg('repo', 'jerezereh/skymoss-minceraft')!;
  const check = process.argv.includes('--check');

  if (!tag) {
    console.error('usage: node tools/sync-fix-hashes.ts --tag <release-tag> [--repo owner/name] [--check]');
    process.exit(1);
  }

  let assets: Asset[];
  try {
    const raw = execFileSync(
      'gh',
      ['api', `repos/${repo}/releases/tags/${tag}`, '--jq', '[.assets[] | {name, browser_download_url, digest}]'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    assets = JSON.parse(raw);
  } catch (err) {
    console.error(`could not read release ${tag} from ${repo}`);
    console.error((err as Error).message);
    process.exit(1);
  }

  const jars = assets.filter((a) => a.name.endsWith('.jar'));
  if (!jars.length) {
    console.error(`release ${tag} has no .jar assets`);
    process.exit(1);
  }

  console.log(`release ${tag}: ${jars.length} jar asset(s)`);

  // Index metafiles by the mod id embedded in their filename, so a renamed jar is
  // still matched to the metafile that owns it.
  const modsDir = join('pack', 'mods');
  const metafiles = (await readdir(modsDir)).filter((f) => f.endsWith('.pw.toml'));

  let changed = 0;
  let unchanged = 0;
  const problems: string[] = [];

  for (const asset of jars) {
    if (!asset.digest) {
      problems.push(`${asset.name}: release asset has no digest`);
      continue;
    }
    const [algo, hex] = asset.digest.split(':');
    if (algo !== 'sha256' || !hex) {
      problems.push(`${asset.name}: unexpected digest format "${asset.digest}"`);
      continue;
    }

    // Match on the metafile whose current filename or name-stem corresponds to this
    // asset. Falling back to the stem lets a jar be renamed without losing its home.
    const stem = asset.name.replace(/\.jar$/, '').replace(/-[0-9].*$/, '');
    let target: string | undefined;

    for (const f of metafiles) {
      const text = await readFile(join(modsDir, f), 'utf8');
      const filename = get(text, 'filename');
      if (filename === asset.name) { target = f; break; }
      if (f.replace(/\.pw\.toml$/, '') === stem.replace(/_/g, '-')) target = f;
    }

    if (!target) {
      problems.push(`${asset.name}: no pack/mods/*.pw.toml matches this asset`);
      continue;
    }

    const path = join(modsDir, target);
    let text = await readFile(path, 'utf8');

    const before = { filename: get(text, 'filename'), url: get(text, 'url'), hash: get(text, 'hash') };
    if (
      before.filename === asset.name &&
      before.url === asset.browser_download_url &&
      before.hash === hex &&
      get(text, 'hash-format') === 'sha256'
    ) {
      console.log(`  unchanged  ${target}`);
      unchanged++;
      continue;
    }

    text = set(text, 'filename', asset.name);
    text = set(text, 'url', asset.browser_download_url);
    text = set(text, 'hash-format', 'sha256');
    text = set(text, 'hash', hex);

    if (!check) await writeFile(path, text, 'utf8');
    console.log(`  ${check ? 'would update' : 'updated'}    ${target}  -> ${asset.name}  sha256:${hex.slice(0, 16)}…`);
    changed++;
  }

  console.log('');
  console.log(`${check ? 'would change' : 'changed'}: ${changed}   unchanged: ${unchanged}`);

  if (problems.length) {
    console.log('');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }

  if (check && changed > 0) {
    console.error('');
    console.error('metafiles are out of date with the release; re-run without --check');
    process.exit(1);
  }

  if (!check && changed > 0) {
    console.log('');
    console.log('next: node tools/build-index.ts && node tools/validate-pack.ts');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
