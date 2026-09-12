import { join, dirname, isAbsolute, relative } from 'node:path'

// Both native Host/tool commands and qualifier commands use this contract.
// Cache writes are task-local; the dependency content digest remains strict.
export function commandEnvironment({ cacheRoot, toolsRoot, workspaceRoot, nodePath = process.execPath, inherited = {} }) {
  for (const path of [cacheRoot, toolsRoot, workspaceRoot, nodePath]) {
    if (!isAbsolute(path)) throw Error('Command environment paths must be absolute')
  }
  const inside = relative(workspaceRoot, cacheRoot)
  if (!inside || (inside !== '..' && !inside.startsWith('../') && !isAbsolute(inside))) throw Error('Cache must be outside the source artifact')
  return {
    ...inherited,
    PATH: `${join(toolsRoot, 'node_modules/.bin')}:${join(workspaceRoot, 'node_modules/.bin')}:${dirname(nodePath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    CACHE_DIR: cacheRoot,
    NYC_CACHE_DIR: join(cacheRoot, 'nyc'),
    NYC_CACHE: 'true',
    npm_config_cache: join(cacheRoot, 'npm'),
    npm_config_offline: 'true',
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENABLE_PROJECT_SPEC: '0',
    YARN_CACHE_FOLDER: join(cacheRoot, 'yarn'),
    XDG_CACHE_HOME: join(cacheRoot, 'xdg'),
    NODE_OPTIONS: '--no-experimental-strip-types',
  }
}

export function environmentError(code) {
  return Object.assign(new Error('Verification environment unavailable'), { code })
}
