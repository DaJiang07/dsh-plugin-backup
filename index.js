/**
 * Host half of the plugins & settings backup bundle.
 *
 * One authenticated Web route under `/dsh-plugin-backup` carries the whole
 * feature. It reads this profile's plugin bundle selection, the profile patch
 * layer (`cordis.patch.yml`, which holds every setting and every plugin
 * on/off choice) and the user settings document into one portable JSON
 * snapshot, and writes them back on restore. With the package switch on, the
 * snapshot also carries each local (`link:`/`file:`) plugin's source tree and
 * the plugin-owned state under the harness home, so a backup can rebuild a
 * machine and not only its configuration.
 *
 * The file work stays on the Host so a snapshot never depends on the browser's
 * filesystem, and the route reuses `ctx.connection`'s Host/Origin and
 * browser-auth checks so only the page that already owns this Host can call it.
 *
 * A restore never removes anything: plugin bundles this computer has and the
 * snapshot does not are reported, not deselected. Network bundles are returned
 * to the caller instead of installed here, because a package install is slow
 * and long-running; the page installs them one request at a time. Local plugin
 * sources are restored in place, because that work is a file write.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** Prefix the Client half fetches; the route matches this path and everything below it. */
const ROUTE = '/dsh-plugin-backup'
/** Snapshot envelope identity, so a foreign JSON file is refused before it touches a profile. */
const SNAPSHOT_FORMAT = 'dsh-plugin-backup'
/** Envelope version this Host writes. */
const SNAPSHOT_VERSION = 2
/** Envelope versions this Host can read; version 1 carries configuration only. */
const READABLE_VERSIONS = new Set([1, 2])
/** Profile patch layer, relative to the profile directory. */
const PATCH_FILENAME = 'cordis.patch.yml'
/** User settings document, relative to the harness home. */
const SETTINGS_FILENAME = 'settings.yaml'
/** Directory under the harness home that keeps every backup this plugin writes. */
const BACKUP_DIRNAME = 'plugin-backups'
/** Largest JSON body accepted: a configuration snapshot, which stays small. */
const MAX_BODY_BYTES = 64 * 1024 * 1024
/** Largest backup file accepted from a filesystem path, where a full package lives. */
const MAX_RESTORE_FILE_BYTES = 256 * 1024 * 1024
/** Largest patch layer accepted, independent of the body cap. */
const MAX_PATCH_BYTES = 1024 * 1024
/** Largest single packaged file; anything bigger is reported, never silently dropped. */
const MAX_FILE_BYTES = 8 * 1024 * 1024
/** Largest whole package: plugin sources plus plugin-owned state. */
const MAX_PACKAGE_BYTES = 96 * 1024 * 1024
/** Where an extracted local plugin lives when its original directory is gone. */
const SOURCE_DIRNAME = 'plugin-sources'
/** How many backups `status` reports. */
const BACKUP_LIST_LIMIT = 50
/** How many exported snapshots stay on disk; a full one can be ~100 MB. */
const EXPORTED_BACKUP_KEEP = 10

/** Directories a package walk never descends into: regenerable, huge, or another tool's cache. */
const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', '.hg', '.svn', '.yarn', '.pnpm-store', '__pycache__', BACKUP_DIRNAME,
])

/**
 * Harness-home entries that are plugin-owned state rather than conversation
 * history or secrets. `sessions`, `attachments`, `profiles` and
 * `.credentials.yaml` are never packaged.
 */
const HOME_DATA_ROOTS = [
  'settings.yaml', 'dream-skin.json', 'dsh-market', 'dshm', 'engram', 'synapse', 'storages', 'data', 'skills',
]

/** Profile-directory entries that are plugin state. */
const PROFILE_DATA_ROOTS = ['.dsh-market']

/** A failure the route answers with a status and a machine-readable code. */
class RouteError extends Error {
  /**
   * @param status - HTTP status to answer with.
   * @param code - stable code the Client half can key localized text on.
   * @param message - diagnostic for the operator.
   */
  constructor(status, code, message) {
    super(message)
    this.name = 'RouteError'
    this.status = status
    this.code = code
  }
}

/** @param {unknown} error @returns {string} the diagnostic, for non-Error throws too. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {unknown} value @returns {boolean} whether the value is a plain object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @returns {string} the harness home, honouring the launcher's `DSH_HOME`. */
function dshHome() {
  const configured = process.env.DSH_HOME?.trim()
  if (configured !== undefined && configured !== '') return resolve(configured)
  return join(homedir(), '.dsh')
}

/** @returns {string} where every backup this plugin writes is kept. */
function backupsDirectory() {
  return join(dshHome(), BACKUP_DIRNAME)
}

/**
 * The profile this Host process booted, resolved from the launcher's own
 * facts first and from the standard home layout last — a candidate is only
 * accepted when its manifest is actually there.
 * @param {any} ctx - Host context that may carry `profileContext`.
 * @returns {string} absolute profile directory.
 * @throws {RouteError} when no candidate holds a profile manifest.
 */
export function profileDirectory(ctx) {
  const context = ctx?.get?.('profileContext')
  const candidates = []
  if (typeof context?.dir === 'string' && context.dir.trim() !== '') candidates.push(context.dir)
  const envDir = process.env.DSH_PROFILE_DIR?.trim()
  if (envDir !== undefined && envDir !== '') candidates.push(envDir)
  const name = typeof context?.name === 'string' && context.name.trim() !== ''
    ? context.name
    : process.env.DSH_PROFILE?.trim()
  if (name !== undefined && name !== '') candidates.push(join(dshHome(), 'profiles', name))
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return resolve(candidate)
  }
  throw new RouteError(500, 'no-profile', 'this Host process runs no profile directory, so a backup has nothing to read')
}

/** @param {string} path @returns {Promise<string | null>} the file text, or null when it is not there. */
async function readTextIfPresent(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    // Only an absent file is a normal answer; a permission or encoding failure is not.
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** @param {string} path @param {number} bytes @returns {Promise<string>} the first bytes of the file, for cheap metadata reads. */
async function readHead(path, bytes) {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Replace one file in a single step, so the Loader's watcher never reads a
 * half-written patch layer.
 * @param {string} path - destination file.
 * @param {string | Uint8Array} content - new content.
 */
async function writeAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${String(process.pid)}-${String(Date.now())}`
  await writeFile(temporary, content)
  try {
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** @returns {string} a filesystem-safe UTC timestamp. */
function stamp() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
}

/** @param {string} path @returns {number} the file size, or 0 when it is not there. */
function sizeOf(path) {
  try {
    return existsSync(path) ? statSync(path).size : 0
  } catch {
    return 0
  }
}

/**
 * Read the profile manifest as far as a backup cares about it.
 * @param {string} directory - absolute profile directory.
 * @returns {Promise<{bundles: string[], patchReload: string | undefined, dependencies: Record<string, string>}>} selection and recorded dependencies.
 */
async function readProfileManifest(directory) {
  const raw = (await readTextIfPresent(join(directory, 'package.json'))) ?? '{}'
  let parsed = {}
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A manifest the profile manager cannot read is still a profile; report it as empty.
    parsed = {}
  }
  const profile = isRecord(parsed?.dsh?.profile) ? parsed.dsh.profile : {}
  const dependencies = {}
  if (isRecord(parsed?.dependencies)) {
    for (const [name, spec] of Object.entries(parsed.dependencies)) {
      if (typeof spec === 'string') dependencies[name] = spec
    }
  }
  return {
    bundles: Array.isArray(profile.bundles) ? profile.bundles.filter(name => typeof name === 'string') : [],
    patchReload: typeof profile.patchReload === 'string' ? profile.patchReload : undefined,
    dependencies,
  }
}

/**
 * The directory a package occupies inside a profile.
 * @param {string} directory - absolute profile directory.
 * @param {string} name - package name, scope and all.
 * @returns {string} the package directory.
 */
function packageDirectory(directory, name) {
  return join(directory, 'node_modules', ...name.split('/'))
}

/**
 * Whether a package the backup asks for is actually on disk with a manifest.
 * A bare name in `dependencies` proves intent, not an installed copy.
 * @param {string} directory - absolute profile directory.
 * @param {string} name - package name.
 * @returns {boolean} true when the package's manifest is readable.
 */
function packageInstalled(directory, name) {
  return existsSync(join(packageDirectory(directory, name), 'package.json'))
}

/** This plugin's own package name, read from its manifest beside this module. */
const OWN_PACKAGE = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))?.name ?? null
  } catch {
    return null
  }
})()

/**
 * Record a package as a profile bundle, the same two facts the plugin manager
 * writes after a successful install: the dependency and the bundle selection.
 * @param {string} directory - absolute profile directory.
 * @param {string} name - package name.
 * @param {string} spec - the spec the package was installed from.
 */
async function recordBundle(directory, name, spec) {
  const filename = join(directory, 'package.json')
  const raw = await readTextIfPresent(filename)
  let manifest
  try {
    manifest = raw === null ? {} : JSON.parse(raw)
  } catch (error) {
    throw new RouteError(500, 'manifest-unreadable', `the profile manifest is not valid JSON: ${messageOf(error)}`)
  }
  const dependencies = isRecord(manifest.dependencies) ? { ...manifest.dependencies } : {}
  dependencies[name] = dependencies[name] ?? spec
  const profile = isRecord(manifest.dsh?.profile) ? { ...manifest.dsh.profile } : {}
  const bundles = Array.isArray(profile.bundles) ? [...profile.bundles] : []
  if (!bundles.includes(name)) bundles.push(name)
  const next = { ...manifest, dependencies, dsh: { ...manifest.dsh, profile: { ...profile, bundles } } }
  await writeAtomic(filename, `${JSON.stringify(next, null, 2)}\n`)
}

/**
 * Run one `pnpm add` in the profile, as a fallback for compositions that carry
 * no plugin manager service. Output is captured so a registry refusal reaches
 * the operator instead of only the console.
 * @param {string} directory - absolute profile directory.
 * @param {string} spec - package spec to add.
 * @param {{command?: string, args?: string[]}} [packageManager] - the launcher's own package-manager invocation, when it supplies one.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} the finished process.
 */
function runPnpmAdd(directory, spec, packageManager) {
  return new Promise((settle) => {
    const args = ['add', spec, '--reporter=append-only']
    const options = { cwd: directory, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    // A spec that reaches a shell could carry shell syntax; only the plain
    // package forms this restore produces are allowed through that path.
    const shellSafe = !/["&|<>^%]/u.test(spec)
    let child
    try {
      if (typeof packageManager?.command === 'string' && packageManager.command !== '') {
        // The launcher names the exact executable (and its leading arguments),
        // so this runs without a shell on every platform.
        const prefix = Array.isArray(packageManager.args) ? packageManager.args : []
        child = spawn(packageManager.command, [...prefix, ...args], options)
      } else if (process.platform === 'win32') {
        // A `.cmd` shim is only reachable through the shell, which takes the
        // whole line as one string.
        if (!shellSafe) {
          settle({ code: -1, stdout: '', stderr: `refusing to hand "${spec}" to a shell` })
          return
        }
        child = spawn(['pnpm', ...args].join(' '), { ...options, shell: true })
      } else {
        child = spawn('pnpm', args, options)
      }
    } catch (error) {
      settle({ code: -1, stdout: '', stderr: messageOf(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => settle({ code: -1, stdout, stderr: `${stderr}${messageOf(error)}` }))
    child.on('close', (code) => settle({ code: code ?? -1, stdout, stderr }))
  })
}

/**
 * The install outcome for one spec, in the shape the report renders.
 * @param {string} spec - the spec that was attempted.
 * @param {Partial<{bundle: string, version: string, application: string, error: any, pendingBuilds: string[], via: string}>} fields - outcome fields.
 * @returns {any} one report row.
 */
function installOutcome(spec, fields) {
  return {
    spec,
    ok: fields.application !== 'failed',
    application: fields.application ?? null,
    bundle: fields.bundle ?? null,
    version: fields.version ?? null,
    via: fields.via ?? null,
    pendingBuilds: Array.isArray(fields.pendingBuilds) ? fields.pendingBuilds : [],
    error: fields.error ?? null,
    message: fields.error?.diagnostic ?? fields.error?.code ?? fields.error?.message ?? null,
  }
}

/**
 * The package a spec names without asking the registry: a registry spec's own
 * name, or the manifest name of a local directory.
 * @param {string} spec - install spec.
 * @returns {string | null} the package name, or null when only an install tells it.
 */
function specPackageName(spec) {
  const local = localPluginPath(process.cwd(), spec)
  if (local !== undefined) {
    try {
      return JSON.parse(readFileSync(join(local, 'package.json'), 'utf8'))?.name ?? null
    } catch {
      return null
    }
  }
  if (/^(?:git\+|git@|github:|gitlab:|bitbucket:|gist:|https?:)/iu.test(spec)) return null
  const at = spec.indexOf('@', 1)
  return at === -1 ? spec : spec.slice(0, at)
}

/**
 * Install one package into this profile: through the plugin manager when the
 * composition supplies it, otherwise with `pnpm add` plus the manifest edit the
 * manager would have made. A manager failure falls back rather than aborting.
 * @param {any} ctx - Host context.
 * @param {string} spec - package spec from the snapshot.
 * @returns {Promise<any>} the install outcome.
 */
export async function installBundleSpec(ctx, spec) {
  const target = spec.trim()
  const directory = profileDirectory(ctx)
  const manager = ctx?.get?.('pluginManager')
  let managerProblem = null
  if (manager !== undefined) {
    try {
      const result = await manager.installBundle(target)
      if (result?.application !== 'failed') {
        return installOutcome(target, {
          bundle: result?.bundle ?? null,
          version: result?.version ?? null,
          application: result?.application ?? 'applied',
          pendingBuilds: result?.pendingBuilds ?? [],
          via: 'plugin-manager',
        })
      }
      managerProblem = result?.error?.diagnostic ?? result?.error?.code ?? 'the plugin manager refused the install'
    } catch (error) {
      managerProblem = messageOf(error)
    }
  }

  const name = specPackageName(target)
  if (name === null) {
    return installOutcome(target, {
      application: 'failed',
      error: {
        code: managerProblem === null ? 'unsupported-spec' : 'manager-failed',
        diagnostic: managerProblem ?? `cannot tell which package "${target}" names`,
      },
    })
  }
  const ran = await runPnpmAdd(directory, target, ctx?.get?.('profileContext')?.packageManager)
  if (ran.code !== 0 || !packageInstalled(directory, name)) {
    const tail = `${ran.stderr}\n${ran.stdout}`.trim().split('\n').slice(-6).join('\n')
    return installOutcome(target, {
      application: 'failed',
      error: {
        code: 'install-failed',
        diagnostic: [managerProblem === null ? '' : `plugin manager: ${managerProblem}`, tail].filter(Boolean).join(' | ') || `pnpm exited with ${String(ran.code)}`,
      },
      via: 'pnpm',
    })
  }
  const manifest = JSON.parse(readFileSync(join(packageDirectory(directory, name), 'package.json'), 'utf8'))
  if (manifest?.dsh?.bundle === undefined) {
    return installOutcome(target, {
      application: 'failed',
      error: { code: 'not-a-bundle', diagnostic: `${name} declares no dsh.bundle, so it is not a profile layer` },
      via: 'pnpm',
    })
  }
  await recordBundle(directory, name, target)
  return installOutcome(target, {
    bundle: name,
    version: typeof manifest.version === 'string' ? manifest.version : null,
    application: 'applied',
    via: 'pnpm',
  })
}

/**
 * Turn a recorded dependency into an install spec, keeping local paths and
 * repository addresses exactly as recorded (they are not registry versions).
 * @param {string} name - package name.
 * @param {Record<string, string>} dependencies - the manifest's dependency map.
 * @returns {string} the spec a package install accepts.
 */
function installSpecOf(name, dependencies) {
  const recorded = dependencies[name]
  if (typeof recorded !== 'string' || recorded.trim() === '') return name
  const spec = recorded.trim()
  if (/^(?:file:|link:|git\+|git@|github:|gitlab:|bitbucket:|gist:|https?:)/iu.test(spec)) return spec
  if (isAbsolute(spec)) return spec
  return `${name}@${spec}`
}

/**
 * The directory a dependency lives in when it is a local copy rather than a
 * registry version.
 * @param {string} directory - absolute profile directory, the anchor for a relative path.
 * @param {string} spec - the recorded dependency spec.
 * @returns {string | undefined} the absolute directory, or none for a non-local spec.
 */
function localPluginPath(directory, spec) {
  if (typeof spec !== 'string') return undefined
  const value = spec.trim()
  if (value === '') return undefined
  const stripped = value.replace(/^(?:link|file):/u, '')
  if (stripped !== value) return isAbsolute(stripped) ? stripped : resolve(directory, stripped)
  if (/^(?:git\+|git@|github:|gitlab:|bitbucket:|gist:|https?:)/iu.test(value)) return undefined
  if (!isAbsolute(value)) return undefined
  return value
}

/** @param {any} ctx @returns {Promise<any[]>} plugin rows, or none when the manager is not composed. */
async function readPluginRows(ctx) {
  const manager = ctx?.get?.('pluginManager')
  if (manager === undefined) return []
  try {
    const rows = await manager.listPlugins()
    return rows.map((row) => ({
      patchId: typeof row.patchId === 'string' ? row.patchId : null,
      moduleName: typeof row.moduleName === 'string' ? row.moduleName : null,
      enabled: row.enabled !== false,
      readOnly: typeof row.readOnlyReason === 'string' ? row.readOnlyReason : null,
    }))
  } catch {
    // The inventory is a diagnostic part of the snapshot; its failure must not block a backup.
    return []
  }
}

/** @param {any} ctx @returns {Promise<any[]>} bundle rows, or none when the manager is not composed. */
async function readBundleRows(ctx) {
  const manager = ctx?.get?.('pluginManager')
  if (manager === undefined) return []
  try {
    return await manager.listBundles()
  } catch {
    // Same as {@link readPluginRows}: a missing list narrows the snapshot, never fails it.
    return []
  }
}

/** @param {string} value @returns {string} a directory-safe package name. */
function sanitizeName(value) {
  return value.replace(/[^A-Za-z0-9._-]+/gu, '_').replace(/^\.+/u, '_')
}

/**
 * Normalize a packaged path and refuse anything that could escape its root.
 * @param {string} value - the recorded path.
 * @returns {string} slash-separated relative path.
 * @throws {RouteError} for an absolute path, an empty path, or a `..` segment.
 */
function normalizeRelative(value) {
  const text = value.replaceAll('\\', '/').trim()
  const segments = text.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.includes('..') || isAbsolute(text)) {
    throw new RouteError(400, 'invalid-path', `the packaged path "${value}" is not a relative path inside its root`)
  }
  return segments.join('/')
}

/** @param {string} root @param {string} absolute @returns {string} the slash-separated path below the root. */
function relativeInside(root, absolute) {
  return relative(root, absolute).replaceAll('\\', '/')
}

/** @param {Buffer} buffer @returns {boolean} whether the bytes look like text, so the snapshot stays readable. */
function looksTextual(buffer) {
  return !buffer.subarray(0, 8192).includes(0)
}

/**
 * Walk one packaged root, reporting every file it cannot carry instead of
 * dropping it silently.
 * @param {string} root - absolute directory.
 * @param {(absolute: string, size: number) => Promise<void>} visit - receives each accepted file.
 * @param {{skip: (path: string, reason: string) => void, budget: () => number}} state - budget and skip sink.
 */
async function walkDirectory(root, visit, state) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const absolute = join(root, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) {
        state.skip(absolute, 'skipped-directory')
        continue
      }
      await walkDirectory(absolute, visit, state)
      continue
    }
    if (!entry.isFile()) continue
    const info = await stat(absolute)
    if (info.size > MAX_FILE_BYTES) {
      state.skip(absolute, 'file-too-large')
      continue
    }
    if (state.budget() + info.size > MAX_PACKAGE_BYTES) {
      state.skip(absolute, 'package-too-large')
      continue
    }
    await visit(absolute, info.size)
  }
}

/**
 * Read the roots a package switch would carry, without reading their files.
 * @param {any} ctx - Host context.
 * @returns {Promise<{roots: Array<{kind: string, label: string, path: string, package: string | null}>, excluded: string[]}>} what the switch adds and what it never touches.
 */
export async function describePackageRoots(ctx) {
  const directory = profileDirectory(ctx)
  const manifest = await readProfileManifest(directory)
  const roots = []
  for (const [name, spec] of Object.entries(manifest.dependencies)) {
    const path = localPluginPath(directory, spec)
    if (path !== undefined) {
      roots.push({ kind: 'plugin-source', label: name, path, package: name, present: existsSync(path) })
    }
  }
  for (const name of HOME_DATA_ROOTS) {
    const path = join(dshHome(), name)
    if (existsSync(path)) roots.push({ kind: 'home-data', label: name, path, package: null, present: true })
  }
  for (const name of PROFILE_DATA_ROOTS) {
    const path = join(directory, name)
    if (existsSync(path)) roots.push({ kind: 'profile-data', label: name, path, package: null, present: true })
  }
  return {
    roots,
    excluded: ['.credentials.yaml', 'sessions', 'attachments', 'profiles', 'plugin-backups', 'node_modules', '.git'],
  }
}

/**
 * Package local plugin sources and plugin-owned state.
 * @param {any} ctx - Host context.
 * @returns {Promise<{roots: any[], files: any[], skipped: any[], bytes: number}>} the package a restore can replay.
 */
async function collectPackage(ctx) {
  const described = await describePackageRoots(ctx)
  const roots = described.roots.filter(root => root.present)
  const files = []
  const skipped = []
  let bytes = 0
  for (const root of roots) {
    const info = await stat(root.path)
    if (info.isFile()) {
      if (info.size > MAX_FILE_BYTES) {
        skipped.push({ path: root.path, reason: 'file-too-large' })
        continue
      }
      files.push(await fileEntry(root, root.path, root.label, info.size))
      bytes += info.size
      continue
    }
    await walkDirectory(root.path, async (absolute, size) => {
      const inside = relativeInside(root.path, absolute)
      const storedPath = root.kind === 'plugin-source' ? inside : `${root.label}/${inside}`
      files.push(await fileEntry(root, absolute, storedPath, size))
      bytes += size
    }, {
      skip: (path, reason) => { skipped.push({ path, reason }) },
      budget: () => bytes,
    })
  }
  return {
    roots: roots.map(root => ({ kind: root.kind, label: root.label, package: root.package, path: root.path })),
    files,
    skipped,
    bytes,
  }
}

/**
 * One packaged file, as text when it reads as text and base64 otherwise.
 * @param {any} root - the root this file came from.
 * @param {string} absolute - the file on disk.
 * @param {string} storedPath - path recorded in the package.
 * @param {number} size - size on disk.
 * @returns {Promise<any>} the file entry.
 */
async function fileEntry(root, absolute, storedPath, size) {
  const buffer = await readFile(absolute)
  const text = looksTextual(buffer) ? buffer.toString('utf8') : null
  return {
    group: root.kind,
    ...root.kind === 'plugin-source' ? { package: root.label } : {},
    path: storedPath,
    bytes: size,
    ...text === null ? { data: buffer.toString('base64') } : { text },
  }
}

/**
 * Write a package back: local plugin sources first (linking what this profile
 * does not already have), then plugin-owned state, with every overwritten root
 * moved aside beforehand.
 * @param {any} ctx - Host context.
 * @param {any} pkg - the validated package.
 * @param {{safetyDir: string | null}} options - where displaced roots go.
 * @returns {Promise<any>} the package part of the restore report.
 */
async function restorePackage(ctx, pkg, options) {
  const directory = profileDirectory(ctx)
  const home = dshHome()
  const manager = ctx?.get?.('pluginManager')
  const manifest = await readProfileManifest(directory)
  const failures = []
  const moved = []
  const sources = []
  const skipped = []

  // Local plugin sources land back where they were when that directory still
  // exists; otherwise they are extracted under the harness home and linked from there.
  const targets = new Map()
  for (const file of pkg.files) {
    if (file.group !== 'plugin-source' || file.package === null) continue
    if (targets.has(file.package)) continue
    const recorded = pkg.roots.find(root => root.kind === 'plugin-source' && root.package === file.package)
    const recordedPath = typeof recorded?.path === 'string' ? recorded.path : ''
    const target = recordedPath !== '' && existsSync(recordedPath)
      ? recordedPath
      : join(home, SOURCE_DIRNAME, sanitizeName(file.package))
    targets.set(file.package, target)
  }

  for (const file of pkg.files) {
    if (file.group !== 'plugin-source') continue
    if (file.package === null) {
      skipped.push({ path: file.path, reason: 'no-package' })
      continue
    }
    const target = targets.get(file.package)
    if (target === undefined) {
      skipped.push({ path: file.path, reason: 'no-target' })
      continue
    }
    // A backup can carry this plugin's own source (it is a local plugin like
    // any other). Writing those bytes back would replace the code that is
    // running — and every fix it carries — with the copy taken at backup time.
    if (OWN_PACKAGE !== null && file.package === OWN_PACKAGE) {
      skipped.push({ path: file.path, reason: 'own-source' })
      continue
    }
    try {
      await writeFileContent(join(target, ...file.path.split('/')), file, skipped)
    } catch (error) {
      failures.push({ target: file.path, code: 'write-failed', message: messageOf(error) })
    }
  }

  for (const [name, target] of targets) {
    const present = Object.hasOwn(manifest.dependencies, name)
    if (present) {
      sources.push({ package: name, target, action: 'kept' })
      continue
    }
    if (manager === undefined) {
      failures.push({ target: name, code: 'no-plugin-manager', message: 'this profile composes no plugin manager' })
      continue
    }
    try {
      const result = await manager.installBundle(target.replaceAll('\\', '/'))
      const failed = result?.application === 'failed'
      sources.push({
        package: name,
        target,
        action: failed ? 'failed' : 'linked',
        ...failed ? { error: result.error?.diagnostic ?? result.error?.code ?? null } : {},
      })
      if (failed) {
        failures.push({ target: name, code: result.error?.code ?? 'link-failed', message: 'this profile could not link the restored source' })
      }
    } catch (error) {
      sources.push({ package: name, target, action: 'failed', error: messageOf(error) })
      failures.push({ target: name, code: 'operation-error', message: messageOf(error) })
    }
  }

  const groups = new Map()
  for (const file of pkg.files) {
    if (file.group === 'plugin-source') continue
    const [rootName] = file.path.split('/')
    const key = `${file.group}:${rootName}`
    const entry = groups.get(key) ?? { group: file.group, root: rootName, files: 0, bytes: 0 }
    entry.files += 1
    entry.bytes += file.bytes ?? 0
    groups.set(key, entry)
  }
  // Displace each data root before its files land, so new content never sits on
  // top of old content that could still have been saved.
  for (const entry of groups.values()) {
    const target = entry.group === 'home-data' ? join(home, entry.root) : join(directory, entry.root)
    if (!existsSync(target) || options.safetyDir === null) continue
    const destination = join(options.safetyDir, `${entry.group}-${entry.root}`)
    try {
      await mkdir(options.safetyDir, { recursive: true })
      await rename(target, destination)
      moved.push({ from: target, to: destination })
    } catch (error) {
      failures.push({ target, code: 'safety-move-failed', message: messageOf(error) })
    }
  }
  for (const file of pkg.files) {
    if (file.group === 'plugin-source') continue
    const [rootName, ...rest] = file.path.split('/')
    const rootPath = file.group === 'home-data' ? join(home, rootName) : join(directory, rootName)
    // A root that is one file records its own name as the whole path.
    const target = rest.length === 0 ? rootPath : join(rootPath, ...rest)
    try {
      await writeFileContent(target, file, skipped)
    } catch (error) {
      failures.push({ target: file.path, code: 'write-failed', message: messageOf(error) })
    }
  }

  return { sources, data: [...groups.values()], moved, skipped: skipped.length, failures }
}

/**
 * Write one packaged file entry.
 * @param {string} path - destination.
 * @param {any} file - the entry.
 * @param {any[]} skipped - sink for entries that could not be decoded.
 */
async function writeFileContent(path, file, skipped) {
  if (typeof file.text === 'string') {
    await writeAtomic(path, file.text)
    return
  }
  if (typeof file.data !== 'string') {
    skipped.push({ path: file.path, reason: 'no-content' })
    return
  }
  await writeAtomic(path, Buffer.from(file.data, 'base64'))
}

/**
 * Read this profile into a portable snapshot.
 * @param {any} ctx - Host context.
 * @param {{package?: boolean}} [options] - `package: true` also carries plugin sources and plugin state.
 * @returns {Promise<any>} the snapshot envelope the page downloads.
 */
export async function collectSnapshot(ctx, options = {}) {
  const directory = profileDirectory(ctx)
  const patchPath = join(directory, PATCH_FILENAME)
  const settingsPath = join(dshHome(), SETTINGS_FILENAME)
  const patchText = (await readTextIfPresent(patchPath)) ?? ''
  const settingsText = await readTextIfPresent(settingsPath)
  const manifest = await readProfileManifest(directory)
  const plugins = await readPluginRows(ctx)
  const bundleRows = await readBundleRows(ctx)
  const pkg = options.package === true ? await collectPackage(ctx) : null
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    createdAt: new Date().toISOString(),
    runtime: {
      platform: process.platform,
      node: process.versions.node,
      patchReload: manifest.patchReload ?? null,
    },
    profile: { name: basename(directory), directory },
    patchFile: { filename: PATCH_FILENAME, text: patchText, bytes: Buffer.byteLength(patchText) },
    settingsFile: settingsText === null
      ? { filename: SETTINGS_FILENAME, present: false }
      : { filename: SETTINGS_FILENAME, present: true, text: settingsText, bytes: Buffer.byteLength(settingsText) },
    profileManifest: { bundles: manifest.bundles, dependencies: manifest.dependencies },
    plugins,
    bundles: bundleRows
      .filter(row => typeof row?.name === 'string' && row.name !== '')
      .map(row => ({
        name: row.name,
        enabled: row.enabled === true,
        installed: row.installed === true,
        version: typeof row.version === 'string' ? row.version : null,
        spec: installSpecOf(row.name, manifest.dependencies),
      })),
    ...pkg === null ? {} : { package: pkg },
  }
}

/**
 * Validate a snapshot that arrived from a file or from an earlier export.
 * @param {unknown} value - parsed JSON.
 * @returns {{patchText: string, settingsText: string | null, createdAt: string | null, bundles: Array<{name: string, spec: string}>, package: any | null}} the parts a restore applies.
 * @throws {RouteError} for anything this Host cannot safely write.
 */
export function readSnapshot(value) {
  if (!isRecord(value)) throw new RouteError(400, 'invalid-snapshot', 'the backup is not a JSON object')
  if (value.format !== SNAPSHOT_FORMAT) {
    throw new RouteError(400, 'foreign-snapshot', 'this file was not produced by the plugins & settings backup plugin')
  }
  if (!READABLE_VERSIONS.has(value.version)) {
    throw new RouteError(400, 'unsupported-version', `this Host reads backup versions ${[...READABLE_VERSIONS].join(' and ')}`)
  }
  const patchText = isRecord(value.patchFile) ? value.patchFile.text : undefined
  if (typeof patchText !== 'string') throw new RouteError(400, 'invalid-snapshot', 'the backup carries no settings layer')
  if (Buffer.byteLength(patchText) > MAX_PATCH_BYTES) {
    throw new RouteError(413, 'patch-too-large', 'the settings layer in this backup is implausibly large')
  }
  const settingsRaw = isRecord(value.settingsFile) ? value.settingsFile : {}
  const settingsText = typeof settingsRaw.text === 'string' ? settingsRaw.text : null
  const manifest = isRecord(value.profileManifest) ? value.profileManifest : {}
  const dependencies = isRecord(manifest.dependencies)
    ? Object.fromEntries(Object.entries(manifest.dependencies).filter(([, spec]) => typeof spec === 'string'))
    : {}
  const declared = Array.isArray(value.bundles) ? value.bundles : []
  const specs = new Map()
  for (const row of declared) {
    if (isRecord(row) && typeof row.name === 'string' && typeof row.spec === 'string') specs.set(row.name, row.spec)
  }
  const selection = Array.isArray(manifest.bundles) ? manifest.bundles.filter(name => typeof name === 'string') : []
  const permitted = declared
    .filter(row => isRecord(row) && row.enabled === true && typeof row.name === 'string')
    .map(row => row.name)
  const wanted = [...new Set([...selection, ...permitted])]
  return {
    patchText,
    settingsText,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : null,
    bundles: wanted.map(name => ({ name, spec: specs.get(name) ?? installSpecOf(name, dependencies) })),
    package: readPackage(value.package),
  }
}

/** @param {unknown} value @returns {any | null} the validated package, or null when the backup carries none. @throws {RouteError} */
function readPackage(value) {
  if (value === undefined || value === null) return null
  if (!isRecord(value)) throw new RouteError(400, 'invalid-snapshot', 'the package section is not a JSON object')
  const roots = []
  for (const root of Array.isArray(value.roots) ? value.roots : []) {
    if (!isRecord(root)) continue
    const kind = root.kind
    if (kind !== 'plugin-source' && kind !== 'home-data' && kind !== 'profile-data') continue
    roots.push({
      kind,
      label: typeof root.label === 'string' ? root.label : '',
      package: typeof root.package === 'string' ? root.package : null,
      path: typeof root.path === 'string' ? root.path : '',
    })
  }
  const files = []
  let bytes = 0
  for (const row of Array.isArray(value.files) ? value.files : []) {
    if (!isRecord(row)) continue
    const group = row.group
    if (group !== 'plugin-source' && group !== 'home-data' && group !== 'profile-data') {
      throw new RouteError(400, 'invalid-snapshot', `unknown package group ${JSON.stringify(String(group))}`)
    }
    const text = typeof row.text === 'string' ? row.text : null
    const data = typeof row.data === 'string' ? row.data : null
    if (text === null && data === null) throw new RouteError(400, 'invalid-snapshot', 'a packaged file carries no content')
    const size = text === null ? Math.floor(data.length * 0.75) : Buffer.byteLength(text)
    bytes += size
    if (bytes > MAX_PACKAGE_BYTES) throw new RouteError(413, 'package-too-large', 'the package in this backup is larger than this Host accepts')
    files.push({
      group,
      package: typeof row.package === 'string' ? row.package : null,
      path: normalizeRelative(String(row.path ?? '')),
      bytes: size,
      text,
      data,
    })
  }
  return { roots, files, skipped: Array.isArray(value.skipped) ? value.skipped.length : 0 }
}

/**
 * Save the current state before a restore rewrites it, so the page can offer
 * the same restore path as an undo.
 * @param {any} ctx - Host context.
 * @returns {Promise<string | null>} the safety file, or null when it could not be written.
 */
async function writeSafetyCopy(ctx) {
  try {
    const snapshot = await collectSnapshot(ctx)
    const file = join(backupsDirectory(), `pre-restore-${stamp()}.json`)
    await writeAtomic(file, `${JSON.stringify(snapshot, null, 2)}\n`)
    return file
  } catch {
    // A failed safety copy is reported to the caller, which decides whether to continue.
    return null
  }
}

/**
 * Write one snapshot's configuration back: patch layer, user settings
 * document, the package when it carries one, then the plugin bundle
 * selection. Nothing is ever deselected.
 * @param {any} ctx - Host context.
 * @param {unknown} raw - the snapshot envelope.
 * @param {{safety?: boolean}} [options] - `safety: false` skips the pre-restore copy.
 * @returns {Promise<any>} the restore report the page renders.
 */
export async function applyRestore(ctx, raw, options = {}) {
  const snapshot = readSnapshot(raw)
  const directory = profileDirectory(ctx)
  const patchPath = join(directory, PATCH_FILENAME)
  const settingsPath = join(dshHome(), SETTINGS_FILENAME)
  let safetyFile = null
  if (options.safety !== false) {
    safetyFile = await writeSafetyCopy(ctx)
    if (safetyFile === null) {
      throw new RouteError(500, 'safety-copy-failed', 'the current state could not be saved first, so nothing was written')
    }
  }
  await writeAtomic(patchPath, snapshot.patchText)
  let settings = 'absent'
  if (snapshot.settingsText !== null) {
    await writeAtomic(settingsPath, snapshot.settingsText)
    settings = 'written'
  }
  const safetyDir = snapshot.package === null || snapshot.package.files.length === 0 || options.safety === false
    ? null
    : join(backupsDirectory(), `pre-restore-data-${stamp()}`)
  const restored = snapshot.package === null
    ? null
    : await restorePackage(ctx, snapshot.package, { safetyDir })
  const manager = ctx?.get?.('pluginManager')
  const failures = restored === null ? [] : [...restored.failures]
  let current = []
  let inventoryRead = false
  if (manager !== undefined) {
    try {
      current = await manager.listBundles()
      inventoryRead = true
    } catch (error) {
      failures.push({ target: 'pluginManager', code: 'list-failed', message: messageOf(error) })
    }
  }
  const enabled = []
  const missing = []
  const kept = []
  // The manifest and the installed tree — not the inventory — decide what is
  // missing. An inventory the manager will not report must not turn into
  // "everything is fine, install nothing", which silently skipped every network
  // bundle on a profile that had just been rebuilt.
  const rows = new Map(current.filter(row => typeof row?.name === 'string').map(row => [row.name, row]))
  const wanted = new Set(snapshot.bundles.map(item => item.name))
  // Packages the running Host already supplies: the bundles it started (they
  // live in the application, not in the profile) and its own `@deepseek-ai`
  // core. Installing one of those from the registry would fetch a stranger's
  // same-named package, so they are never installed.
  const started = new Set(Array.isArray(ctx?.get?.('profileContext')?.startedBundles) ? ctx.get('profileContext').startedBundles : [])
  const isProvided = name => started.has(name) || name.startsWith('@deepseek-ai/')
  for (const row of current) {
    if (typeof row?.name === 'string' && row.enabled === true && !wanted.has(row.name)) kept.push(row.name)
  }
  for (const item of snapshot.bundles) {
    // Part of this Host already; nothing to install and nothing to select.
    if (isProvided(item.name)) continue
    if (!packageInstalled(directory, item.name)) {
      missing.push(item)
      continue
    }
    const row = rows.get(item.name)
    if (row !== undefined && row.enabled === true) continue
    if (manager === undefined) {
      // Installed but not selected, and no service to select it: the manifest is
      // still ours to edit, so record the selection directly.
      try {
        await recordBundle(directory, item.name, item.spec)
        enabled.push(item.name)
      } catch (error) {
        failures.push({ target: item.name, code: 'enable-failed', message: messageOf(error) })
      }
      continue
    }
    if (row?.error !== undefined && row.error.code !== 'not-bundle') {
      failures.push({
        target: item.name,
        code: row.error.code ?? 'unusable',
        message: 'this profile cannot enable the bundle as it stands',
      })
      continue
    }
    try {
      const result = await manager.setBundleEnabled(item.name, true)
      if (result?.application === 'failed') {
        failures.push({
          target: item.name,
          code: result.error?.code ?? 'failed',
          message: result.error?.diagnostic ?? 'the profile refused the change',
        })
      } else {
        enabled.push(item.name)
      }
    } catch (error) {
      failures.push({ target: item.name, code: 'operation-error', message: messageOf(error) })
    }
  }
  if (!inventoryRead && manager === undefined) {
    failures.push({ target: 'pluginManager', code: 'no-plugin-manager', message: 'this profile composes no plugin manager, so bundles are selected through the manifest and installed with pnpm' })
  }
  const manifest = await readProfileManifest(directory)
  return {
    restoredAt: new Date().toISOString(),
    backupCreatedAt: snapshot.createdAt,
    patch: { path: patchPath, bytes: Buffer.byteLength(snapshot.patchText) },
    settings,
    enabled,
    missing,
    kept,
    failures,
    safetyFile,
    safetyDataDir: safetyDir,
    package: restored,
    liveReload: manifest.patchReload !== 'startup',
    restartRequired: manifest.patchReload === 'startup',
  }
}

/**
 * Persist one snapshot under the harness home, so a browser download is never
 * the only copy.
 * @param {any} snapshot - the envelope.
 * @returns {Promise<string | null>} the file written, or null when the directory is unwritable.
 */
async function saveSnapshot(snapshot) {
  try {
    const suffix = snapshot.package === undefined ? 'plugin-backup' : 'plugin-backup-full'
    const file = join(backupsDirectory(), `${suffix}-${stamp()}.json`)
    await writeAtomic(file, `${JSON.stringify(snapshot, null, 2)}\n`)
    await pruneSnapshots()
    return file
  } catch {
    // The download still carries the backup; a read-only home only costs the local copy.
    return null
  }
}

/**
 * Keep the newest few exported snapshots. A full backup can be ~100 MB, so an
 * unbounded directory would grow by that much per click. Only files this
 * plugin names are ever removed; `pre-restore-*` copies are the undo points and
 * stay until the user deletes them.
 */
async function pruneSnapshots() {
  const directory = backupsDirectory()
  let names
  try {
    names = await readdir(directory)
  } catch {
    return
  }
  const mine = names.filter(name => name.startsWith('plugin-backup-') && name.endsWith('.json'))
  if (mine.length <= EXPORTED_BACKUP_KEEP) return
  const rows = []
  for (const name of mine) {
    try {
      rows.push({ name, modified: (await stat(join(directory, name))).mtimeMs })
    } catch {
      // A file that vanished between the listing and the stat is already gone.
    }
  }
  rows.sort((left, right) => right.modified - left.modified)
  for (const row of rows.slice(EXPORTED_BACKUP_KEEP)) {
    await rm(join(directory, row.name), { force: true }).catch(() => undefined)
  }
}

/** @returns {Promise<any[]>} backups under the harness home, newest first. */
export async function listBackups() {
  const directory = backupsDirectory()
  let names
  try {
    names = await readdir(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const rows = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(directory, name)
    let info
    try {
      info = await stat(path)
    } catch {
      // The file disappeared between the directory read and the stat; the next refresh drops it.
      continue
    }
    let createdAt = null
    try {
      // A full backup can be very large; the envelope's timestamp is always in its first bytes.
      const head = await readHead(path, 8192)
      createdAt = /"createdAt"\s*:\s*"([^"]{10,40})"/u.exec(head)?.[1] ?? null
    } catch {
      // An unreadable backup still shows its size; restoring it reports the parse failure.
    }
    rows.push({
      file: name,
      bytes: info.size,
      modifiedAt: info.mtime.toISOString(),
      createdAt,
      kind: name.startsWith('pre-restore-') ? 'safety' : 'file',
      full: name.includes('-full-'),
    })
  }
  rows.sort((left, right) => (left.modifiedAt < right.modifiedAt ? 1 : left.modifiedAt > right.modifiedAt ? -1 : 0))
  return rows.slice(0, BACKUP_LIST_LIMIT)
}

/**
 * Read one backup by the file name the status list reported.
 * @param {string} file - bare file name inside the backups directory.
 * @returns {Promise<any>} the parsed snapshot envelope.
 * @throws {RouteError} when the name escapes the directory or the file is missing.
 */
async function readLocalSnapshot(file) {
  if (typeof file !== 'string' || file.trim() === '' || basename(file) !== file) {
    throw new RouteError(400, 'invalid-file', 'the backup name must be a bare file name')
  }
  const path = join(backupsDirectory(), file)
  const text = await readTextIfPresent(path)
  if (text === null) throw new RouteError(404, 'missing-file', `no backup named "${file}"`)
  return parseSnapshotText(text, file)
}

/**
 * Read a backup the user names by path, so a full backup never has to travel
 * through an HTTP body.
 * @param {string} filePath - absolute path the user typed.
 * @returns {Promise<any>} the parsed snapshot envelope.
 * @throws {RouteError} when the path is unusable or the file is not a snapshot.
 */
async function readPathSnapshot(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new RouteError(400, 'invalid-path', 'no backup path was supplied')
  }
  const path = resolve(filePath.trim().replace(/^"|"$/gu, ''))
  const info = await stat(path).catch(() => undefined)
  if (info === undefined || !info.isFile()) throw new RouteError(404, 'missing-file', `no readable file at ${path}`)
  if (info.size > MAX_RESTORE_FILE_BYTES) {
    throw new RouteError(413, 'file-too-large', `the file is larger than ${String(MAX_RESTORE_FILE_BYTES)} bytes`)
  }
  return parseSnapshotText(await readFile(path, 'utf8'), path)
}

/** @param {string} text @param {string} label @returns {any} the parsed envelope. @throws {RouteError} */
function parseSnapshotText(text, label) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new RouteError(400, 'invalid-json', `"${label}" is not valid JSON: ${messageOf(error)}`)
  }
}

/**
 * Install one plugin package the restore reported missing.
 * @param {any} ctx - Host context.
 * @param {string} spec - package spec from the snapshot.
 * @returns {Promise<any>} the install outcome, without the raw install log.
 */
async function installOne(ctx, spec) {
  if (typeof spec !== 'string' || spec.trim() === '') throw new RouteError(400, 'invalid-spec', 'no package spec was supplied')
  return installBundleSpec(ctx, spec.trim())
}

/** @param {any} ctx @returns {Promise<any>} the page's overview of this profile. */
async function statusOf(ctx) {
  const directory = profileDirectory(ctx)
  const patchPath = join(directory, PATCH_FILENAME)
  const settingsPath = join(dshHome(), SETTINGS_FILENAME)
  const manifest = await readProfileManifest(directory)
  const plugins = await readPluginRows(ctx)
  const bundles = await readBundleRows(ctx)
  const packageRoots = await describePackageRoots(ctx)
  return {
    profile: { name: basename(directory), directory },
    home: dshHome(),
    backupsDirectory: backupsDirectory(),
    patch: {
      path: patchPath,
      exists: existsSync(patchPath),
      bytes: sizeOf(patchPath),
      reload: manifest.patchReload ?? null,
    },
    settings: {
      path: settingsPath,
      exists: existsSync(settingsPath),
      bytes: sizeOf(settingsPath),
    },
    counts: {
      plugins: plugins.length,
      enabledPlugins: plugins.filter(row => row.enabled).length,
      bundles: bundles.length,
      enabledBundles: bundles.filter(row => row.enabled === true).length,
      installedBundles: bundles.filter(row => row.installed === true).length,
      selectedBundles: manifest.bundles.length,
    },
    packageRoots: packageRoots.roots,
    packageExcluded: packageRoots.excluded,
    backups: await listBackups(),
  }
}

/** @param {any} request @returns {Promise<any>} the parsed JSON body. */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      throw new RouteError(413, 'body-too-large', `the request body exceeds ${String(MAX_BODY_BYTES)} bytes; restore a full backup by path instead`)
    }
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    throw new RouteError(400, 'invalid-json', `the request body is not valid JSON: ${messageOf(error)}`)
  }
}

/** @param {string} method @param {string} expected - the one accepted method. */
function requireMethod(method, expected) {
  if (method !== expected) throw new RouteError(405, 'method-not-allowed', `${method} is not allowed here`)
}

/**
 * Route one request to its operation.
 * @param {any} ctx - Host context.
 * @param {string} route - path below {@link ROUTE}.
 * @param {string} method - HTTP method.
 * @param {any} request - the incoming request.
 * @returns {Promise<any>} the JSON payload returned beside `ok: true`.
 */
async function dispatch(ctx, route, method, request) {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (route === '' || route === 'status') {
    requireMethod(method, 'GET')
    return statusOf(ctx)
  }
  if (route === 'export') {
    requireMethod(method, 'GET')
    const full = url.searchParams.get('full') === '1' || url.searchParams.get('full') === 'true'
    const snapshot = await collectSnapshot(ctx, { package: full })
    return { snapshot, savedTo: await saveSnapshot(snapshot) }
  }
  if (route === 'restore') {
    requireMethod(method, 'POST')
    const body = await readJsonBody(request)
    return { report: await applyRestore(ctx, body?.snapshot, { safety: true }) }
  }
  if (route === 'restore-path') {
    requireMethod(method, 'POST')
    const body = await readJsonBody(request)
    return { report: await applyRestore(ctx, await readPathSnapshot(body?.path), { safety: true }) }
  }
  if (route === 'restore-local') {
    requireMethod(method, 'POST')
    const body = await readJsonBody(request)
    return { report: await applyRestore(ctx, await readLocalSnapshot(body?.file), { safety: true }) }
  }
  if (route === 'install') {
    requireMethod(method, 'POST')
    const body = await readJsonBody(request)
    return { result: await installOne(ctx, body?.spec) }
  }
  throw new RouteError(404, 'unknown-route', `no plugin-backup operation is named "${route}"`)
}

/** @param {any} response @param {number} status @param {any} payload */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** @param {401 | 403} rejection @returns {string} what the operator has to do about it. */
function rejectionText(rejection) {
  return rejection === 401
    ? 'open the URL dsh printed at startup to sign in first'
    : 'this request did not come from this Host’s own page'
}

/** Services this plugin cannot run without. */
export const inject = ['webServer']

/**
 * Mount the backup route for as long as this plugin runs.
 * @param {any} ctx - Host context.
 */
export function apply(ctx) {
  const route = {
    kind: 'prefix',
    path: ROUTE,
    handler: async (request, response) => {
      const connection = ctx.get('connection')
      const rejection = connection === undefined
        ? undefined
        : connection.requestRejection({ headers: request.headers })
      if (rejection !== undefined) {
        sendJson(response, rejection, { ok: false, error: { code: 'unauthorized', message: rejectionText(rejection) } })
        return
      }
      const method = (request.method ?? 'GET').toUpperCase()
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      const routePath = pathname.startsWith(ROUTE) ? pathname.slice(ROUTE.length) : pathname
      const name = decodeURIComponent(routePath).replace(/^\/+|\/+$/gu, '')
      try {
        sendJson(response, 200, { ok: true, ...await dispatch(ctx, name, method, request) })
      } catch (error) {
        const known = error instanceof RouteError
        ctx.logger?.warn?.(`plugin-backup: ${name === '' ? 'status' : name} failed: ${messageOf(error)}`)
        sendJson(response, known ? error.status : 500, {
          ok: false,
          error: { code: known ? error.code : 'internal-error', message: messageOf(error) },
        })
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'plugin-backup: backup route')
}
