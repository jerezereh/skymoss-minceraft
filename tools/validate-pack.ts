/**
 * validate-pack — static checks over the packwiz manifest.
 *
 * Catches the classes of mistake that produce confusing runtime failures rather than
 * clean errors: a mod with no download URL (installs silently skip it), a bad side
 * value (packwiz-installer ignores the entry), a hash of the wrong length for its
 * algorithm, or an index that has drifted from the files on disk.
 *
 * Usage: node tools/validate-pack.ts [--pack pack]
 */

import { readdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const VALID_SIDES = new Set(['both', 'client', 'server']);
const HASH_LENGTHS: Record<string, number> = {
  sha512: 128,
  sha256: 64,
  sha1: 40,
  md5: 32,
};

/** Placeholder host used in hand-written metafiles until a real mirror exists. */
const PLACEHOLDER_HOST = 'mirror.skymoss.example';

interface Problem {
  file: string;
  level: 'error' | 'warn';
  message: string;
}

function get(text: string, key: string): string | undefined {
  const m = text.match(new RegExp(`^${key} = "(.*)"$`, 'm'));
  return m?.[1];
}

/**
 * Find files inside the pack tree that git is ignoring.
 *
 * These are the nastiest kind of drift: the pack works perfectly on the machine
 * that has the file, and is silently broken on any fresh clone — including the
 * server. `.gitignore` blanket-blocks `*.jar` repo-wide, so a stray jar in the
 * config tree is invisible until someone deploys from a clean checkout.
 */
function findIgnoredFiles(packDir: string): string[] {
  try {
    // -c lists ignored files; -o would also list untracked-but-not-ignored ones.
    const out = execFileSync(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--', packDir],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    // Not a git checkout, or git unavailable — skip rather than fail the run.
    return [];
  }
}

/**
 * Find pack files whose working-tree bytes differ from what is committed.
 *
 * index.toml pins a hash per file. If those hashes are computed from a working tree
 * that git has since transformed — the classic case being Windows `core.autocrlf=true`
 * rewriting LF to CRLF on checkout — then the index describes bytes nobody else will
 * ever see. Every consumer clones the committed version, every hash mismatches, and
 * packwiz aborts with "Hash invalid!" on file after file with no hint at the cause.
 *
 * Comparing against `git show :path` catches it at the source.
 */
function findContentDrift(packDir: string): string[] {
  let tracked: string[];
  try {
    tracked = execFileSync('git', ['ls-files', '--', packDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return []; // not a git checkout
  }

  // pack.toml and index.toml are this tool's own outputs and are not listed in the
  // index, so they are irrelevant here.
  const files = tracked.filter((f) => !f.endsWith('/pack.toml') && !f.endsWith('/index.toml'));
  if (!files.length) return [];

  // Hash each file twice: once as it sits on disk, once as git would store it after
  // running its clean filters. A difference means committing changes the bytes, so
  // any hash taken from the working tree describes content no other checkout will
  // ever have. Comparing against the *staged* blob instead would flag every ordinary
  // uncommitted edit, which is noise rather than signal.
  const hashBatch = (args: string[]): string[] =>
    execFileSync('git', args, {
      input: files.join('\n') + '\n',
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

  try {
    const filtered = hashBatch(['hash-object', '--stdin-paths']);
    const raw = hashBatch(['hash-object', '--no-filters', '--stdin-paths']);
    if (filtered.length !== files.length || raw.length !== files.length) return [];
    return files.filter((_, i) => filtered[i] !== raw[i]);
  } catch {
    return [];
  }
}

async function main() {
  const args = process.argv.slice(2);
  const packIdx = args.indexOf('--pack');
  const packDir = packIdx >= 0 ? args[packIdx + 1] : 'pack';
  const modsDir = join(packDir, 'mods');

  const files = (await readdir(modsDir)).filter((f) => f.endsWith('.pw.toml')).sort();
  const problems: Problem[] = [];
  const seenFilenames = new Map<string, string>();
  const sides = { both: 0, client: 0, server: 0 } as Record<string, number>;
  let placeholders = 0;

  for (const f of files) {
    const text = await readFile(join(modsDir, f), 'utf8');
    const name = get(text, 'name');
    const filename = get(text, 'filename');
    const side = get(text, 'side');
    const url = get(text, 'url');
    const hash = get(text, 'hash');
    const hashFormat = get(text, 'hash-format');

    if (!name) problems.push({ file: f, level: 'error', message: 'missing name' });

    if (!filename) {
      problems.push({ file: f, level: 'error', message: 'missing filename' });
    } else {
      // Two metafiles writing the same jar means one silently wins at install time.
      const prev = seenFilenames.get(filename);
      if (prev) {
        problems.push({ file: f, level: 'error', message: `duplicate filename, also in ${prev}` });
      }
      seenFilenames.set(filename, f);
      if (!filename.endsWith('.jar')) {
        problems.push({ file: f, level: 'warn', message: `filename is not a .jar: ${filename}` });
      }
    }

    if (!side) {
      problems.push({ file: f, level: 'error', message: 'missing side' });
    } else if (!VALID_SIDES.has(side)) {
      problems.push({ file: f, level: 'error', message: `invalid side "${side}"` });
    } else {
      sides[side]++;
    }

    // A metafile with no URL is not an error only if packwiz resolves it through a
    // CurseForge update block; anything else installs nothing at all.
    if (!url) {
      const hasCfUpdate = text.includes('[update.curseforge]');
      problems.push({
        file: f,
        level: hasCfUpdate ? 'warn' : 'error',
        message: hasCfUpdate
          ? 'no download url; relies on the CurseForge API (mirror this one)'
          : 'no download url and no update source — this mod will not install',
      });
    } else if (url.includes(PLACEHOLDER_HOST)) {
      placeholders++;
    } else if (!/^https:\/\//.test(url)) {
      problems.push({ file: f, level: 'error', message: `download url is not https: ${url}` });
    }

    if (!hash) {
      problems.push({ file: f, level: 'error', message: 'missing hash' });
    } else if (hashFormat) {
      const want = HASH_LENGTHS[hashFormat];
      if (!want) {
        problems.push({ file: f, level: 'error', message: `unknown hash-format "${hashFormat}"` });
      } else if (hash.length !== want) {
        problems.push({
          file: f,
          level: 'error',
          message: `hash length ${hash.length} does not match ${hashFormat} (expected ${want})`,
        });
      }
    }
  }

  // Files present locally but excluded from the repo would make a deploy from a
  // fresh clone behave differently from this machine.
  for (const f of findIgnoredFiles(packDir)) {
    problems.push({
      file: f,
      level: 'error',
      message: 'inside pack/ but gitignored — would be missing from a fresh clone',
    });
  }

  // Content drift means index.toml hashes bytes that only exist on this machine.
  const drifted = findContentDrift(packDir);
  if (drifted.length) {
    problems.push({
      file: drifted[0],
      level: 'error',
      message:
        `working-tree bytes differ from the committed version (${drifted.length} file(s)). ` +
        'index.toml pins hashes nobody else will see, so installs fail with "Hash invalid!". ' +
        'Usually Windows core.autocrlf; fix with: ' +
        'git config --local core.autocrlf false && git checkout -- . && node tools/build-index.ts',
    });
    for (const f of drifted.slice(1, 6)) {
      problems.push({ file: f, level: 'error', message: 'working-tree bytes differ from committed' });
    }
  }

  // --- report -------------------------------------------------------------
  console.log(`checked ${files.length} mod metafiles`);
  console.log(`  sides: both=${sides.both} client=${sides.client} server=${sides.server}`);

  if (placeholders > 0) {
    console.log('');
    console.log(`  ${placeholders} metafile(s) still point at the placeholder mirror host`);
    console.log(`  (${PLACEHOLDER_HOST}) — replace with your real mirror before release.`);
  }

  const errors = problems.filter((p) => p.level === 'error');
  const warns = problems.filter((p) => p.level === 'warn');

  if (warns.length) {
    console.log('');
    for (const p of warns) console.log(`  WARN  ${p.file}: ${p.message}`);
  }

  if (errors.length) {
    console.log('');
    for (const p of errors) console.error(`  ERROR ${p.file}: ${p.message}`);
    console.error(`\n${errors.length} error(s)`);
    process.exit(1);
  }

  console.log('\npack OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
