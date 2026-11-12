import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / 'deploy/scripts'))
import loylex_approval_packages as packages
import loylex_approval_review as review
import loylex_approval_validation as validation
import loylex_tailnet_policy as policy
from loylex_approval_host import ApprovalError, encoded
from tailnet_fixtures import publish_operation


class TailnetPolicyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)

    def test_validation_accepts_clean_requests_and_rejects_unsafe_ones(self):
        policy.validate_tailnet(publish_operation('anime-todo', {'index.html': b'<h1>x</h1>', 'assets/a.css': b'p{}'}))
        policy.validate_tailnet({'kind': 'tailnet', 'action': 'remove', 'name': 'anime-todo'})
        too_large = publish_operation('big-site', {'index.html': b'x' * (2 * 1024 * 1024 + 1)})
        unsafe = [
            publish_operation('../escape', {'index.html': b'x'}),
            publish_operation('Upper', {'index.html': b'x'}),
            publish_operation('a', {'index.html': b'x'}),
            publish_operation('ok-name', {'style.css': b'x'}),
            publish_operation('ok-name', {'index.html': b'x', '../x.html': b'x'}),
            publish_operation('ok-name', {'index.html': b'x', '/abs.html': b'x'}),
            publish_operation('ok-name', {'index.html': b'x', 'a/../b.html': b'x'}),
            publish_operation('ok-name', {'index.html': b'x', 'run.php': b'x'}),
            publish_operation('ok-name', {'index.html': b'x'}) | {'files': {'index.html': '!!not base64!!'}},
            publish_operation('ok-name', {'index.html': b'x'}) | {'extra': 1},
            {'kind': 'tailnet', 'action': 'sync', 'name': 'ok-name'},
            too_large,
            publish_operation('ok-name', {'index.html': b'x', 'a.js': b'y' * (3 * 1024 * 1024)}),
        ]
        for operation in unsafe:
            with self.subTest(name=operation.get('name')):
                with self.assertRaises(ApprovalError):
                    policy.validate_tailnet(operation)
                with self.assertRaises(ApprovalError):
                    validation.OperationValidation._validate_operation(operation)

    def test_snapshot_packages_a_tailnet_operation_with_its_manifest(self):
        # Regression: the tailnet snapshot branch must set base/head like the other kinds before packaging.
        class Snapshot(packages.ApprovalPackages):
            def __init__(self, root):
                self.root = root

        root = self.home / 'approvals'
        identifier = 'op-snapshot'
        (root / identifier).mkdir(parents=True)
        operation = publish_operation('anime-todo', {'index.html': b'<h1>x</h1>', 'a.css': b'p{}'})
        # submit() stores request.json before snapshotting; the snapshot reads it back for its audit files.
        (root / identifier / 'request.json').write_bytes(encoded(operation))
        package = Snapshot(root)._snapshot(identifier, operation)
        self.assertTrue(package.startswith(encoded(operation) + b'\n\n'))
        self.assertIn(b'TAILNET FILES', package)
        self.assertEqual((root / identifier / 'package.txt').read_bytes(), package)
        self.assertEqual(policy.tailnet_package_operation(package), operation)

    def test_tailnet_review_summarizes_without_the_file_bytes(self):
        operation = publish_operation('anime-todo', {'index.html': b'x' * 3000})
        package = encoded(operation) + b'\n\n' + policy.tailnet_manifest(operation)
        self.assertEqual(policy.tailnet_package_operation(package)['name'], 'anime-todo')
        summary = review.ApprovalReview._review(object(), 'op1', package)
        self.assertIn('/anime-todo/', summary)
        self.assertNotIn(base64.b64encode(b'x' * 100).decode()[:40], summary)
        self.assertIsNone(policy.tailnet_package_operation(b'{"kind": "push"}\n\nnot tailnet'))


if __name__ == '__main__':
    unittest.main()
