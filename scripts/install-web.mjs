/**
 * Install a built, immutable package into an existing dsh Web profile.
 *
 * Follows the same contract as the other workspace plugins: pack first, install
 * the archive (never a source link), verify what actually resolved on disk, and
 * leave a receipt so the install can be audited or undone. A source link would
 * make an in-progress edit change the running host.
 *
 * Usage:
 *   node scripts/install-web.mjs            # install or upgrade
 *   node scripts/install-web.mjs --dry-run  # print what would happen
 *   node scripts/install-web.mjs --offline  # reuse the local pnpm store
 */
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const dshBin = process.env.DSH_BIN || 'dsh';
const home = process.env.DSH_HOME || join(process.env.HOME ?? '.', '.dsh');
const profileName = process.env.DSH_PROFILE || 'web';
const profile = await realpath(join(home, 'profiles', profileName));
const manifestPath = join(profile, 'package.json');
const plugin = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

if (!(manifest.dsh?.profile?.bundles ?? []).includes('@deepseek-ai/dsh-web-app')) {
  throw new Error(`${manifestPath} is not a dsh Web profile; pass DSH_PROFILE to target another`);
}

// Refuse to install an unbuilt or stale bundle.
const client = await readFile(join(project, 'lib/client.js'), 'utf8').catch(() => '');
if (!client.includes('window.__ModuleLoader__.load(')) {
  throw new Error('lib/client.js is missing or unbuilt — run `node scripts/build.mjs` first');
}
if (!client.includes('@dsh/comfyui')) {
  throw new Error('lib/client.js was built for a different plugin id');
}

if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({
    profile,
    plugin: plugin.name,
    version: plugin.version,
    clientBytes: Buffer.byteLength(client),
    mode: 'packed archive (no source link)',
  }, null, 2));
  process.exit(0);
}

function run(command, args, options = {}) {
  // A read-only `~/.npm` (sandboxed host, immutable home) makes `npm pack` fail
  // before it reads a single file. Honour an explicit cache instead of requiring
  // the caller to mutate the environment of every invocation.
  const env = { ...process.env };
  if (!env.NPM_CONFIG_CACHE && process.env.DSH_COMFYUI_NPM_CACHE) {
    env.NPM_CONFIG_CACHE = process.env.DSH_COMFYUI_NPM_CACHE;
  }
  const result = spawnSync(command, args, { cwd: project, encoding: 'utf8', env, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr ?? ''}`);
  return result.stdout;
}

const artifacts = join(project, 'artifacts');
await mkdir(artifacts, { recursive: true });

// 1. Pack.
const packed = JSON.parse(run(process.env.NPM_BIN || 'npm', [
  'pack', '--json', '--ignore-scripts', '--pack-destination', artifacts,
]));
if (packed.length !== 1) throw new Error('expected exactly one package archive');
const archive = join(artifacts, packed[0].filename);
const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');

// 2. Cache the archive inside the profile so the dependency spec stays valid
//    even if the plugin directory moves or is cleaned.
const cache = join(profile, '.plugin-manager', 'packages');
await mkdir(cache, { recursive: true, mode: 0o700 });
const cachedArchive = join(cache, `comfyui-${plugin.version}-${sha256}.tgz`);
await copyFile(archive, cachedArchive);
const spec = `file:${cachedArchive}`;

// 3. Back up the profile before touching it.
const alreadyInstalled = manifest.dependencies?.[plugin.name] === spec;
let backup = null;
if (!alreadyInstalled) {
  backup = join(profile, '.plugin-manager', `comfyui-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(backup, { recursive: true, mode: 0o700 });
  const saved = [];
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'cordis.yml']) {
    try {
      await copyFile(join(profile, name), join(backup, name));
      saved.push(name);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await writeFile(join(backup, 'backup.json'), `${JSON.stringify({ profile, files: saved }, null, 2)}\n`, { mode: 0o600 });
  console.log(`backup: ${backup}`);

  // 4. Install through dsh so the lockfile stays consistent.
  //
  // `dsh plugin add` forwards its arguments to pnpm verbatim; it does NOT add
  // the package to `dsh.profile.bundles`. A dependency alone is not a bundle, so
  // the plugin would install and never load. The bundle selection is therefore
  // written here, and step 5 verifies it landed.
  run(dshBin, [
    'plugin', '--profile', profileName, 'add', '-w', spec, '--ignore-scripts',
    ...(process.argv.includes('--offline') ? ['--offline'] : []),
  ], { stdio: 'inherit' });

  await selectBundle(plugin.name);
}

/**
 * Append the bundle to `dsh.profile.bundles` when it is not already selected.
 *
 * This mirrors what `PluginManager.installBundle()` does through `selectBundle`:
 * the list is ordered, so the bundle goes last, which also means its
 * configuration layer has the highest precedence among bundles.
 * @param {string} name package name.
 */
async function selectBundle(name) {
  const current = JSON.parse(await readFile(manifestPath, 'utf8'));
  const bundles = current.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) throw new Error(`${manifestPath} has no dsh.profile.bundles list`);
  if (bundles.includes(name)) return;
  current.dsh.profile.bundles = [...bundles, name];
  await writeFile(manifestPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  console.log(`bundle selected: ${name} (appended to dsh.profile.bundles)`);
}

// 5. Verify by reading back what dsh actually wrote.
const installed = JSON.parse(await readFile(manifestPath, 'utf8'));
const resolved = await realpath(join(profile, 'node_modules', ...plugin.name.split('/')));

function insideProfile(path) {
  const rel = relative(profile, path);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

if (installed.dependencies?.[plugin.name] !== spec) {
  throw new Error(`profile dependency mismatch: ${installed.dependencies?.[plugin.name]} !== ${spec}`);
}
if (!(installed.dsh?.profile?.bundles ?? []).includes(plugin.name)) {
  throw new Error('bundle not selected in the profile; the plugin would not load');
}
if (!insideProfile(resolved)) throw new Error(`plugin resolves outside the profile: ${resolved}`);

const receipt = {
  profile,
  plugin: plugin.name,
  version: plugin.version,
  sha256,
  archive: cachedArchive,
  backup,
  alreadyInstalled,
  verified: { manifest: true, bundleSelected: true, resolver: resolved },
  note: 'With HMR enabled (the default for a base-backed Web profile) the running host recomposes and the open page picks the plugin up; reload the page to load its client bundle. If HMR is off in this profile, restart dsh web instead. Disk verification does not prove browser activation.',
};
await writeFile(join(artifacts, 'dsh-install.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
