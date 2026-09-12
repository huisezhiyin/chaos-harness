"""Reference behavior/full-suite screening; does not issue task admissions."""
import concurrent.futures
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

sys.dont_write_bytecode = True


def load(name, filename):
    spec = spec_from_file_location(name, Path(__file__).with_name(filename))
    value = module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


environment = load('environment', 'prepare-environments.py')
fixtures = load('fixtures', 'owner_fixtures.py')
test_fixtures = load('test_fixtures', 'test_fixtures.py')
mutants = load('mutants', 'owner_mutants.py')
delivery = load('delivery', 'delivery.py')
processes = load('processes', 'processes.py')
BASE = environment.BASE
HARNESS = Path(__file__).resolve().parents[2]


def run(task, candidate=None):
    key = task['repo'].replace('/', '--') + '-' + task['head']
    source = BASE / 'sources' / key / 'repo'
    deps = BASE / 'dependencies-v2' / key
    dependency = json.loads((deps / 'environment.json').read_text())
    assert dependency['originalChecksPassed']
    assert environment.digest_tree(deps / 'node_modules') == dependency['dependencyTree']
    record = BASE / ('candidate-checks' if candidate else 'owner-reference-checks') / task['slug'] / str(time.time_ns())
    record.mkdir(parents=True, mode=0o700)
    result = {'task': task['id'], 'head': task['head'], 'providerCalls': 0, 'qualified': False, 'checks': [], 'taskIdentity': hashlib.sha256(json.dumps(task,sort_keys=True).encode()).hexdigest(), 'checkerIdentity': {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in Path(__file__).parent.iterdir() if p.suffix in ['.py','.mjs','.mts','.json'] and p.name!='preparation-report.json'}}
    try:
        with tempfile.TemporaryDirectory(prefix='chaos-eval20-owner-') as temp:
            scratch = Path(temp).resolve()
            root = scratch / 'repo'
            shutil.copytree(source, root)
            (root / 'node_modules').mkdir()
            for p in (deps / 'node_modules').iterdir():
                (root / 'node_modules' / p.name).symlink_to(p)
            (root / 'node_modules/.cache').mkdir()
            (root / 'test/.chaos-tmp').mkdir(parents=True, exist_ok=True)
            initial = delivery.snapshot(root, task['delivery'].get('generatedDirectories',[]))
            if candidate:
                incoming = delivery.snapshot(candidate, task['delivery'].get('generatedDirectories',[]))
                result['incomingDelivery'] = delivery.check(task, initial, incoming)
                if not result['incomingDelivery']['passed']:
                    return result
                for name in task['delivery']['allowedExistingFiles'] + task['delivery']['allowedNewFiles']:
                    path = candidate/name
                    if path.is_file():
                        (root/name).parent.mkdir(parents=True,exist_ok=True)
                        shutil.copy2(path,root/name)
                if incoming != delivery.snapshot(candidate, task['delivery'].get('generatedDirectories',[])):
                    raise RuntimeError('Candidate changed during copying')
            env = {k:v for k,v in os.environ.items() if not any(s in k.upper() for s in ['TOKEN','SECRET','API_KEY','PASSWORD','AUTH'])}
            env.update(CI='true', TSX_DISABLE_CACHE='1', TMPDIR=str(root/'test/.chaos-tmp'), TMP=str(root/'test/.chaos-tmp'), TEMP=str(root/'test/.chaos-tmp'),
                       NODE_COMPILE_CACHE=str(scratch/'compile-cache'), XDG_CACHE_HOME=str(scratch/'xdg'),
                       npm_config_cache=str(scratch/'npm'), npm_config_offline='true', NODE_OPTIONS='--no-experimental-strip-types')
            if task['repo']=='fastify/fast-uri':
                env.update(TSTYCHE_TYPESCRIPT_MODULE=str(root/'node_modules/typescript/lib/typescript.js'),TSTYCHE_STORE_PATH=str(scratch/'tstyche-store'))
            policy = '(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (literal "/dev/null") (subpath ' + json.dumps(str(scratch)) + '))'

            def execute(name, command):
                log = record / (name + '.log')
                with log.open('x') as out:
                    code = processes.run(['/usr/bin/sandbox-exec','-p',policy,*command], cwd=root, env=env, output=out, timeout=180)
                check = {'name': name, 'exitCode': code, 'sha256': hashlib.sha256(log.read_bytes()).hexdigest()}
                result['checks'].append(check)
                return code

            probe = ['node'] + (['--import=tsx/esm'] if task['repo'].endswith('/p-queue') else []) + [str(HARNESS/'evals/preview-eval16-v2'/('bug-probe.mjs' if task['kind']=='bug' else 'owner-probe.mjs')),str(root),task['slug']]
            if task['kind'] == 'tests':
                if not candidate:
                    assert not (root/task['delivery']['requiredNewTestFile']).exists()
                    result['baselineNewTestsMissing'] = True
                    test_fixtures.apply(task, root)
                test = task['delivery']['requiredNewTestFile']
                probe = (['node','--import=tsx/esm','--test',test] if task['repo'].endswith('/p-queue') else ['node',str(root/'node_modules/tape/bin/tape'),test] if task['repo']=='fastify/fast-uri' else ['node',str(root/'node_modules/ava/entrypoints/cli.mjs'),test])
            elif not candidate:
                execute('baseline-behavior', probe)
                if task['kind'] == 'refactor':
                    execute('baseline-structure', ['node',str(HARNESS/'evals/preview-eval16-v2/structure-probe.mjs'),str(root),task['slug']])
                if task['kind'] == 'bug':
                    reference = json.loads((BASE/'references'/task['slug']/'reference.json').read_text())
                    assert reference['referenceCommit'] == task['referenceCommit']
                    for name, text in reference['files'].items():
                        if name in task['delivery']['allowedExistingFiles']:
                            (root/name).write_text(text)
                else:
                    fixtures.apply(task, root)
                test_fixtures.apply(task, root)
            before_checks = delivery.snapshot(root, task['delivery'].get('generatedDirectories',[]))
            if execute('reference-behavior', probe):
                return result
            if task['kind'] == 'refactor' and execute('reference-structure', ['node',str(HARNESS/'evals/preview-eval16-v2/structure-probe.mjs'),str(root),task['slug']]):
                return result
            result['referenceDelivery'] = delivery.check(task, initial, delivery.snapshot(root, task['delivery'].get('generatedDirectories',[])))
            if not result['referenceDelivery']['passed']:
                raise RuntimeError('Reference delivery boundary failed: ' + str(result['referenceDelivery']['failed']))
            if task['kind'] == 'feature' and execute('reference-types-contract', ['node',str(HARNESS/'evals/preview-eval16-v2/type-probe.mjs'),str(root),task['slug']]):
                return result
            if candidate or '--full' in sys.argv:
                if execute('reference-package', ['npm','test']):
                    return result
                if task['repo'] == 'fastify/fast-uri':
                    if execute('reference-lint', ['npm','run','lint']):
                        return result
                    execute('reference-types', ['npm','run','test:typescript'])
            result['postChecksDelivery'] = delivery.check(task, initial, delivery.snapshot(root, task['delivery'].get('generatedDirectories',[])))
            if not result['postChecksDelivery']['passed']:
                raise RuntimeError('Post-check delivery boundary failed: ' + str(result['postChecksDelivery']['failed']))
            if before_checks != delivery.snapshot(root, task['delivery'].get('generatedDirectories',[])):
                raise RuntimeError('Artifact changed during verification')
            if (not candidate and '--mutants' in sys.argv) or (candidate and task['kind']=='tests'):
                result['mutants'] = []
                for mutant in mutants.MUTANTS[task['slug']]:
                    path, original = mutants.apply(task, root, mutant)
                    try:
                        code = execute('mutant-' + mutant[0], probe)
                        output = (record/('mutant-' + mutant[0] + '.log')).read_text()
                        rejected = code == 1 and ('ERR_ASSERTION' in output or 'AssertionError' in output or 'test failed' in output or 'tests failed' in output or '\nnot ok ' in output and 'operator: equal' in output) and not any(word in output for word in ['ERR_MODULE_NOT_FOUND', 'Cannot find module', 'SyntaxError', 'EPERM', 'ENOENT'])
                        result['mutants'].append({'id': mutant[0], 'rejected': rejected})
                    finally:
                        path.write_text(original)
            result['referenceFiles'] = {str(p.relative_to(root)):p.read_text() for p in root.rglob('*')
                                        if p.is_file() and not p.is_symlink() and 'node_modules' not in p.parts
                                        and ((source/p.relative_to(root)).is_file() and p.read_bytes() != (source/p.relative_to(root)).read_bytes() or str(p.relative_to(root)) in task['delivery']['allowedNewFiles'])}
        result['passed'] = all(c['exitCode']==0 for c in result['checks'] if c['name'].startswith('reference-')) and all(m['rejected'] for m in result.get('mutants',[]))
        return result
    except Exception as error:
        result['preparationError'] = str(error)
        return result
    finally:
        assert environment.digest_tree(deps / 'node_modules') == dependency['dependencyTree']
        (record/'result.json').write_text(json.dumps(result, indent=2))
        print(json.dumps({'task': task['slug'], 'checks': result['checks'], 'error': result.get('preparationError'), 'evidence': str(record.relative_to(BASE))}), flush=True)


if __name__ == '__main__':
    processes.install_stop_handlers()
    catalog = json.loads(environment.sources.CATALOG.read_text())
    selected = set(sys.argv[1:]) - {'--full','--mutants'}
    tasks = [t for t in catalog['tasks'] if t['kind'] in ['feature','refactor','tests','bug'] and (not selected or t['slug'] in selected)]
    assert tasks and not selected - {t['slug'] for t in tasks}, 'Unknown task selector'
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(run, tasks))
    if not all(not r.get('preparationError') and all(m['rejected'] for m in r.get('mutants',[])) and all(c['exitCode'] == 0 for c in r['checks'] if c['name'].startswith('reference-')) for r in results):
        raise SystemExit(1)
