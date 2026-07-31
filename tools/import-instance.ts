/**
 * import-instance — reconstruct a packwiz manifest from a folder of loose mod jars.
 *
 * The Skymoss instance was never built from a manifest; it exists only as 244 jars in a
 * Modrinth App profile. This walks that folder and rebuilds the metadata:
 *
 *   1. hash every jar (sha512 for Modrinth, sha1 + murmur2 for CurseForge fallback)
 *   2. bulk-resolve hashes against Modrinth  POST /v2/version_files
 *   3. bulk-fetch the matched projects for slug + client_side/server_side
 *   4. resolve leftovers against CurseForge  POST /v1/fingerprints  (needs CURSEFORGE_API_KEY)
 *   5. emit pack/mods/<slug>.pw.toml, hash-pinned, with `side` derived from project metadata
 *
 * Anything still unresolved is reported at the end and needs a hand-written metafile
 * pointing at the mirror — see docs/pack-workflow.md.
 *
 * Usage:
 *   node tools/import-instance.ts --mods <dir> [--out pack/mods] [--report tools/import-report.json]
 *                                 [--concurrency 8] [--dry-run]
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';

const MODRINTH_API = 'https://api.modrinth.com/v2';
const CURSEFORGE_API = 'https://api.curseforge.com/v1';
const USER_AGENT = 'jerezereh/skymoss-minceraft/import-instance (github.com/jerezereh/skymoss-minceraft)';

// Modrinth's documented batch ceiling for these endpoints.
const HASH_BATCH = 100;
const PROJECT_BATCH = 100;

type Side = 'both' | 'client' | 'server';

interface JarInfo {
  path: string;
  filename: string;
  size: number;
  sha512: string;
  sha1: string;
  murmur2: number;
}

interface Resolved {
  filename: string;
  name: string;
  slug: string;
  side: Side;
  url: string;
  hashFormat: 'sha512' | 'sha1';
  hash: string;
  source: 'modrinth' | 'curseforge';
  projectId: string;
  versionId: string;
  /** Set when side had to be guessed rather than read from project metadata. */
  sideInferred?: boolean;
}

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// hashing
// ---------------------------------------------------------------------------

/**
 * CurseForge fingerprint: murmur2 (seed 1) over the file with whitespace bytes
 * (tab, LF, CR, space) removed. This normalization is CurseForge-specific and the
 * fingerprint will not match without it.
 */
function murmur2(input: Buffer): number {
  const data = Buffer.alloc(input.length);
  let len = 0;
  for (let i = 0; i < input.length; i++) {
    const b = input[i];
    if (b === 9 || b === 10 || b === 13 || b === 32) continue;
    data[len++] = b;
  }

  const m = 0x5bd1e995;
  const r = 24;
  let h = (1 ^ len) >>> 0;
  let i = 0;

  while (len - i >= 4) {
    let k = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
    k = Math.imul(k, m) >>> 0;
    k = (k ^ (k >>> r)) >>> 0;
    k = Math.imul(k, m) >>> 0;
    h = Math.imul(h, m) >>> 0;
    h = (h ^ k) >>> 0;
    i += 4;
  }

  const rem = len - i;
  if (rem === 3) h = (h ^ (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16))) >>> 0;
  else if (rem === 2) h = (h ^ (data[i] | (data[i + 1] << 8))) >>> 0;
  else if (rem === 1) h = (h ^ data[i]) >>> 0;
  if (rem > 0) h = Math.imul(h, m) >>> 0;

  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, m) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h >>> 0;
}

async function hashJar(path: string): Promise<JarInfo> {
  const buf = await readFile(path);
  return {
    path,
    filename: basename(path),
    size: buf.length,
    sha512: createHash('sha512').update(buf).digest('hex'),
    sha1: createHash('sha1').update(buf).digest('hex'),
    murmur2: murmur2(buf),
  };
}

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

async function api(
  url: string,
  init: RequestInit = {},
  attempt = 0,
): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) },
  });

  // Modrinth rate-limits at 300/min and returns the reset window in a header.
  if (res.status === 429 && attempt < 5) {
    const wait = Number(res.headers.get('x-ratelimit-reset') ?? 10) * 1000;
    console.warn(`  rate limited, waiting ${wait / 1000}s…`);
    await new Promise((r) => setTimeout(r, wait));
    return api(url, init, attempt + 1);
  }
  if (res.status >= 500 && attempt < 3) {
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    return api(url, init, attempt + 1);
  }
  return res;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// side derivation
// ---------------------------------------------------------------------------

/**
 * Modrinth reports client_side/server_side as required|optional|unsupported|unknown.
 * A mod is single-sided only when the other side is explicitly unsupported; anything
 * else stays `both`, which is the safe default (an unused mod on the wrong side is
 * usually inert, a missing mod on the right side is a hard failure).
 */
function deriveSide(clientSide: string, serverSide: string): { side: Side; inferred: boolean } {
  const c = (clientSide || 'unknown').toLowerCase();
  const s = (serverSide || 'unknown').toLowerCase();

  if (s === 'unsupported' && c !== 'unsupported') return { side: 'client', inferred: false };
  if (c === 'unsupported' && s !== 'unsupported') return { side: 'server', inferred: false };
  if (c === 'unknown' || s === 'unknown') return { side: 'both', inferred: true };
  return { side: 'both', inferred: false };
}

// ---------------------------------------------------------------------------
// resolvers
// ---------------------------------------------------------------------------

async function resolveModrinth(jars: JarInfo[]): Promise<{ resolved: Resolved[]; unresolved: JarInfo[] }> {
  const byHash = new Map(jars.map((j) => [j.sha512, j]));
  const versionByHash = new Map<string, any>();

  for (const [i, batch] of chunk([...byHash.keys()], HASH_BATCH).entries()) {
    console.log(`  modrinth: hash batch ${i + 1} (${batch.length})`);
    const res = await api(`${MODRINTH_API}/version_files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes: batch, algorithm: 'sha512' }),
    });
    if (!res.ok) {
      console.warn(`  modrinth version_files failed: ${res.status} ${await res.text()}`);
      continue;
    }
    const data = (await res.json()) as Record<string, any>;
    for (const [hash, version] of Object.entries(data)) versionByHash.set(hash, version);
  }

  // Fetch project metadata in bulk — this is where side info lives.
  const projectIds = [...new Set([...versionByHash.values()].map((v) => v.project_id))];
  const projects = new Map<string, any>();
  for (const [i, batch] of chunk(projectIds, PROJECT_BATCH).entries()) {
    console.log(`  modrinth: project batch ${i + 1} (${batch.length})`);
    const res = await api(`${MODRINTH_API}/projects?ids=${encodeURIComponent(JSON.stringify(batch))}`);
    if (!res.ok) {
      console.warn(`  modrinth projects failed: ${res.status}`);
      continue;
    }
    for (const p of (await res.json()) as any[]) projects.set(p.id, p);
  }

  const resolved: Resolved[] = [];
  const unresolved: JarInfo[] = [];

  for (const jar of jars) {
    const version = versionByHash.get(jar.sha512);
    if (!version) {
      unresolved.push(jar);
      continue;
    }
    const project = projects.get(version.project_id);
    // Match the exact file whose hash we looked up — versions can ship several files
    // (sources, javadoc, -dev jars) and picking files[0] silently grabs the wrong one.
    const file =
      version.files.find((f: any) => f.hashes?.sha512 === jar.sha512) ??
      version.files.find((f: any) => f.primary) ??
      version.files[0];

    const { side, inferred } = deriveSide(project?.client_side ?? '', project?.server_side ?? '');

    resolved.push({
      filename: jar.filename,
      name: project?.title ?? version.name ?? jar.filename,
      slug: project?.slug ?? version.project_id,
      side,
      sideInferred: inferred,
      url: file.url,
      hashFormat: 'sha512',
      hash: jar.sha512,
      source: 'modrinth',
      projectId: version.project_id,
      versionId: version.id,
    });
  }

  return { resolved, unresolved };
}

async function resolveCurseForge(jars: JarInfo[]): Promise<{ resolved: Resolved[]; unresolved: JarInfo[] }> {
  const key = process.env.CURSEFORGE_API_KEY;
  if (!key) {
    console.log('  curseforge: CURSEFORGE_API_KEY not set, skipping');
    return { resolved: [], unresolved: jars };
  }

  const byFingerprint = new Map(jars.map((j) => [j.murmur2, j]));
  const res = await api(`${CURSEFORGE_API}/fingerprints`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ fingerprints: [...byFingerprint.keys()] }),
  });
  if (!res.ok) {
    console.warn(`  curseforge fingerprints failed: ${res.status} ${await res.text()}`);
    return { resolved: [], unresolved: jars };
  }

  const body = (await res.json()) as any;
  const matches: any[] = body?.data?.exactMatches ?? [];
  const resolved: Resolved[] = [];
  const matchedFingerprints = new Set<number>();

  // Pull mod records for names/slugs in one call.
  const modIds = [...new Set(matches.map((m) => m.id))];
  const mods = new Map<number, any>();
  if (modIds.length) {
    const mres = await api(`${CURSEFORGE_API}/mods`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ modIds }),
    });
    if (mres.ok) {
      for (const m of ((await mres.json()) as any)?.data ?? []) mods.set(m.id, m);
    }
  }

  for (const match of matches) {
    const jar = byFingerprint.get(match.file?.fileFingerprint);
    if (!jar) continue;
    matchedFingerprints.add(match.file.fileFingerprint);
    const mod = mods.get(match.id);

    // CurseForge exposes no reliable per-side metadata, so these all land as `both`
    // and get flagged for manual review by classify-sides.
    resolved.push({
      filename: jar.filename,
      name: mod?.name ?? jar.filename,
      slug: mod?.slug ?? String(match.id),
      side: 'both',
      sideInferred: true,
      // downloadUrl is null when the author disabled third-party downloads —
      // those must be served from our mirror instead.
      url: match.file?.downloadUrl ?? '',
      hashFormat: 'sha1',
      hash: jar.sha1,
      source: 'curseforge',
      projectId: String(match.id),
      versionId: String(match.file?.id ?? ''),
    });
  }

  const unresolved = jars.filter((j) => !matchedFingerprints.has(j.murmur2));
  return { resolved, unresolved };
}

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------

function tomlString(s: string): string {
  return JSON.stringify(s);
}

function renderMetafile(r: Resolved): string {
  const lines = [
    `name = ${tomlString(r.name)}`,
    `filename = ${tomlString(r.filename)}`,
    `side = ${tomlString(r.side)}`,
    '',
    '[download]',
    `url = ${tomlString(r.url)}`,
    `hash-format = ${tomlString(r.hashFormat)}`,
    `hash = ${tomlString(r.hash)}`,
    '',
    '[update]',
  ];

  if (r.source === 'modrinth') {
    lines.push('[update.modrinth]', `mod-id = ${tomlString(r.projectId)}`, `version = ${tomlString(r.versionId)}`);
  } else {
    lines.push(
      '[update.curseforge]',
      `file-id = ${r.versionId || 0}`,
      `project-id = ${r.projectId}`,
    );
  }

  return lines.join('\n') + '\n';
}

/** Two different mods can share a slug prefix; keep filenames unique and stable. */
function metafileName(r: Resolved, taken: Set<string>): string {
  let base = r.slug.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
  let name = `${base}.pw.toml`;
  let n = 2;
  while (taken.has(name)) name = `${base}-${n++}.pw.toml`;
  taken.add(name);
  return name;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const modsDir = String(args.mods ?? '');
  const outDir = String(args.out ?? 'pack/mods');
  const reportPath = String(args.report ?? 'tools/import-report.json');
  const dryRun = Boolean(args['dry-run']);

  if (!modsDir) {
    console.error('usage: node tools/import-instance.ts --mods <dir> [--out pack/mods] [--dry-run]');
    process.exit(1);
  }

  // Top-level jars only. `.connector` holds Fabric mods remapped by Sinytra Connector
  // at runtime — they are regenerated on launch and are not pack inputs.
  const entries = await readdir(modsDir, { withFileTypes: true });
  const jarPaths = entries
    .filter((e) => e.isFile() && e.name.endsWith('.jar'))
    .map((e) => join(modsDir, e.name))
    .sort();

  console.log(`hashing ${jarPaths.length} jars…`);
  const jars: JarInfo[] = [];
  for (const p of jarPaths) jars.push(await hashJar(p));

  console.log('resolving against modrinth…');
  const mr = await resolveModrinth(jars);
  console.log(`  matched ${mr.resolved.length}, ${mr.unresolved.length} left`);

  console.log('resolving remainder against curseforge…');
  const cf = await resolveCurseForge(mr.unresolved);
  console.log(`  matched ${cf.resolved.length}, ${cf.unresolved.length} unresolved`);

  const resolved = [...mr.resolved, ...cf.resolved];

  if (!dryRun) {
    await mkdir(outDir, { recursive: true });
    const taken = new Set<string>();
    for (const r of resolved) {
      await writeFile(join(outDir, metafileName(r, taken)), renderMetafile(r), 'utf8');
    }
  }

  const bySide = { both: 0, client: 0, server: 0 } as Record<Side, number>;
  for (const r of resolved) bySide[r.side]++;

  const noUrl = resolved.filter((r) => !r.url);
  const report = {
    generatedFrom: modsDir,
    totalJars: jars.length,
    resolvedModrinth: mr.resolved.length,
    resolvedCurseForge: cf.resolved.length,
    unresolved: cf.unresolved.map((j) => ({ filename: j.filename, sha512: j.sha512, sha1: j.sha1, murmur2: j.murmur2 })),
    needsMirror: noUrl.map((r) => r.filename),
    sideInferred: resolved.filter((r) => r.sideInferred).map((r) => r.filename),
    bySide,
  };

  if (!dryRun) {
    await mkdir(join(reportPath, '..'), { recursive: true }).catch(() => {});
    await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  }

  console.log('');
  console.log(`resolved ${resolved.length}/${jars.length}`);
  console.log(`  sides: both=${bySide.both} client=${bySide.client} server=${bySide.server}`);
  console.log(`  side inferred (needs review): ${report.sideInferred.length}`);
  console.log(`  needs mirror (no download url): ${noUrl.length}`);
  console.log(`  UNRESOLVED (hand-write metafile): ${cf.unresolved.length}`);
  for (const j of cf.unresolved) console.log(`    - ${j.filename}`);
  if (!dryRun) console.log(`\nreport: ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
