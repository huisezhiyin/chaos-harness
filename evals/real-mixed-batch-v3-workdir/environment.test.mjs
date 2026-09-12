import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commandEnvironment } from './environment.mjs'
import { classifyResult, diagnoseTermination } from './native.mjs'

test('cache environment overrides ambient cache locations and keeps dependency paths separate', () => {
  const env = commandEnvironment({ cacheRoot:'/state/run/cache', toolsRoot:'/tools', workspaceRoot:'/target', inherited:{ CACHE_DIR:'/deps/.cache', NYC_CACHE_DIR:'/deps/nyc', PATH:'/untrusted', KEEP:'yes' } })
  assert.equal(env.CACHE_DIR, '/state/run/cache')
  assert.equal(env.NYC_CACHE_DIR, '/state/run/cache/nyc')
  assert.equal(env.KEEP, 'yes')
  assert(!env.PATH.includes('/untrusted'))
  assert.throws(() => commandEnvironment({cacheRoot:'/target/node_modules/.cache',toolsRoot:'/tools',workspaceRoot:'/target'}), /outside/)
})
test('verifier failure is correlated with the final mission and survives normal host cleanup', () => {
  const identity={missionId:'m',unitId:'u',unitRevision:1},raw={missionOutcome:'cancelled',missionReason:'host_exit',exitCode:0}
  const events=[{...identity,event:'external_verification_completed',passed:false,failureCode:'dependencies_changed'},
    {...identity,event:'mission_finished',outcome:'cancelled',reason:'host_exit',verificationFailureCode:'dependencies_changed'}]
  const termination=diagnoseTermination(raw,events)
  assert.equal(classifyResult({...raw,termination}), 'verification_environment_interruption')
  assert.equal(termination.cleanupReason, 'host_exit')
  assert.equal(classifyResult({...raw,termination,hostTimedOut:true}), 'timeout_interruption')
  assert.equal(classifyResult({...raw,termination,permissionRejections:1}), 'permission_interruption')
  assert.equal(diagnoseTermination(raw,[{...events[0],unitRevision:0},events[1]]).category, 'unknown')
  assert.equal(diagnoseTermination(raw,[...events.slice(0,1),{...events[0],passed:true},events[1]]).category, 'unknown')
})
test('post-grade error cannot turn raw Mission success into independent acceptance', () => {
  assert.equal(classifyResult({missionOutcome:'succeeded',exitCode:0,independentPassed:false,postGradeFailureCode:'verifier_exception'}), 'verification_error')
  assert.equal(classifyResult({missionOutcome:'cancelled',missionReason:'host_exit',exitCode:0,postGradeFailureCode:'verifier_exception'}), 'host_interruption')
})
