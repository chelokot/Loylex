import hashlib
import hmac
import json
import os
import re
import shutil
from pathlib import Path
from typing import Any

from loylex_approval_host import ApprovalError, command, encoded, https_request, secret
from loylex_approval_packages import (
    HOST_CONFIG_MODES,
    HOST_CONFIG_SOURCES,
    carry_images,
    host_config_normalized,
    read_host_file,
    replace_host_file,
)
from loylex_approval_validation import execute_t3


class ApprovalExecution:
    def _github(self, operation: dict[str, Any]) -> dict[str, Any]:
        status, data = https_request(
            "api.github.com",
            f"/repos/{operation['repository']}/{operation['resource']}",
            operation["method"],
            encoded(operation["body"]),
            {
                "Authorization": f"Bearer {secret('loylex-github-token')}",
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
                "User-Agent": "Loylex-Approvals",
            },
        )
        if status < 200 or status >= 300:
            raise ApprovalError(f"GitHub operation failed (HTTP {status})")
        result = json.loads(data) if data else {}
        return {
            "status": status,
            "url": result.get("html_url"),
            "number": result.get("number"),
            "id": result.get("id"),
        }

    def _execute(self, identifier: str) -> None:
        with self.execution_lock:
            self._execute_once(identifier)

    def _execute_once(self, identifier: str) -> None:
        try:
            directory = self.root / identifier
            package = (directory / "package.txt").read_bytes()
            row = self._row(identifier)
            if hashlib.sha256(package).hexdigest() != row["digest"]:
                raise ApprovalError("Saved package changed")
            operation = json.loads((directory / "operation.json").read_bytes())
            if not package.startswith(encoded(operation) + b"\n\n"):
                raise ApprovalError("Operation does not match package")
            kind = operation["kind"]
            if kind == "t3":
                result = execute_t3(operation, lambda machine, state, attempt: self._t3_connection_notice(identifier, machine, state, attempt))
            elif kind == "push":
                if (
                    hashlib.sha256((directory / "change.bundle").read_bytes()).hexdigest()
                    != operation["bundleSha256"]
                ):
                    raise ApprovalError("Saved bundle changed")
                self._git(
                    directory,
                    "push",
                    "--porcelain",
                    "--atomic",
                    f"--force-with-lease={operation['ref']}:{operation['oldSha']}",
                    f"https://github.com/{operation['repository']}.git",
                    f"{operation['newSha']}:{operation['ref']}",
                    privileged=True,
                )
                result = {"newSha": operation["newSha"], "ref": operation["ref"]}
            elif kind == "pull-request":
                head_repository = operation.get("headRepository", operation["repository"])
                for key in ("head", "base"):
                    repository = head_repository if key == "head" else operation["repository"]
                    if (
                        self._remote_sha(
                            directory,
                            repository,
                            f"refs/heads/{operation[key]}",
                        )
                        != operation[f"{key}Sha"]
                    ):
                        raise ApprovalError("PR branch changed; submit a new request")
                body = {key: operation[key] for key in ("head", "base", "title", "body")}
                if head_repository != operation["repository"]:
                    owner, repository = head_repository.split("/")
                    body["head"] = f"{owner}:{operation['head']}"
                    body["head_repo"] = repository
                result = self._github(
                    {
                        "repository": operation["repository"],
                        "resource": "pulls",
                        "method": "POST",
                        "body": body,
                    }
                )
            elif kind in {"gateway", "infrastructure"}:
                if self._installed_commit(kind) != operation["oldCommit"]:
                    raise ApprovalError("Installed infrastructure changed; submit a new request")
                result = self._deploy(directory, operation)
            elif kind == "host-config":
                if self._installed_commit(kind) != operation["oldCommit"]:
                    raise ApprovalError("Installed host configuration changed; submit a new request")
                result = self._host_config(directory, operation)
            elif kind == "tailnet":
                from loylex_tailnet_serve import tailnet_execute  # Lazy: installed separately.
                result = tailnet_execute(identifier, operation)
            else:
                result = self._github(operation)
            self._update(
                identifier,
                state="succeeded",
                result=json.dumps(result, ensure_ascii=False),
            )
        except Exception as error:
            detail = str(error) if isinstance(error, ApprovalError) else type(error).__name__
            self._update(identifier, state="failed", result=detail)
        row = self._row(identifier)
        if row["state"] == "succeeded":
            if operation['kind'] == 't3' and operation['action'] == 'confirm-connect':
                try:
                    self._telegram('sendMessage', {'chat_id': row['chat_id'], 'text': 'T3 подключён. Можно выбирать проект и запускать задачи.', 'reply_parameters': {'message_id': row['reply_id']}})
                except Exception:
                    pass
            if operation['kind'] == 't3' and operation['action'] == 'connect':
                try:
                    self._telegram('sendMessage', {
                        'chat_id': row['chat_id'],
                        'text': 'Открой ссылку T3 Connect и подтверди код: ' + str(result.get('userCode', '')) + '. Затем здесь появится кнопка подтверждения конкретного компьютера.',
                        'reply_parameters': {'message_id': row['reply_id']},
                        **({'message_thread_id': row['thread_id']} if row['thread_id'] is not None else {}),
                        'reply_markup': {'inline_keyboard': [[{'text': 'Подключить T3', 'url': result['authorizationUrl']}]]}})
                except Exception:
                    pass  # URL remains available through the approved result, never rerun login automatically.
            return
        try:
            self._telegram(
                "sendMessage",
                {
                    "chat_id": row["chat_id"],
                    "text": f"{identifier}: {row['state']}\n{row['result']}",
                    "reply_parameters": {"message_id": row["message_id"]},
                },
            )
        except ApprovalError:
            pass

    def _t3_connection_notice(self, identifier: str, machine: str, state: str, attempt: str) -> None:
        from loylex_approval_host import t3_read
        pending = t3_read('t3-pending.json', {}).get(machine, {})
        if pending.get('attemptId') != attempt:
            return
        row = self._row(identifier)
        if state == 'confirmation_required':
            self.submit({'chatId': row['chat_id'], 'replyId': row['reply_id'], 'threadId': row['thread_id'],
                         'operation': {'kind': 't3', 'machine': machine, 'action': 'confirm-connect', 'arguments': {'attemptId': attempt}}})
        else:
            self._telegram('sendMessage', {'chat_id': row['chat_id'], 'text': 'Вход T3 не завершён. Запроси новую ссылку; команды на компьютере не запускались.',
                                           'reply_parameters': {'message_id': row['reply_id']}})

    def _host_config(self, directory: Path, operation: dict[str, Any]) -> dict[str, Any]:
        # Fail closed on any local edit since review; only the deployed image pins may differ.
        home = Path.home()
        installed: dict[str, bytes] = {}
        for name, (_, destination) in HOST_CONFIG_SOURCES.items():
            installed[name] = read_host_file(home / destination)
            if (
                hashlib.sha256(host_config_normalized(name, installed[name])).hexdigest()
                != operation["files"][name]["installedSha256"]
            ):
                raise ApprovalError(f"Installed host file changed: {name}; submit a new request")
        content: dict[str, bytes] = {}
        for name, (source, _) in HOST_CONFIG_SOURCES.items():
            content[name] = self._git(directory, "show", f"{operation['commit']}:{source}")
            if name == "compose.yaml":
                content[name] = carry_images(installed[name], content[name])
            if (
                hashlib.sha256(host_config_normalized(name, content[name])).hexdigest()
                != operation["files"][name]["newSha256"]
            ):
                raise ApprovalError("Approved host configuration changed; submit a new request")
        manifests = home / "backups/loylex-manifests"
        manifests.mkdir(parents=True, exist_ok=True)
        manifests.chmod(0o755)
        replaced: list[str] = []
        try:
            for name, (_, destination) in HOST_CONFIG_SOURCES.items():
                replace_host_file(home / destination, content[name], HOST_CONFIG_MODES[name])
                replaced.append(name)
        except OSError:
            # Restore what this operation already replaced, so a failed install never leaves a mixed pair.
            for name in replaced:
                replace_host_file(home / HOST_CONFIG_SOURCES[name][1], installed[name], HOST_CONFIG_MODES[name])
            raise
        (self.root / "host-config-commit").write_text(operation["commit"])
        return {"commit": operation["commit"], "files": list(HOST_CONFIG_SOURCES)}

    def _deploy(self, directory: Path, operation: dict[str, Any]) -> dict[str, Any]:
        commit = operation["commit"]
        source = directory / "source"
        source.mkdir()
        archive = self._git(directory, "archive", commit)
        command(
            [
                "tar",
                "-x",
                "-C",
                str(source),
                "--no-same-owner",
                "--no-same-permissions",
            ],
            input_bytes=archive,
        )
        if operation["kind"] == "infrastructure":
            for name in operation["files"]:
                candidate = source / "deploy/scripts" / name
                if not candidate.is_file() or not candidate.resolve().is_relative_to(
                    source.resolve()
                ):
                    raise ApprovalError(f"Missing regular infrastructure file: {name}")
                installed = Path.home() / ".local/bin" / name
                if (
                    hashlib.sha256(installed.read_bytes()).hexdigest()
                    != operation["installedFiles"][name]
                ):
                    raise ApprovalError("Installed infrastructure file changed")
            for name in operation["files"]:
                destination = Path.home() / ".local/bin" / name
                temporary = destination.with_suffix(".new")
                shutil.copyfile(source / "deploy/scripts" / name, temporary)
                temporary.chmod(0o755)
                os.replace(temporary, destination)
            (self.root / "infrastructure-commit").write_text(commit)
            command(
                [
                    "systemd-run",
                    "--user",
                    "--on-active=10s",
                    "systemctl",
                    "--user",
                    "restart",
                    "loylex-supervisor.service",
                ]
            )
            return {
                "commit": commit,
                "restart": "scheduled",
                "files": operation["files"],
            }
        image = f"ghcr.io/chelokot/loylex-gateway:approved-{commit}"
        recipe = directory / "gateway.Containerfile"
        recipe.write_text(operation["buildRecipe"])
        command(
            [
                "podman",
                "build",
                "--memory=1g",
                "--cpu-period=100000",
                "--cpu-quota=100000",
                "--pull=never",
                "--label",
                f"org.opencontainers.image.revision={commit}",
                "--tag",
                image,
                "--file",
                str(recipe),
                str(source),
            ],
            timeout=900,
        )
        digest = (
            command(["podman", "image", "inspect", "--format", "{{.Digest}}", image])
            .decode()
            .strip()
        )
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
            raise ApprovalError("Invalid built gateway image digest")
        image = f"ghcr.io/chelokot/loylex-gateway@{digest}"
        self.supervisor.deploy_gateway(image, operation["oldCommit"])
        return {"commit": commit, "image": image}


def complete_t3_enrollment(self: Any, machine: str, record: dict, account: str) -> None:
    import base64
    import hashlib
    import re
    import secrets
    import time
    from urllib.parse import parse_qs, quote, urlsplit
    from loylex_approval_host import T3ProofKey, t3_endpoint, t3_read, t3_write
    # Account login is temporary: it is never persisted. Find exactly the
    # approved computer; duplicate labels or changed endpoints fail closed.
    environments = self.request(self.RELAY, '/v1/environments', token=account).get('environments')
    if not isinstance(environments, list) or len(environments) > 100:
        raise ApprovalError('Invalid T3 environment list')
    matches = []
    for item in environments:
        origin = t3_endpoint(item['endpoint']['httpBaseUrl'].rstrip('/') + '/mcp')
        if (record['environmentName'] is not None and item.get('label') == record['environmentName']) or (record['endpoint'] is not None and origin == t3_endpoint(record['endpoint'])):
            matches.append((item, origin))
    if len(matches) != 1:
        raise ApprovalError('Expected exactly one matching T3 computer')
    item, origin = matches[0]
    environment_id = item.get('environmentId')
    if environment_id != record['environmentId']:
        raise ApprovalError('T3 computer identity changed after confirmation')
    if not isinstance(environment_id, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,256}', environment_id):
        raise ApprovalError('Invalid T3 environment identity')
    with self.lock:
        self.lease(machine, record)
    key = T3ProofKey()
    relay = self.request(self.RELAY, '/v1/client/dpop-token', {
        'grant_type': 'urn:ietf:params:oauth:grant-type:token-exchange', 'subject_token': account,
        'subject_token_type': 'urn:ietf:params:oauth:token-type:jwt',
        'requested_token_type': 'urn:ietf:params:oauth:token-type:access_token',
        'resource': self.RELAY, 'scope': 'environment:connect', 'client_id': 't3-web'}, key=key, form=True)
    if relay.get('token_type') != 'DPoP':
        raise ApprovalError('Relay did not issue a proof-bound grant')
    connected = self.request(self.RELAY, '/v1/environments/' + quote(environment_id, safe='') + '/connect',
                             {'clientProofKeyThumbprint': key.thumbprint}, token=relay['access_token'], key=key)
    if connected.get('environmentId') != environment_id or t3_endpoint(connected['endpoint']['httpBaseUrl'].rstrip('/') + '/mcp') != origin:
        raise ApprovalError('T3 connection target changed')
    session = self.request(origin, '/oauth/token', {
        'grant_type': 'urn:ietf:params:oauth:grant-type:token-exchange',
        'subject_token': connected['credential'], 'subject_token_type': 'urn:t3:params:oauth:token-type:environment-bootstrap',
        'requested_token_type': 'urn:ietf:params:oauth:token-type:access_token',
        'scope': ' '.join(self.SCOPES + ['access:write']), 'client_label': 'Loylex enrollment'}, key=key, form=True)
    if session.get('token_type') != 'DPoP':
        raise ApprovalError('Environment did not issue a proof-bound grant')
    # Use the ordinary authorized delegation endpoint. No proof-bound
    # credential is downgraded/reinterpreted or passed to the MCP endpoint.
    pairing = self.request(origin, '/api/auth/pairing-token', {'label': 'Loylex MCP', 'scopes': self.SCOPES},
                           token=session['access_token'], key=key)
    client = self.request(origin, '/oauth/mcp/register', {
        'client_name': 'Loylex · approved Telegram tasks', 'redirect_uris': [self.CALLBACK],
        'grant_types': ['authorization_code'], 'response_types': ['code'], 'token_endpoint_auth_method': 'none'})
    verifier, state = secrets.token_urlsafe(48), secrets.token_urlsafe(32)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    authorization = {'client_id': client['client_id'], 'redirect_uri': self.CALLBACK, 'response_type': 'code',
                     'code_challenge_method': 'S256', 'code_challenge': challenge, 'state': state, 'resource': origin + '/mcp'}
    decision = self.request(origin, '/oauth/mcp/decision', {
        'authorization': authorization, 'decision': {'_tag': 'pairing-code', 'access': 'full-access', 'code': pairing['credential']}})
    redirect = urlsplit(decision['redirectTo'])
    query = parse_qs(redirect.query, keep_blank_values=True, max_num_fields=8)
    if (redirect._replace(query='').geturl() != self.CALLBACK or set(query) != {'iss', 'state', 'code'}
            or any(len(v) != 1 for v in query.values()) or query['iss'][0] != origin or not hmac.compare_digest(query['state'][0], state)):
        raise ApprovalError('Invalid T3 enrollment response')
    result = self.request(origin, '/oauth/mcp/token', {
        'grant_type': 'authorization_code', 'code': query['code'][0], 'client_id': client['client_id'],
        'redirect_uri': self.CALLBACK, 'code_verifier': verifier, 'resource': origin + '/mcp'}, form=True)
    token, expires = result.get('access_token'), result.get('expires_in')
    if (result.get('token_type', '').lower() != 'bearer' or not isinstance(token, str) or not 1 <= len(token) <= 8192
            or any(ord(c) <= 32 or ord(c) >= 127 for c in token) or type(expires) is not int or not 60 <= expires <= 31 * 86400
            or set(result.get('scope', '').split()) != set(self.SCOPES)):
        raise ApprovalError('T3 did not grant the requested full-access MCP session')
    with self.lock:
        self.lease(machine, record)
        registry = t3_read('t3-machines.json', {})
        if len(registry) >= 20 and machine not in registry:
            raise ApprovalError('T3 computer limit reached')
        old = registry.get(machine)
        grant = secrets.token_hex(16)
        credentials = t3_read('t3-credentials.json', {})
        credentials[machine] = {'accessToken': token, 'expiresAt': int(time.time()) + expires, 'grantId': grant}
        t3_write('t3-credentials.json', credentials)
        registry[machine] = {'endpoint': origin + '/mcp', 'grantId': grant,
                             'projects': old['projects'] if old and old['endpoint'] == origin + '/mcp' else {}}
        t3_write('t3-machines.json', registry)
