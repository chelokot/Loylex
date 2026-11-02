import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from loylex_reviewed_images import ReviewedImages
from loylex_supervisor_errors import SupervisorError


class ReviewedImagesTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.compose = Path(self.temporary.name) / 'compose.yaml'
        self.original = 'services:\n  gateway:\n    image: ghcr.io/chelokot/loylex-gateway@sha256:' + '1'*64 + '\n  agent-blue:\n    image: ghcr.io/chelokot/loylex-agent@sha256:' + '2'*64 + '\n  agent-green:\n    image: ghcr.io/chelokot/loylex-agent@sha256:' + '3'*64 + '\n'
        self.compose.write_text(self.original)
        self.supervisor = mock.Mock()
        self.supervisor.lock = threading.RLock()
        self.supervisor.worker = None
        self.supervisor.active_agent_slot = 'blue'
        self.supervisor._inactive_agent_slot.return_value = 'green'
        self.supervisor._compose_path.return_value = self.compose
        self.supervisor._atomic_write.side_effect = lambda path, data: path.write_text(data)
        self.commit = 'a'*40
        self.metadata = [{'Digest': 'sha256:'+'f'*64, 'Labels': {'org.opencontainers.image.revision': self.commit}}]
        self.supervisor._reviewed_command.side_effect = lambda args: json.dumps(self.metadata) if 'inspect' in args else ''

    def test_pins_both_images_and_keeps_old_agent_slot(self):
        ReviewedImages.deploy_reviewed(self.supervisor, self.commit, {"agent": "sha256:"+"f"*64, "gateway": "sha256:"+"f"*64})
        content = self.compose.read_text()
        self.assertIn('ghcr.io/chelokot/loylex-gateway@sha256:'+'f'*64, content)
        self.assertIn('ghcr.io/chelokot/loylex-agent@sha256:'+'f'*64, content)
        self.assertIn('ghcr.io/chelokot/loylex-agent@sha256:'+'2'*64, content)
        self.supervisor._roll_agent.assert_called_once_with('green')
        pulls = [call.args[0] for call in self.supervisor._reviewed_command.call_args_list if 'pull' in call.args[0]]
        self.assertEqual(pulls, [['podman', 'pull', 'ghcr.io/chelokot/loylex-gateway@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'],
                                 ['podman', 'pull', 'ghcr.io/chelokot/loylex-agent@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff']])

    def test_substituted_image_rejected_before_compose_mutation(self):
        for metadata in ([{'Digest': 'sha256:'+'f'*64, 'Labels': {'org.opencontainers.image.revision': 'b'*40}}],
                         [{'Digest': 'latest', 'Labels': {'org.opencontainers.image.revision': self.commit}}]):
            self.metadata = metadata
            with self.assertRaises(SupervisorError):
                ReviewedImages.deploy_reviewed(self.supervisor, self.commit, {"agent": "sha256:"+"f"*64, "gateway": "sha256:"+"f"*64})
            self.assertEqual(self.compose.read_text(), self.original)
        self.supervisor._restart_gateway.assert_not_called()
        self.supervisor._roll_agent.assert_not_called()

    def test_failed_rollout_restores_images(self):
        self.supervisor._roll_agent.side_effect = SupervisorError('health failed')
        with self.assertRaises(SupervisorError):
            ReviewedImages.deploy_reviewed(self.supervisor, self.commit, {"agent": "sha256:"+"f"*64, "gateway": "sha256:"+"f"*64})
        self.assertEqual(self.compose.read_text(), self.original)
        self.assertEqual(self.supervisor._restart_gateway.call_count, 2)

    def test_registered_generation_never_replayed_after_failed_drain(self):
        def fail(target):
            self.supervisor.active_agent_slot = target
            raise SupervisorError('drain failed')
        self.supervisor._roll_agent.side_effect = fail
        with self.assertRaises(SupervisorError):
            ReviewedImages.deploy_reviewed(self.supervisor, self.commit, {"agent": "sha256:"+"f"*64, "gateway": "sha256:"+"f"*64})
        self.assertIn('sha256:'+'f'*64, self.compose.read_text())
        self.assertEqual(self.supervisor._restart_gateway.call_count, 1)
