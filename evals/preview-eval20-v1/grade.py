"""Independent candidate grading. Requires a prepared task admission; never launches a model."""
import importlib.util
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('checker', Path(__file__).with_name('check-owner-references.py'))
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def grade(task_id, root, *, admission=None):
    catalog = json.loads(checker.environment.sources.CATALOG.read_text())
    task = next(t for t in catalog['tasks'] if t['id'] == task_id)
    if admission is None:
        admission = json.loads((checker.BASE/task_id/'admission.json').read_text())
    candidate = Path(root)
    assert str(candidate) == admission['root'] and candidate.is_dir() and not candidate.is_symlink(), 'Candidate identity mismatch'
    assert task['head'] == admission['sourceHead'], 'Source identity mismatch'
    key = task['repo'].replace('/', '--') + '-' + task['head']
    deps = checker.BASE/'dependencies-v2'/key/'node_modules'
    mount = candidate/'node_modules'
    assert mount.is_dir() and not mount.is_symlink(), 'Dependency mount changed'
    assert {p.name for p in mount.iterdir()} == {p.name for p in deps.iterdir()} | {'.cache'}, 'Dependency mount changed'
    for entry in deps.iterdir():
        link = mount/entry.name
        assert link.is_symlink() and link.readlink() == entry, 'Dependency link changed'
    cache = mount/'.cache'
    assert cache.is_dir() and not cache.is_symlink(), 'Dependency cache changed'
    assert not any(p.is_symlink() for p in cache.rglob('*')), 'Dependency cache link changed'
    before = checker.delivery.snapshot(candidate, task['delivery'].get('generatedDirectories',[]))
    result = checker.run(task, candidate)
    after = checker.delivery.snapshot(candidate, task['delivery'].get('generatedDirectories',[]))
    if before != after:
        return {'passed':False,'failed':['artifact-changed-during-grade'],'failureCode':'verifier_exception'}
    if result.get('preparationError'):
        return {'passed':False,'failed':['verifier_exception'],'failureCode':'verifier_exception'}
    if result.get('incomingDelivery') and not result['incomingDelivery']['passed']:
        return {'passed':False,'failed':result['incomingDelivery']['failed']}
    if any(c['exitCode']==124 for c in result['checks']):
        return {'passed':False,'failed':['verifier_timeout'],'failureCode':'verifier_timeout'}
    failed = [c['name'].replace('reference-','') for c in result['checks'] if c['exitCode'] and c['name'].startswith('reference-')]
    failed += ['new-tests-miss:' + m['id'] for m in result.get('mutants',[]) if not m['rejected']]
    return {'passed':bool(result.get('passed')),'failed':failed}


if __name__ == '__main__':
    checker.processes.install_stop_handlers()
    try:
        value = grade(*sys.argv[1:])
    except Exception:
        value = {'passed':False,'failed':['verifier_exception'],'failureCode':'verifier_exception'}
    print(json.dumps(value))
    sys.exit(0 if value['passed'] else 1)
