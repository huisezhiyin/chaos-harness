"""Candidate delivery checks, independent of task behavior and model output."""
import hashlib
import os
import stat
from pathlib import Path


def snapshot(root, generated_directories=()):
    root = Path(root)
    result = {}

    def walk(folder):
        for item in sorted(folder.iterdir()):
            relative = item.relative_to(root).as_posix()
            # Mount and repository metadata identities are separate runtime checks.
            if relative in ['.git', 'node_modules']:
                continue
            info = item.lstat()
            generated = any(relative == p or relative.startswith(p + '/') for p in generated_directories)
            if generated and stat.S_ISDIR(info.st_mode):
                walk(item)
                continue
            if generated and stat.S_ISREG(info.st_mode) and relative not in generated_directories:
                continue
            record = {'mode': stat.S_IMODE(info.st_mode)}
            if stat.S_ISLNK(info.st_mode):
                record.update(type='link', target=os.readlink(item))
            elif stat.S_ISDIR(info.st_mode):
                record.update(type='directory')
                walk(item)
            elif stat.S_ISREG(info.st_mode):
                data = item.read_bytes()
                record.update(type='file', size=len(data), sha256=hashlib.sha256(data).hexdigest())
            else:
                record.update(type='special')
            result[relative] = record
    walk(root)
    return result


def check(task, initial, current):
    policy = task['delivery']
    allowed_existing = set(policy['allowedExistingFiles'])
    allowed_new = set(policy['allowedNewFiles'])
    changed = sorted(p for p in initial.keys() | current.keys() if initial.get(p) != current.get(p))
    failed = []
    for path in changed:
        before, after = initial.get(path), current.get(path)
        if path == 'test/.chaos-tmp' or path.startswith('test/.chaos-tmp/'):
            failed.append('scratch-changed:' + path)
        if after is None:
            failed.append('deleted:' + path)
            continue
        if after['type'] == 'directory':
            if before is None and any(f.startswith(path + '/') for f in allowed_new):
                continue
            failed.append('directory-changed:' + path)
            continue
        if after['type'] != 'file':
            failed.append('non-regular:' + path)
        if before is not None:
            if path not in allowed_existing:
                failed.append('protected:' + path)
            if before['type'] != after['type'] or before['mode'] != after['mode']:
                failed.append('file-type-or-mode:' + path)
        elif path not in allowed_new:
            failed.append('unexpected:' + path)
        elif after['mode'] != 0o644:
            failed.append('new-file-mode:' + path)

    for path in policy['requiredChangedFiles']:
        if path not in changed or current.get(path, {}).get('type') != 'file':
            failed.append('required-change:' + path)
    test = policy['requiredNewTestFile']
    if test in initial or current.get(test, {}).get('type') != 'file' or not current.get(test, {}).get('size'):
        failed.append('new-tests-missing')
    implementation = allowed_existing - set(policy['requiredChangedFiles'])
    if policy['requireImplementationChange'] and not any(p in changed and current.get(p, {}).get('type') == 'file' for p in implementation):
        failed.append('implementation-missing')
    return {'passed': not failed, 'changed': changed, 'failed': sorted(set(failed))}
