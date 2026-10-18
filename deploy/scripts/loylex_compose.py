import sys
from pathlib import Path

from loylex_supervisor_errors import SupervisorError


SERVICE_REPOSITORIES = {
    "gateway": "ghcr.io/chelokot/loylex-gateway",
    "agent-blue": "ghcr.io/chelokot/loylex-agent",
    "agent-green": "ghcr.io/chelokot/loylex-agent",
}


def _image_index(lines: list[str], service: str) -> int:
    """Locate the one image of one top-level Compose service, without touching other slots."""
    repository = SERVICE_REPOSITORIES[service]
    services_index = next((index for index, line in enumerate(lines) if line == "services:"), None)
    if services_index is None:
        raise SupervisorError("Compose file has no services section")

    service_header = f"  {service}:"
    service_indexes = [index for index in range(services_index + 1, len(lines)) if lines[index] == service_header]
    if len(service_indexes) != 1:
        raise SupervisorError(f"Expected exactly one Compose service: {service}")
    service_index = service_indexes[0]

    service_end = len(lines)
    for index in range(service_index + 1, len(lines)):
        if lines[index] and not lines[index].startswith("   "):
            service_end = index
            break

    expected_images: list[int] = []
    for index in range(service_index + 1, service_end):
        line = lines[index]
        if not line.startswith("    image:"):
            continue
        value = line[len("    image:"):].strip()
        if value == repository or value.startswith(f"{repository}:") or value.startswith(f"{repository}@"):
            expected_images.append(index)
    if len(expected_images) != 1:
        raise SupervisorError(f"Expected exactly one image for {service} using {repository}")
    return expected_images[0]


def compose_image(content: str, service: str) -> str:
    lines = content.splitlines()
    return lines[_image_index(lines, service)][len("    image:"):].strip()


def replace_compose_image_line(content: str, service: str, reference: str) -> str:
    lines = content.splitlines()
    lines[_image_index(lines, service)] = f"    image: {reference}"
    return "\n".join(lines) + "\n"


def carry_deployed_images(deployed: str, declared: str) -> str:
    """Keep the images the supervisor deployed when the installer refreshes the declared Compose file."""
    for service in SERVICE_REPOSITORIES:
        declared = replace_compose_image_line(declared, service, compose_image(deployed, service))
    return declared


if __name__ == "__main__":
    deployed_path, declared_path = sys.argv[1:]
    sys.stdout.write(carry_deployed_images(Path(deployed_path).read_text(), Path(declared_path).read_text()))
