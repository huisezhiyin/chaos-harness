import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Only the selected binding is substituted. Relative imports and all auxiliary
// exports still come from the candidate, at its original module location.
export async function writeProbe(root, modulePath, binding, expression) {
  const target = pathToFileURL(join(root, modulePath)).href
  const original = target + '?chaos-probe-original'
  const wrapper = `export * from ${JSON.stringify(original)};
import * as actual from ${JSON.stringify(original)};
export default actual.default;
export const ${binding} = ${expression};`
  const hook = join(root, 'owner-probe.mjs')
  await writeFile(hook, `import { registerHooks } from 'node:module';
registerHooks({load(url, context, nextLoad) {
  if (url === ${JSON.stringify(target)}) return {format:'module', shortCircuit:true, source:${JSON.stringify(wrapper)}};
  return nextLoad(url, context);
}});`)
  return hook
}
