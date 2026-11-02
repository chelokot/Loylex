#!/usr/bin/env python3
"""Run once as the existing Loylex host user, from an explicitly reviewed checkout."""
import hashlib
import json
import os
import py_compile
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


def command(*args):
    return subprocess.check_output(args, stderr=subprocess.DEVNULL).decode().strip()


def main():
    if len(sys.argv) != 2 or len(sys.argv[1]) != 40:
        raise SystemExit("Usage: bootstrap-pr-deploy.py REVIEWED_FULL_SHA (on host as Loylex user)")
    if Path('/run/.containerenv').exists() or Path('/.dockerenv').exists():
        raise SystemExit("Host maintenance only; never run in the agent container")
    if os.geteuid() == 0:
        raise SystemExit("Run as the existing rootless Loylex host user, not root")
    root = Path(__file__).resolve().parents[2]
    sha = command("git", "-C", str(root), "rev-parse", "HEAD")
    if sha != sys.argv[1] or command("git", "-C", str(root), "status", "--porcelain"):
        raise SystemExit("Expected a clean checkout of the exact reviewed SHA")
    home = Path.home()
    service = home / '.config/systemd/user/loylex-supervisor.service'
    token = home / '.config/loylex/supervisor-token'
    if not service.is_file() or not token.is_file():
        raise SystemExit("Existing host supervisor installation is required")
    scripts = root / 'deploy/scripts'
    # Import only reviewed, local static package/validation declarations. No fetch,
    # package installation, shell expansion, credential copying, or new listener.
    sys.path.insert(0, str(scripts))
    from loylex_approval_packages import INFRASTRUCTURE_FILES
    paths = [scripts / name for name in INFRASTRUCTURE_FILES]
    # Existing Compose and units remain under trusted host maintenance.
    # Reject a bootstrap that would silently claim those changes were applied.
    from loylex_compose import carry_deployed_images
    installed_compose = home / 'stack/compose.yaml'
    declared_compose = (root / 'deploy/compose/compose.yaml').read_text()
    current_compose = installed_compose.read_text()
    if carry_deployed_images(current_compose, declared_compose) != current_compose:
        raise SystemExit('Compose differs; review and apply its configuration through host maintenance first')
    for declared in (root / 'deploy/systemd').iterdir():
        installed = home / '.config/systemd/user' / declared.name
        if not installed.is_file() or installed.read_bytes() != declared.read_bytes():
            raise SystemExit('Systemd units differ; review and apply them through host maintenance first')
    for path in paths:
        expected = subprocess.check_output(['git', '-C', str(root), 'show', f'{sha}:deploy/scripts/{path.name}'])
        if path.is_symlink() or path.read_bytes() != expected:
            raise SystemExit("Installed source must match the reviewed Git object")
    with tempfile.TemporaryDirectory(prefix='loylex-pr-compile-') as temporary:
        for index, path in enumerate(paths):
            py_compile.compile(str(path), cfile=str(Path(temporary) / f'{index}.pyc'), doraise=True)
    state = home / '.local/state/loylex-approvals'
    if not state.is_dir():
        raise SystemExit("Existing approval state is required")
    import sqlite3
    database = sqlite3.connect(f'file:{state / "approvals.sqlite"}?mode=ro', uri=True)
    active = database.execute("SELECT COUNT(*) FROM approvals WHERE state IN ('preparing','pending','executing')").fetchone()[0]
    database.close()
    if active:
        raise SystemExit("Finish or cancel outstanding approvals before bootstrap")
    backup = state / f'pr-bootstrap-{time.time_ns()}'
    backup.mkdir(mode=0o700)
    destinations = [home / '.local/bin' / path.name for path in paths]
    destinations += [state / 'infrastructure-commit', state / 'pr-deploy-enabled', state / 'pr-deploy-host-tree']
    manifest = []
    for index, path in enumerate(destinations):
        if path.is_symlink():
            raise SystemExit("Refusing a symlink installation target")
        exists = path.is_file()
        if exists:
            shutil.copy2(path, backup / str(index))
        manifest.append({'path': str(path), 'existed': exists})
    (backup / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    print(f'Recovery backup: {backup}', flush=True)
    command('systemctl', '--user', 'stop', 'loylex-supervisor.service')
    try:
        for source, destination in zip(paths, destinations):
            temporary = destination.with_suffix('.pr-new')
            shutil.copyfile(source, temporary)
            temporary.chmod(0o755)
            os.replace(temporary, destination)
        (state / 'infrastructure-commit').write_text(sha + '\n')
        (state / 'pr-deploy-enabled').write_text(sha + '\n')
        (state / 'pr-deploy-host-tree').write_text(command('git', '-C', str(root), 'rev-parse', 'HEAD^{tree}') + '\n')
        command('systemctl', '--user', 'start', 'loylex-supervisor.service')
        healthy = False
        for _ in range(30):
            try:
                request = urllib.request.Request('http://127.0.0.1:8790/v1/status',
                    headers={'Authorization': 'Bearer ' + token.read_text().strip()})
                with urllib.request.urlopen(request, timeout=2) as response:
                    status = json.load(response)
                if status.get('services', {}).get('agent') == 'active' and status.get('services', {}).get('gateway') == 'active':
                    healthy = True
                    break
            except Exception:
                pass
            time.sleep(1)
        if not healthy:
            raise RuntimeError('Supervisor or services failed health verification')
    except BaseException:
        command('systemctl', '--user', 'stop', 'loylex-supervisor.service')
        for index, item in enumerate(manifest):
            target = Path(item['path'])
            if item['existed']:
                shutil.copy2(backup / str(index), target)
            elif target.exists():
                target.unlink()
        command('systemctl', '--user', 'start', 'loylex-supervisor.service')
        raise
    (backup / 'installed-sha256.json').write_text(json.dumps({path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}, indent=2))
    print(f'Installed reviewed PR deployment policy at {sha}. Persistent data and secrets were not replaced.')


if __name__ == '__main__':
    main()
