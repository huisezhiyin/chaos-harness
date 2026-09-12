import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('grader', Path(__file__).with_name('grade.py'))
grader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grader)


class GradeTest(unittest.TestCase):
    def prepare(self, slug):
        task = next(t for t in json.loads(grader.checker.environment.sources.CATALOG.read_text())['tasks'] if t['slug']==slug)
        temporary = tempfile.TemporaryDirectory(prefix='eval20-grader-contract-')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()/'repo'
        key = task['repo'].replace('/', '--')+'-'+task['head']
        shutil.copytree(grader.checker.BASE/'sources'/key/'repo',root)
        (root/'node_modules').mkdir()
        for item in (grader.checker.BASE/'dependencies-v2'/key/'node_modules').iterdir():
            (root/'node_modules'/item.name).symlink_to(item)
        (root/'node_modules/.cache').mkdir()
        (root/'test/.chaos-tmp').mkdir(parents=True,exist_ok=True)
        grader.checker.test_fixtures.apply(task,root)
        return task,root,{'root':str(root),'sourceHead':task['head']}

    def test_real_candidate_repair_passes_and_protected_change_fails(self):
        task,root,admission = self.prepare('map-aborted-listener')
        reference=json.loads((grader.checker.BASE/'references'/task['slug']/'reference.json').read_text())
        for name,text in reference['files'].items():
            if name in task['delivery']['allowedExistingFiles']:
                (root/name).write_text(text)
        self.assertTrue(grader.grade(task['id'],str(root),admission=admission)['passed'])
        (root/'package.json').write_text('{}')
        result=grader.grade(task['id'],str(root),admission=admission)
        self.assertFalse(result['passed'])
        self.assertIn('protected:package.json',result['failed'])

    def test_test_delivery_must_kill_mutants_not_merely_pass(self):
        task,root,admission = self.prepare('uri-resolution-components')
        self.assertTrue(grader.grade(task['id'],str(root),admission=admission)['passed'])
        (root/task['delivery']['requiredNewTestFile']).write_text("'use strict'\n\nconst test = require('tape')\n\ntest('placeholder', t => {\n  t.pass()\n  t.end()\n})\n")
        result=grader.grade(task['id'],str(root),admission=admission)
        self.assertFalse(result['passed'])
        self.assertTrue(any(f.startswith('new-tests-miss:') for f in result['failed']))


if __name__ == '__main__':
    unittest.main()
