"""Read-only filesystem and delivery operations for the JavaScript orchestrator."""
import importlib.util
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('delivery', Path(__file__).with_name('delivery.py'))
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)

if sys.argv[1] == 'snapshot':
    root = Path(sys.argv[2])
    catalog = json.loads(Path(__file__).with_name('catalog.json').read_text())
    task = next(t for t in catalog['tasks'] if t['id'] == root.name)
    print(json.dumps(delivery.snapshot(root, task['delivery'].get('generatedDirectories',[])), sort_keys=True))
elif sys.argv[1] == 'boundary':
    data = json.load(sys.stdin)
    print(json.dumps(delivery.check(data['task'], data['initial'], data['current'])))
else:
    raise SystemExit('Unknown read-only operation')
