"""Read-only guard for historical witnesses and the explicitly authorized runtime delta."""
import hashlib,importlib.util,json,subprocess,sys
from pathlib import Path
sys.dont_write_bytecode=True
HERE=Path(__file__).parent;ROOT=HERE.parents[1];BASE=Path.home()/'.local/state/chaos-harness/evals/preview-eval16-v2'
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def check():
 pin=json.loads((HERE/'preservation-pin.json').read_text());assert digest(BASE/'preservation.json')==pin['sha256']
 saved=json.loads((BASE/'preservation.json').read_text())
 for path,expected in saved['files'].items():assert digest(Path(path))==expected,path
 original=json.loads((ROOT/'mydocs/freezes/2026-09-09_preview-eval20-prepared.json').read_text())
 for path,expected in original['sourceSha256'].items():assert digest(ROOT/path)==expected,path
 for root,expected in saved['targets'].items():
  current=json.loads(subprocess.check_output(['python3',str(HERE.parent/'preview-eval20-v1/state.py'),'snapshot',root],env={**__import__('os').environ,'PYTHONDONTWRITEBYTECODE':'1'}))
  assert current==expected['snapshot'],root
  assert subprocess.check_output(['git','-C',root,'rev-parse','HEAD']).decode().strip()==expected['head'],root
  assert (BASE.with_name('preview-eval20-v1')/Path(root).name/'run.started.json').exists()==expected['consumed'],root
 return {'privateFilesUnchanged':len(saved['files']),'oldTargetsUnchanged':len(saved['targets']),'oldEvalSourcesUnchanged':len(original['sourceSha256'])}
if __name__=='__main__':print(json.dumps(check()))
