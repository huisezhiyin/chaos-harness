"""Install private locked dependencies and run original checks in disposable source copies."""
import concurrent.futures, hashlib, json, os, shutil, subprocess, tempfile, time, sys
from pathlib import Path
from importlib.util import spec_from_file_location, module_from_spec
sys.dont_write_bytecode=True
spec=spec_from_file_location('sources',Path(__file__).with_name('prepare-sources.py'));sources=module_from_spec(spec);spec.loader.exec_module(sources)
BASE=sources.BASE

def digest_tree(root):
    result={}
    for p in sorted(root.rglob('*')):
        if p.is_symlink():result[str(p.relative_to(root))]='link:'+os.readlink(p)
        elif p.is_file():result[str(p.relative_to(root))]=hashlib.sha256(p.read_bytes()).hexdigest()
    return hashlib.sha256(json.dumps(result,sort_keys=True).encode()).hexdigest()

def prepare(identity):
    repo,head,tree=identity;key=repo.replace('/','--')+'-'+head;src=BASE/'sources'/key/'repo';deps=BASE/'dependencies-v2'/key;record=deps/'environment.json'
    if record.exists():
        saved=json.loads(record.read_text())
        if digest_tree(deps/'node_modules')!=saved['dependencyTree']:raise RuntimeError('Dependency drift')
        return saved
    if deps.exists():raise RuntimeError('Partial dependency preparation retained: '+key)
    deps.mkdir(parents=True,mode=0o700)
    shutil.copy2(src/'package.json',deps/'package.json')
    for name in ['package-lock.json','npm-shrinkwrap.json','.npmrc']:
        if (src/name).exists():shutil.copy2(src/name,deps/name)
    env={k:v for k,v in os.environ.items() if not any(s in k.upper() for s in ['TOKEN','SECRET','API_KEY','PASSWORD','AUTH'])}
    env.update(CI='true',PUPPETEER_SKIP_DOWNLOAD='true',PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD='1')
    attempt=str(time.time_ns())
    command=['npm','ci' if (deps/'package-lock.json').exists() else 'install','--package-lock=true','--ignore-scripts','--no-audit','--no-fund']
    with (deps/('install-'+attempt+'.log')).open('x') as log:
        code=subprocess.run(command,cwd=deps,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=300).returncode
    if code:raise RuntimeError('Dependency lock preparation failed; log retained: '+key)
    before=digest_tree(deps/'node_modules');checks=[]
    with tempfile.TemporaryDirectory(prefix='chaos-eval20-check-') as temporary:
        scratch=Path(temporary).resolve();copy=scratch/'repo';shutil.copytree(src,copy)
        mount=copy/'node_modules';mount.mkdir()
        for p in (deps/'node_modules').iterdir():(mount/p.name).symlink_to(p)
        (mount/'.cache').mkdir();(copy/'test/.chaos-tmp').mkdir(parents=True,exist_ok=True)
        env.update(TMPDIR=str(copy/'test/.chaos-tmp'),TMP=str(copy/'test/.chaos-tmp'),TEMP=str(copy/'test/.chaos-tmp'),NODE_COMPILE_CACHE=str(scratch/'compile-cache'),XDG_CACHE_HOME=str(scratch/'xdg'),npm_config_cache=str(scratch/'npm'),npm_config_offline='true',NODE_OPTIONS='--no-experimental-strip-types')
        commands=[['npm','test']]
        if repo=='fastify/fast-uri':commands += [['npm','run','lint'],['npm','run','test:typescript']]
        for i,command in enumerate(commands):
            start=time.monotonic();logpath=deps/f'baseline-check-{attempt}-{i}.log'
            policy='(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (literal "/dev/null") (subpath '+json.dumps(str(scratch))+'))'
            with logpath.open('w') as log:
                try:out=subprocess.run(['/usr/bin/sandbox-exec','-p',policy,*command],cwd=copy,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=180);code=out.returncode
                except subprocess.TimeoutExpired:code=124
            checks.append({'command':command,'exitCode':code,'elapsedSeconds':round(time.monotonic()-start,2),'logSha256':hashlib.sha256(logpath.read_bytes()).hexdigest()})
            if code:break
    if before!=digest_tree(deps/'node_modules'):raise RuntimeError('Dependency writes observed')
    result={'repo':repo,'head':head,'tree':tree,'dependencyTree':before,'lockSha256':hashlib.sha256((deps/'package-lock.json').read_bytes()).hexdigest(),'checks':checks,'originalChecksPassed':all(c['exitCode']==0 for c in checks),'qualification':'pending','providerCalls':0}
    with record.open('x') as output:json.dump(result,output,indent=2)
    print(json.dumps({k:result[k] for k in ['repo','head','originalChecksPassed','qualification','providerCalls']}),flush=True)
    return result
if __name__=='__main__':
    catalog=json.loads(sources.CATALOG.read_text());identities=sorted({(t['repo'],t['head'],t['tree']) for t in catalog['tasks']})
    # Shell-script batching; no model agents. Independent preparation directories only.
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:results=list(pool.map(prepare,identities))
    if not all(r['originalChecksPassed'] for r in results):raise SystemExit(1)
