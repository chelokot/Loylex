import base64
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1] / 'skills/gitlab-repo-zip'))
import export_repo

# Assembled at runtime so the repository never contains a literal token-shaped string.
FAKE_TOKEN = 'gl' + 'pat-' + 'A' * 20
GIT_IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid']


class ExportRepoTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def make_project(self, files):
        """Create a bare project, shaped like a GitLab clone source, with one commit."""
        work = self.root / 'work'
        subprocess.run(['git', 'init', '-q', '-b', 'main', str(work)], check=True)
        for name, text in files.items():
            path = work / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        subprocess.run(['git', '-C', str(work), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(work), *GIT_IDENTITY, 'commit', '-q', '-m', 'init'], check=True)
        bare = self.root / 'project.git'
        subprocess.run(['git', 'clone', '-q', '--bare', str(work), str(bare)], check=True)
        return bare

    def test_symlink_is_stored_as_a_link_and_not_followed(self):
        outside = self.root / 'outside.txt'
        outside.write_text('LOCAL-ONLY-CONTENT')
        tree = self.root / 'tree'
        tree.mkdir()
        (tree / 'README.md').write_text('hello')
        os.symlink(outside, tree / 'leak')
        zip_path = self.root / 'tree.zip'
        with zipfile.ZipFile(zip_path, 'w') as archive:
            export_repo.add_tree(archive, tree)
        with zipfile.ZipFile(zip_path) as archive:
            link = archive.getinfo('leak')
            self.assertTrue(stat.S_ISLNK(link.external_attr >> 16))
            self.assertEqual(archive.read('leak'), str(outside).encode())
            self.assertEqual(archive.read('README.md'), b'hello')
            contents = b''.join(archive.read(name) for name in archive.namelist())
        self.assertNotIn(b'LOCAL-ONLY-CONTENT', contents)

    def test_archive_containing_the_token_is_reported(self):
        zip_path = self.root / 'leak.zip'
        with zipfile.ZipFile(zip_path, 'w') as archive:
            archive.writestr('config', f'url = https://example.invalid/{FAKE_TOKEN}')
        leaked, findings = export_repo.scan_archive(zip_path, FAKE_TOKEN)
        self.assertEqual(leaked, ['config'])
        self.assertEqual(findings, [{'path': 'config', 'rule': 'gitlab-token'}])

    def test_token_split_across_read_chunks_is_still_found(self):
        payload = b'x' * 12 + FAKE_TOKEN.encode() + b'y' * 5
        with mock.patch.object(export_repo, 'CHUNK_BYTES', 16):
            token_seen, _ = export_repo.scan_stream(io.BytesIO(payload), FAKE_TOKEN.encode())
        self.assertTrue(token_seen)

    def test_secret_rules_report_only_rule_names(self):
        zip_path = self.root / 'settings.zip'
        with zipfile.ZipFile(zip_path, 'w') as archive:
            archive.writestr('settings.txt', 'key = ' + 'glpat' + '-' + 'b' * 22)
        leaked, findings = export_repo.scan_archive(zip_path, 'not-in-archive')
        self.assertEqual(leaked, [])
        self.assertEqual(findings, [{'path': 'settings.txt', 'rule': 'gitlab-token'}])

    def test_token_file_must_be_owner_only(self):
        with mock.patch.object(export_repo, 'CONFIG_DIR', self.root):
            token = self.root / 'token'
            token.write_text(FAKE_TOKEN + '\n')
            token.chmod(0o640)
            with self.assertRaises(export_repo.ExportError):
                export_repo.read_config('token', owner_only=True)
            token.chmod(0o600)
            self.assertEqual(export_repo.read_config('token', owner_only=True), FAKE_TOKEN)

    def test_project_url_must_be_plain_https(self):
        for url in [
            'http://gitlab.example.com/group/project.git',
            'https://user:secret@gitlab.example.com/group/project.git',
            'https://gitlab.example.com/group/project.git?x=1',
            'https://gitlab.example.com/group/project .git',
        ]:
            with self.subTest(url=url), self.assertRaises(export_repo.ExportError):
                export_repo.validate_project_url(url)
        url = 'https://gitlab.example.com/group/project.git'
        self.assertEqual(export_repo.validate_project_url(url), url)

    def test_clone_passes_the_token_only_through_the_environment(self):
        url = 'https://gitlab.example.com/group/dungeon-dreamer.git'
        done = subprocess.CompletedProcess(args=[], returncode=0, stdout='', stderr='')
        with mock.patch.object(export_repo.subprocess, 'run', return_value=done) as run:
            export_repo.clone(url, FAKE_TOKEN, self.root / 'repo')
        command = run.call_args.args[0]
        environment = run.call_args.kwargs['env']
        self.assertNotIn(FAKE_TOKEN, ' '.join(command))
        self.assertEqual(environment['GIT_CONFIG_KEY_1'], f'http.{url}.extraHeader')
        basic = base64.b64encode(f'oauth2:{FAKE_TOKEN}'.encode()).decode()
        self.assertEqual(environment['GIT_CONFIG_VALUE_1'], f'Authorization: Basic {basic}')

    def test_clone_failure_message_redacts_the_token(self):
        failed = subprocess.CompletedProcess(args=[], returncode=128, stdout='', stderr=f'fatal: rejected {FAKE_TOKEN}')
        with mock.patch.object(export_repo.subprocess, 'run', return_value=failed):
            with self.assertRaises(export_repo.ExportError) as caught:
                export_repo.clone('https://gitlab.example.com/group/project.git', FAKE_TOKEN, self.root / 'repo')
        self.assertNotIn(FAKE_TOKEN, str(caught.exception))

    def test_export_zips_the_full_history_and_leaves_only_the_zip(self):
        bare = self.make_project({'game.gd': 'extends Node\n', 'docs/notes.md': 'hello'})
        out = self.root / 'out'
        report = export_repo.export(str(bare), FAKE_TOKEN, out)
        zip_path = Path(report['zip'])
        self.assertEqual(zip_path.parent, out)
        self.assertEqual([path.name for path in out.iterdir()], [zip_path.name])
        self.assertTrue(zip_path.name.startswith('project-'))
        self.assertEqual(len(report['head']), 12)
        self.assertEqual(report['branches'], 1)
        self.assertFalse(report['lfs'])
        self.assertEqual(report['secret_findings'], [])
        with zipfile.ZipFile(zip_path) as archive:
            names = archive.namelist()
            config = archive.read('.git/config').decode()
        self.assertIn('game.gd', names)
        self.assertIn('docs/notes.md', names)
        self.assertIn('.git/HEAD', names)
        self.assertNotIn(FAKE_TOKEN, config)

    def test_export_reports_secret_findings_without_values(self):
        bare = self.make_project({'config.txt': 'key = ' + 'glpat' + '-' + 'c' * 22})
        report = export_repo.export(str(bare), FAKE_TOKEN, self.root / 'out')
        self.assertIn({'path': 'config.txt', 'rule': 'gitlab-token'}, report['secret_findings'])
        self.assertNotIn('c' * 22, json.dumps(report))

    def test_export_refuses_a_repository_that_contains_the_token(self):
        bare = self.make_project({'notes.txt': f'oops {FAKE_TOKEN}'})
        out = self.root / 'out'
        with self.assertRaises(export_repo.ExportError):
            export_repo.export(str(bare), FAKE_TOKEN, out)
        self.assertEqual(list(out.iterdir()), [])

    def test_export_refuses_a_zip_above_the_telegram_limit(self):
        bare = self.make_project({'big.bin': 'x' * 4096})
        out = self.root / 'out'
        with mock.patch.object(export_repo, 'DOCUMENT_LIMIT_BYTES', 100):
            with self.assertRaises(export_repo.ExportError):
                export_repo.export(str(bare), FAKE_TOKEN, out)
        self.assertEqual(list(out.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
