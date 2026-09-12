import { lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export const scratchRelative = 'test/.chaos-tmp'
export function scratchPath(root) {
  if (!isAbsolute(root)) throw Error('Workspace must be absolute')
  return join(root, scratchRelative)
}

// Never follow a task-created link or delete an existing entry.
async function inspectDirectories(root, create) {
  const physicalRoot = await realpath(root)
  for (const path of [root, join(root, 'test'), scratchPath(root)]) {
    let info
    try { info = await lstat(path) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      if (!create) return false
      await mkdir(path, { mode: 0o700 })
      info = await lstat(path)
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Temporary directory must be a physical workspace directory')
    const expected = path === root ? physicalRoot : path === join(root, 'test') ? join(physicalRoot, 'test') : join(physicalRoot, scratchRelative)
    if (await realpath(path) !== expected) throw Error('Temporary directory escaped workspace')
  }
  return true
}

export async function prepareScratch(root) {
  await inspectDirectories(root, true)
  return scratchPath(root)
}

export async function scratchFindings(root) {
  try {
    if (!await inspectDirectories(root, false)) return []
    return (await readdir(scratchPath(root))).length ? ['temporary-files-remain'] : []
  } catch { return ['temporary-directory-invalid'] }
}

export function workspaceGuidance(root) {
  return `Use ${JSON.stringify(root)} as the exact tool workdir. Shell command paths, redirections, logs and temporary reproductions must also stay inside that repository; cwd alone does not confine absolute paths. TMPDIR, TMP and TEMP are preconfigured to ${JSON.stringify(scratchPath(root))}. Put all temporary files there, including explicit log redirections; never hardcode /tmp, /var/tmp or another workspace. Prefer direct test output. If capturing logs, save the test exit status immediately, read the log, and return that saved status; log-reading or cleanup success is not test success. Keep permanent regression tests outside ${scratchRelative}. Before proposing completion, remove only temporary files you created there and leave the directory empty; never remove or replace the directory or create directory symlinks. Package-managed caches are configured by the runner; do not inspect or manually clean them. Do not request broader permissions or retry a Host-denied action.`
}
