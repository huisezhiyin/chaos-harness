// Owner-side diagnostic probes. These repeat subsets of the frozen checks only
// after behavior has failed. They cannot accept an otherwise failing candidate.
const money = [
  { code: 'money-valid-decimal', check: "assert.equal(api.parseMoney('1.2'),120);assert.equal(api.parseMoney('000.01'),1);" },
  { code: 'money-invalid-decimal', check: "for(const s of ['',' 1','-1','1e2','.5','1.001','90071992547409.92'])assert.throws(()=>api.parseMoney(s),RangeError);" },
  { code: 'money-safe-integer', check: "assert.equal(api.parseMoney('90071992547409.91'),Number.MAX_SAFE_INTEGER);assert.throws(()=>api.lineTotal({price:'90071992547409.91',quantity:2}),RangeError);" },
  { code: 'money-quantity', check: "assert.equal(api.lineTotal({price:'1.99',quantity:3}),597);for(const q of [-1,1.5,Infinity])assert.throws(()=>api.lineTotal({price:'1',quantity:q}),RangeError);" },
  { code: 'money-invoice', check: "assert.deepEqual(api.invoice([{price:'0.10',quantity:1},{price:'0.20',quantity:1}]),{totalCents:30,display:'0.30'});assert.deepEqual(api.invoice([]),{totalCents:0,display:'0.00'});assert.throws(()=>api.invoice([{price:'90071992547409.91',quantity:1},{price:'0.01',quantity:1}]),RangeError);" },
]

export const behaviorDiagnostics = id => id === '08-money-contract' ? money : []

const messages = {
  'money-valid-decimal': 'parseMoney rejects or misparses a valid non-negative decimal string. The integer part may contain leading zeros; the public contract does not prohibit them. Review accepted syntax and add a regression for this input class.',
  'money-invalid-decimal': 'parseMoney must reject forbidden syntax and amounts outside the safe integer range with RangeError. Review whitespace, signs, exponents and fractional precision.',
  'money-safe-integer': 'Review the exact safe-integer boundary and overflow during multiplication; preserve integer-cent precision.',
  'money-quantity': 'Review lineTotal quantity validation and integer-cent multiplication for valid quantities.',
  'money-invoice': 'Review invoice summation, overflow, the empty invoice and fixed two-decimal display.',
  'public-tests': 'Candidate or public tests failed. Run npm test, inspect its output, and repair the failing assertions without weakening the public contract.',
  'regression-tests-missing': 'Add task-specific regression tests under test/; the public smoke test alone is insufficient.',
  'layer-delegation': 'The handler/service chain did not reflect the repository result. Verify actual delegation through the required layers.',
  'money-delegation': 'The cart/invoice chain did not reflect parseMoney from the shared money module. Verify actual integer-cent delegation.',
  'shared-helper-not-used': 'Both consumers must actually call normalizeNames from the shared helper, not retain copied normalization logic.',
  'artifact-changed-during-grade': 'The artifact changed during verification. Finish writes before proposing completion and validate the stable final diff.',
  'artifact-unavailable': 'The workspace artifact could not be captured within the task scope. Check file types, size and paths.',
}

export function verifierFeedback(result) {
  const details = [...new Set((result.diagnostics ?? []).filter(code => Object.hasOwn(messages, code)))].map(code => messages[code])
  for (const failure of result.failed ?? []) {
    if (Object.hasOwn(messages, failure)) details.push(messages[failure])
    else if (failure.startsWith('immutable:')) details.push('Restore the protected task contract, package and public smoke test files; implement only within allowed paths.')
    else if (failure.startsWith('scope:')) details.push('Remove unintended out-of-scope additions from your proposed patch, preserving pre-existing user work.')
    else if (failure.startsWith('surviving-mutant:')) details.push('Regression tests missed an incorrect parser implementation. Add assertions for the public boundary and invalid-input behavior.')
    else if (failure === 'behavior' && !details.length) details.push('Independent public-contract behavior failed despite any passing local tests. Check each required input class, output and error boundary, and add missing regression assertions.')
  }
  return ['Independent verification failed. Repair the artifact before proposing completion again.', ...new Set(details),
    'Use the public TASK.md and your implementation/tests. Do not inspect the evaluator or reference solutions.'].join('\n').slice(0, 3500)
}
