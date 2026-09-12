"""Fetch and verify public source trees only; never create an execution admission."""
import concurrent.futures, hashlib, io, json, os, subprocess, tarfile, tempfile
from pathlib import Path
CATALOG = Path(__file__).with_name('catalog.json')
BASE = Path.home() / '.local/state/chaos-harness/evals/preview-eval20-v1'

def fetch(url):
    return subprocess.check_output(['curl', '--fail', '--silent', '--show-error', '--location', '--max-time', '90', url])

def prepare(item):
    repo, head, tree = item
    folder = BASE / 'sources' / (repo.replace('/', '--') + '-' + head)
    record = folder / 'source.json'
    if record.exists():
        saved = json.loads(record.read_text())
        for p, h in saved['sha256'].items():
            if hashlib.sha256((folder / 'repo' / p).read_bytes()).hexdigest() != h:
                raise RuntimeError('Preserved source changed')
        return saved
    if folder.exists():
        raise RuntimeError('Partial preparation exists; preserve it: ' + str(folder))
    archive = fetch(f'https://codeload.github.com/{repo}/tar.gz/{head}')
    official = json.loads(fetch(f'https://api.github.com/repos/{repo}/git/trees/{tree}?recursive=1'))
    if official.get('truncated') or official.get('sha') != tree:
        raise RuntimeError('Incomplete source identity')
    blobs = {e['path']: e for e in official['tree'] if e['type'] != 'tree'}
    if any(e['type'] != 'blob' or e['mode'] not in ['100644', '100755'] for e in blobs.values()):
        raise RuntimeError('Unsupported source entry')
    content = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
        for member in tar:
            if member.isdir():
                continue
            if not member.isfile():
                raise RuntimeError('Non-regular archive entry')
            path = '/'.join(member.name.split('/')[1:])
            if path not in blobs or '..' in Path(path).parts or Path(path).is_absolute():
                raise RuntimeError('Unexpected archive path')
            data = tar.extractfile(member).read()
            actual = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
            if actual != blobs[path]['sha']:
                raise RuntimeError('Archive differs from official blob')
            content[path] = data
    if set(content) != set(blobs):
        raise RuntimeError('Archive is missing official files')
    folder.mkdir(parents=True, mode=0o700)
    for path, data in content.items():
        target = folder / 'repo' / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(int(blobs[path]['mode'], 8) & 0o777)
    result = {'repo': repo, 'head': head, 'tree': tree, 'archiveSha256': hashlib.sha256(archive).hexdigest(),
              'sha256': {p: hashlib.sha256(b).hexdigest() for p, b in sorted(content.items())},
              'sourceVerified': True, 'qualification': 'pending', 'providerCalls': 0}
    with record.open('x') as output:
        json.dump(result, output, indent=2)
    return result

if __name__ == '__main__':
    catalog = json.loads(CATALOG.read_text())
    identities = sorted({(t['repo'], t['head'], t['tree']) for t in catalog['tasks']})
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for result in pool.map(prepare, identities):
            print(json.dumps({k: result[k] for k in ['repo', 'head', 'sourceVerified', 'qualification', 'providerCalls']}), flush=True)
