import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('delivery', Path(__file__).with_name('delivery.py'))
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)


class DeliveryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'index.js').write_text('original')
        (self.root / 'package.json').write_text('{}')
        (self.root / 'test').mkdir()
        (self.root / 'test/original.js').write_text('protected test')
        (self.root / 'test/.chaos-tmp').mkdir()
        self.initial = delivery.snapshot(self.root)
        self.task = {'delivery': {'allowedExistingFiles': ['index.js'],
                     'allowedNewFiles': ['test/new.js'], 'requiredChangedFiles': [],
                     'requireImplementationChange': True, 'requiredNewTestFile': 'test/new.js'}}
        (self.root / 'index.js').write_text('repaired')
        (self.root / 'test/new.js').write_text('new test')

    def verdict(self):
        return delivery.check(self.task, self.initial, delivery.snapshot(self.root))

    def test_regular_delivery(self):
        self.assertTrue(self.verdict()['passed'])

    def test_protected_tests(self):
        (self.root / 'test/original.js').write_text('weakened')
        self.assertIn('protected:test/original.js', self.verdict()['failed'])

    def test_symlink_cannot_supply_required_test(self):
        (self.root / 'test/new.js').unlink()
        (self.root / 'test/new.js').symlink_to(self.root / 'test/original.js')
        self.assertIn('new-tests-missing', self.verdict()['failed'])

    def test_empty_scratch_subdirectory_is_rejected(self):
        (self.root / 'test/.chaos-tmp/opencode').mkdir()
        self.assertFalse(self.verdict()['passed'])

    def test_source_permission_change(self):
        (self.root / 'index.js').chmod(0o755)
        self.assertIn('file-type-or-mode:index.js', self.verdict()['failed'])

    def test_manifest_change(self):
        (self.root / 'package.json').write_text('{"scripts":{"test":"true"}}')
        self.assertIn('protected:package.json', self.verdict()['failed'])

    def test_only_new_tests_is_insufficient_for_implementation(self):
        (self.root / 'index.js').write_text('original')
        self.assertIn('implementation-missing', self.verdict()['failed'])

    def test_test_only_task_rejects_source_changes(self):
        self.task['delivery'].update(allowedExistingFiles=[], requireImplementationChange=False)
        self.assertIn('protected:index.js', self.verdict()['failed'])

    def test_protected_deletion(self):
        (self.root / 'test/original.js').unlink()
        self.assertIn('deleted:test/original.js', self.verdict()['failed'])

    def test_new_hidden_directory(self):
        (self.root / '.cache').mkdir()
        self.assertFalse(self.verdict()['passed'])


if __name__ == '__main__':
    unittest.main()
