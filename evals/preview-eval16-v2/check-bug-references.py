"""Reproduce public bugs and validate reference source changes, without model dispatch."""
import concurrent.futures, hashlib, json, os, shutil, subprocess, tempfile, time, sys
from pathlib import Path
from importlib.util import spec_from_file_location,module_from_spec
sys.dont_write_bytecode=True
spec=spec_from_file_location('environments',Path(__file__).with_name('prepare-environments.py'));e=module_from_spec(spec);spec.loader.exec_module(e)
BASE=e.BASE;HARNESS=Path(__file__).resolve().parents[2]

def reference(t,source):
    record=BASE/'references'/t['slug']/'reference.json'
    if record.exists():
        saved=json.loads(record.read_text())
        if saved['referenceCommit'] != t['referenceCommit']:raise RuntimeError('Reference identity changed; preserve old evidence')
        return saved
    out={}
    if t['referenceCommit']:
        commit=json.loads(e.sources.fetch(f"https://api.github.com/repos/{t['repo']}/commits/{t['referenceCommit']}"))
        for f in commit['files']:
            path=f['filename']
            if path not in t['sourceFiles'] or not path.endswith(('.js','.ts')):continue
            data=e.sources.fetch(f"https://raw.githubusercontent.com/{t['repo']}/{t['referenceCommit']}/{path}")
            assert hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()==f['sha']
            out[path]=data.decode()
    else:
        data=(source/'base.js').read_text();needle='\tconst formatter = parserForArrayFormat(options);'
        assert data.count(needle)==1
        out['base.js']=data.replace(needle,'\toptions.types = {__proto__: null, ...options.types};\n\n'+needle)
    assert out
    record.parent.mkdir(parents=True,mode=0o700)
    value={'files':out,'referenceCommit':t['referenceCommit'],'origin':'upstream changed implementation files' if t['referenceCommit'] else 'owner repair from issue contract'}
    with record.open('x') as f:json.dump(value,f,indent=2)
    return value

def check(t):
    key=t['repo'].replace('/','--')+'-'+t['head'];src=BASE/'sources'/key/'repo';deps=BASE/'dependencies-v2'/key
    environment=json.loads((deps/'environment.json').read_text())
    if not environment['originalChecksPassed']:return {'task':t['slug'],'blocked':'original package checks failed'}
    ref=reference(t,src);record=BASE/'bug-reference-checks'/t['slug'];record.mkdir(parents=True,exist_ok=True)
    results=[];before=e.digest_tree(deps/'node_modules')
    for mode in ['baseline','reference']:
        with tempfile.TemporaryDirectory(prefix='chaos-eval20-bug-') as tmp:
            scratch=Path(tmp).resolve();root=scratch/'repo';shutil.copytree(src,root);(root/'node_modules').mkdir()
            for p in (deps/'node_modules').iterdir():(root/'node_modules'/p.name).symlink_to(p)
            (root/'node_modules/.cache').mkdir();(root/'test/.chaos-tmp').mkdir(parents=True,exist_ok=True)
            if mode=='reference':
                for name,text in ref['files'].items():(root/name).write_text(text)
            env={k:v for k,v in os.environ.items() if not any(x in k.upper() for x in ['TOKEN','SECRET','API_KEY','PASSWORD','AUTH'])}
            env.update(CI='true',TMPDIR=str(root/'test/.chaos-tmp'),TMP=str(root/'test/.chaos-tmp'),TEMP=str(root/'test/.chaos-tmp'),NODE_COMPILE_CACHE=str(scratch/'compile-cache'),XDG_CACHE_HOME=str(scratch/'xdg'),npm_config_cache=str(scratch/'npm'),npm_config_offline='true',NODE_OPTIONS='--no-experimental-strip-types')
            policy='(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (literal "/dev/null") (subpath '+json.dumps(str(scratch))+'))'
            commands=[['node']+(['--import=tsx/esm'] if t['repo'].endswith('/p-queue') else [])+[str(HARNESS/'evals/preview-eval16-v2/bug-probe.mjs'),str(root),t['slug']]]
            if mode=='reference':commands += [['npm','test']]+([['npm','run','lint'],['npm','run','test:typescript']] if t['repo']=='fastify/fast-uri' else [])
            checks=[]
            for i,command in enumerate(commands):
                log=record/f'{mode}-{time.time_ns()}-{i}.log'
                with log.open('x') as output:
                    try:code=subprocess.run(['/usr/bin/sandbox-exec','-p',policy,*command],cwd=root,env=env,stdout=output,stderr=subprocess.STDOUT,timeout=180).returncode
                    except subprocess.TimeoutExpired:code=124
                checks.append({'probe':i==0,'exitCode':code,'log':log.name,'sha256':hashlib.sha256(log.read_bytes()).hexdigest()})
                if i==0:
                    lines=log.read_text().splitlines()
                    try:checks[-1]['verdict']=json.loads(lines[-1])
                    except (json.JSONDecodeError,IndexError):checks[-1]['verdict']={'infrastructureError':True}
                if code:break
            results.append({'mode':mode,'checks':checks})
    assert before==e.digest_tree(deps/'node_modules')
    result={'task':t['id'],'head':t['head'],'tree':t['tree'],'referenceCommit':t['referenceCommit'],'checks':results,'baselineDefectObserved':results[0]['checks'][0].get('verdict',{}).get('passed') is False and results[0]['checks'][0].get('verdict',{}).get('errorCode') == ('ERR_INVALID_URL' if t['slug']=='query-relative-fragment' else 'ERR_ASSERTION'),'referencePassed':all(x['exitCode']==0 for x in results[1]['checks']),'qualification':'pending-independent-mutants-and-delivery-boundary','providerCalls':0}
    with (record/f'check-{time.time_ns()}.json').open('x') as f:json.dump(result,f,indent=2)
    print(json.dumps({k:result[k] for k in ['task','baselineDefectObserved','referencePassed','qualification']}),flush=True)
    return result
if __name__=='__main__':
    tasks=[t for t in json.loads(e.sources.CATALOG.read_text())['tasks'] if t['kind']=='bug' and (len(sys.argv)==1 or t['slug'] in sys.argv[1:])]
    if not tasks or set(sys.argv[1:])-set(t['slug'] for t in tasks):raise SystemExit('Unknown bug task selector')
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:results=list(pool.map(check,tasks))
    if not all(r.get('baselineDefectObserved') and r.get('referencePassed') for r in results):raise SystemExit(1)
