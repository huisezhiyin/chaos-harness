"""Import qualified source trees as detached evaluation repositories. No branches/worktrees."""
import hashlib
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('state', Path(__file__).with_name('prepare-sources.py'))
source_tools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source_tools)
BASE = source_tools.BASE


def command(root, args, **kwargs):
    return subprocess.check_output(['git','-C',str(root),*args], text=True, **kwargs).strip()


def bootstrap():
    catalog = json.loads(source_tools.CATALOG.read_text())
    qualification = json.loads((BASE/'qualification.json').read_text())
    assert qualification['passed'] and len(qualification['tasks']) == len(catalog['tasks']) == 20
    for task in catalog['tasks']:
        state = BASE/task['id']
        root = Path.home()/'github_project/chaos-dogfood'/task['id']
        record = state/'bootstrap.json'
        if record.exists():
            saved = json.loads(record.read_text())
            assert command(root,['rev-parse','HEAD']) == saved['head']
            continue
        if root.exists() or state.exists():
            raise RuntimeError('Partial preparation retained: ' + task['id'])
        key = task['repo'].replace('/', '--') + '-' + task['head']
        original = BASE/'sources'/key
        source_record = json.loads((original/'source.json').read_text())
        state.mkdir(parents=True,mode=0o700)
        shutil.copytree(original/'repo',root)
        command(root,['init','--quiet'])
        index = []
        for name, expected in sorted(source_record['sha256'].items()):
            path = root/name
            assert hashlib.sha256(path.read_bytes()).hexdigest() == expected
            blob = command(root,['hash-object','-w','--',name])
            mode = '100755' if path.stat().st_mode & stat.S_IXUSR else '100644'
            index.append(mode + ' ' + blob + '\t' + name)
        command(root,['update-index','--index-info'],input='\n'.join(index)+'\n')
        assert command(root,['write-tree']) == task['tree'], 'Official tree differs'
        head = command(root,['-c','user.name=Chaos Evaluation','-c','user.email=eval@localhost','commit-tree',task['tree'],'-m','Independent archive baseline '+task['head']])
        command(root,['update-ref','--no-deref','HEAD',head])
        command(root,['remote','add','origin',task['repository']])
        assert command(root,['for-each-ref','--format=%(refname)','refs/heads']) == ''
        deps = BASE/'dependencies-v2'/key/'node_modules'
        (root/'node_modules').mkdir()
        for item in deps.iterdir():
            (root/'node_modules'/item.name).symlink_to(item)
        (root/'node_modules/.cache').mkdir()
        (root/'test/.chaos-tmp').mkdir(parents=True,exist_ok=True)
        record.write_text(json.dumps({'task':task['id'],'root':str(root),'head':head,'sourceHead':task['head'],'tree':task['tree']}))
        print(json.dumps({'task':task['id'],'prepared':True,'providerCalls':0}),flush=True)


if __name__ == '__main__':
    bootstrap()
