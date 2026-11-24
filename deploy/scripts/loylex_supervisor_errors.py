class SupervisorError(Exception):
    pass


class BusyError(SupervisorError):
    pass


def git_failure_category(stderr: bytes) -> str:
    # Return only fixed labels: remote output can contain credentials or hostile text.
    message = stderr[:65536].lower()
    categories = (
        ("Git HTTPS helper unavailable", (b"unable to find remote helper", b"git-remote-https", b"cannot run git-remote")),
        ("Git ownership check rejected repository", (b"dubious ownership", b"unsafe repository")),
        ("Git object unavailable on remote", (b"not our ref", b"unadvertised object", b"couldn't find remote ref")),
        ("Git storage limit or disk exhaustion", (b"file size limit exceeded", b"no space left", b"disk quota exceeded", b"file too large")),
        ("Git memory or process limit", (b"cannot allocate memory", b"out of memory", b"unable to create thread", b"resource temporarily unavailable")),
        ("Git repository locked", (b"another git process seems to be running", b"cannot lock ref")),
        ("Git transport interrupted", (b"early eof", b"remote end hung up", b"http/2", b"curl 18", b"curl 56", b"curl 92")),
        ("Git local permission denied", (b"permission denied", b"read-only file system")),
        ("Git pack transfer failed", (b"invalid index-pack output", b"index-pack failed")),
        ("authentication rejected", (b"authentication failed", b"invalid username or token", b"could not read username")),
        ("repository access denied", (b"permission to ", b"write access to repository not granted", b"repository not found", b"error: 403")),
        ("network or TLS failure", (b"could not resolve host", b"failed to connect", b"ssl certificate problem", b"connection reset", b"unable to access")),
        ("transport prohibited", (b"transport 'https' not allowed", b"transport 'file' not allowed")),
        ("missing Git objects", (b"bad object", b"not a valid object", b"missing blob", b"missing necessary objects")),
        ("remote ref rejected", (b"stale info", b"non-fast-forward", b"protected branch", b"repository rule violations")),
    )
    for label, patterns in categories:
        if any(pattern in message for pattern in patterns):
            return label
    return "unclassified Git failure"
