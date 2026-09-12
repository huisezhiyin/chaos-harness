"""Read-only preparation report. This command cannot qualify, admit or launch a task."""
import hashlib
import json
import sys
import subprocess
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

sys.dont_write_bytecode = True
spec = spec_from_file_location('environment', Path(__file__).with_name('prepare-environments.py'))
env = module_from_spec(spec)
spec.loader.exec_module(env)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def report():
    catalog = json.loads(env.sources.CATALOG.read_text())
    identities = {}
    evidence = {}
    for task in catalog['tasks']:
        key = task['repo'].replace('/', '--') + '-' + task['head']
        if key in identities:
            continue
        src = env.BASE / 'sources' / key
        deps = env.BASE / 'dependencies-v2' / key
        source = json.loads((src / 'source.json').read_text())
        environment = json.loads((deps / 'environment.json').read_text())
        expected = (task['repo'], task['head'], task['tree'])
        assert tuple(source[k] for k in ['repo', 'head', 'tree']) == expected
        assert tuple(environment[k] for k in ['repo', 'head', 'tree']) == expected
        actual = {str(p.relative_to(src / 'repo')): sha(p)
                  for p in (src / 'repo').rglob('*') if p.is_file()}
        assert actual == source['sha256'], 'Source identity changed'
        assert env.digest_tree(deps / 'node_modules') == environment['dependencyTree'], 'Dependency drift'
        assert sha(deps / 'package-lock.json') == environment['lockSha256'], 'Lock drift'
        for record in [src / 'source.json', deps / 'environment.json']:
            evidence[str(record.relative_to(env.BASE))] = sha(record)
        log_hashes = {sha(p) for p in deps.glob('baseline-check-*.log')}
        assert all(check['logSha256'] in log_hashes for check in environment['checks']), 'Missing baseline log'
        identities[key] = environment['originalChecksPassed']

    rows = []
    for task in catalog['tasks']:
        row = {'id': task['id'], 'kind': task['kind'], 'sourceVerified': True,
               'originalChecksPassed': identities[task['repo'].replace('/', '--') + '-' + task['head']],
               'bugReferenceScreening': 'not-applicable', 'qualified': False, 'admitted': False}
        if task['kind'] == 'bug':
            row['bugReferenceScreening'] = 'pending'
            folder = env.BASE / 'bug-reference-checks' / task['slug']
            for record in sorted(folder.glob('check-*.json'), reverse=True):
                check = json.loads(record.read_text())
                if any(check.get(k) != task[k] for k in ['head', 'tree', 'referenceCommit']):
                    continue
                for mode in check['checks']:
                    for command in mode['checks']:
                        assert sha(folder / command['log']) == command['sha256'], 'Bug evidence changed'
                row['bugReferenceScreening'] = 'passed' if check['baselineDefectObserved'] and check['referencePassed'] else 'failed'
                evidence[str(record.relative_to(env.BASE))] = sha(record)
                reference = env.BASE / 'references' / task['slug'] / 'reference.json'
                assert json.loads(reference.read_text())['referenceCommit'] == task['referenceCommit']
                evidence[str(reference.relative_to(env.BASE))] = sha(reference)
                break
        rows.append(row)
    live = None
    if (env.BASE/'qualification.json').exists():
        live = json.loads(subprocess.check_output(['node','--import','tsx',str(Path(__file__).with_name('cli.mjs')),'report'],cwd=Path(__file__).resolve().parents[2],text=True))
    return {'batchId': catalog['batchId'], 'status': 'selected-unqualified', 'launchReady': bool(live and live['admitted'] and all(t['state']=='not_run' for t in live['tasks'])),
            'sourceIdentities': len(identities), 'environmentsPassed': sum(identities.values()),
            'bugReferencesPassed': sum(t['bugReferenceScreening'] == 'passed' for t in rows),
            'qualifiedTasks': live['qualified'] if live else 0, 'admittedTasks': 20 if live and live['admitted'] else 0, 'providerCalls': None if live and any(t['state']!='not_run' for t in live['tasks']) else 0, 'execution': live,
            'pending': ['12 owner-authored task reference implementations and executable probes',
                        'Independent negative controls for all 20 tasks',
                        'Delivery boundary integration and validation',
                        'Exact compiler/toolchain/runtime/grader identity binding',
                        'Qualification, admissions and single-use serial runner'],
            'tasks': rows, 'privateEvidenceSha256': dict(sorted(evidence.items()))}


if __name__ == '__main__':
    print(json.dumps(report(), indent=2))
