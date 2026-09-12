import {test} from 'node:test'
import assert from 'node:assert/strict'
import {diagnoseTermination,classifyResult} from './native.mjs'
const unit={missionId:'m',unitId:'u',unitRevision:1}
const raw={exitCode:0,missionOutcome:'cancelled',missionReason:'host_exit',attempts:2,independentPassed:false}
const event=(event,extra={})=>({...unit,event,...extra})
const events=[event('attempt_started',{attemptId:'a'}),event('external_verification_completed',{attemptId:'a',passed:false}),event('unit_finished',{outcome:'verification_pending'}),event('mission_finished',{outcome:'cancelled',reason:'host_exit'})]
test('complete matching verifier rejection survives clean Host exit',()=>{
 const termination=diagnoseTermination(raw,events)
 assert.equal(termination.failureCode,'verifier_rejected')
 assert.equal(termination.cleanupReason,'host_exit')
 assert.equal(classifyResult({...raw,termination}),'verification_rejected')
})
test('incomplete, stale, recovered, foreign or exceptional verdicts cannot override termination',()=>{
 const bad=[events.filter(e=>e.event!=='unit_finished'),events.map(e=>e.event==='external_verification_completed'?{...e,attemptId:'other'}:e),events.map(e=>e.event==='external_verification_completed'?{...e,unitRevision:2}:e),events.map(e=>e.event==='external_verification_completed'?{...e,passed:true}:e),events.map(e=>e.event==='external_verification_completed'?{...e,failureCode:'verifier_exception'}:e),[...events.slice(0,-1),event('attempt_started',{attemptId:'new'}),events.at(-1)],events.map(e=>e.event==='mission_finished'?{...e,reason:'deadline_exceeded'}:e)]
 for(const journal of bad)assert.notEqual(diagnoseTermination(raw,journal).category,'verification_rejected')
 for(const key of ['hostFailure','hostTimedOut','modelFailure','nativeErrors','permissionRejections','budgetStop'])assert.notEqual(diagnoseTermination({...raw,[key]:true},events).category,'verification_rejected',key)
})
