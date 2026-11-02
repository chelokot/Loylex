"""Digest-pinned deployment of the two images built for one approved merge."""
import json
import re

from loylex_compose import SERVICE_REPOSITORIES, replace_compose_image_line
from loylex_supervisor_errors import BusyError, SupervisorError


class ReviewedImages:
    def deploy_reviewed(self, commit: str, images: dict[str, str]) -> None:
        if not re.fullmatch(r"[a-f0-9]{40}", commit):
            raise SupervisorError("A full reviewed revision is required")
        if set(images) != {"agent", "gateway"} or any(
                not isinstance(value, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", value)
                for value in images.values()):
            raise SupervisorError("Both CI image digests are required")
        # The existing mutex excludes HTTP schedules and gateway approvals. RLock is
        # necessary because agent activation also persists its generation under it.
        with self.lock:
            if self.worker is not None and self.worker.is_alive():
                raise BusyError("Another supervisor operation is already active")
            target = self._inactive_agent_slot()
            self._check_agent()
            original = self._compose_path().read_text()
            updated = original
            for service in ("gateway", f"agent-{target}"):
                repository = SERVICE_REPOSITORIES[service]
                expected_digest = images["gateway" if service == "gateway" else "agent"]
                tag = f"{repository}@{expected_digest}"
                self._reviewed_command(["podman", "pull", tag])
                metadata = json.loads(self._reviewed_command(["podman", "image", "inspect", tag]))
                if len(metadata) != 1:
                    raise SupervisorError("Expected one image")
                image = metadata[0]
                revision = image.get("Labels", {}).get("org.opencontainers.image.revision")
                digest = image.get("Digest", "")
                if revision != commit or digest != expected_digest:
                    raise SupervisorError("CI image does not match reviewed merge")
                updated = replace_compose_image_line(updated, service, f"{repository}@{digest}")
            self._atomic_write(self._compose_path(), updated)
            try:
                self._restart_gateway()
                self._roll_agent(target)
            except Exception:
                # After a generation registers, retaining that generation prevents
                # queue replay. A failed drain needs inspection, never automatic replay.
                if self.active_agent_slot != target:
                    self._atomic_write(self._compose_path(), original)
                    self._restart_gateway()
                raise
