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
