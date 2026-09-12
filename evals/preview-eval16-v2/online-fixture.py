"""Disposable reference candidate through the actual grader; no consumed target is read."""
import importlib.util,json,shutil,sys,tempfile
from pathlib import Path
sys.dont_write_bytecode=True
s=importlib.util.spec_from_file_location('g',Path(__file__).with_name('grade.py'));g=importlib.util.module_from_spec(s);s.loader.exec_module(g)
g.checker.processes.install_stop_handlers()
t=next(t for t in json.loads(g.checker.environment.sources.CATALOG.read_text())['tasks'] if t['slug']==sys.argv[1])
with tempfile.TemporaryDirectory(prefix='eval16-online-fixture-') as d:
 root=Path(d).resolve()/'repo';key=t['repo'].replace('/','--')+'-'+t['head']
 shutil.copytree(g.checker.BASE/'sources'/key/'repo',root)
 (root/'node_modules').mkdir()
 for p in (g.checker.BASE/'dependencies-v2'/key/'node_modules').iterdir():(root/'node_modules'/p.name).symlink_to(p)
 (root/'node_modules/.cache').mkdir();(root/'test/.chaos-tmp').mkdir(parents=True,exist_ok=True)
 if t['kind']=='bug':
  ref=json.loads((g.checker.BASE/'references'/t['slug']/'reference.json').read_text())
  for name,text in ref['files'].items():
   if name in t['delivery']['allowedExistingFiles']:(root/name).write_text(text)
 elif t['kind']!='tests':g.checker.fixtures.apply(t,root)
 g.checker.test_fixtures.apply(t,root)
 result=g.grade(t['id'],str(root),admission={'root':str(root),'sourceHead':t['head']})
 print(json.dumps(result));sys.exit(0 if result['passed'] else 1)
