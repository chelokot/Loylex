import base64


def publish_operation(name, files):
    return {
        'kind': 'tailnet',
        'action': 'publish',
        'name': name,
        'files': {path: base64.b64encode(data).decode() for path, data in files.items()},
    }


FAKE_TAILSCALE = '''#!/usr/bin/env python3
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
state_path = os.path.join(here, "state.json")
state = json.load(open(state_path)) if os.path.exists(state_path) else {"routes": {}}
args = sys.argv[1:]


def save():
    with open(state_path, "w") as stream:
        json.dump(state, stream)


def path_argument(values):
    return next(value.split("=", 1)[1] for value in values if value.startswith("--set-path="))


if args == ["status", "--json"]:
    print(json.dumps({"Self": {"DNSName": "vps.crane-rigel.ts.net.", "TailscaleIPs": ["fd7a:115c:a1e0::5", "100.64.0.5"]}}))
elif args == ["serve", "status", "--json"]:
    handlers = {path: {"Proxy": target} for path, target in state["routes"].items()}
    print(json.dumps({"Web": {"vps.crane-rigel.ts.net:443": {"Handlers": handlers}}} if handlers else {}))
elif args == ["serve", "status"]:
    for path, target in state["routes"].items():
        print("https://vps.crane-rigel.ts.net" + path)
        print("|-- proxy " + target)
elif args[0] == "serve" and args[-1] == "off":
    state["routes"].pop(path_argument(args), None)
    save()
elif args[0] == "serve" and "--bg" in args:
    if os.path.exists(os.path.join(here, "fail-add")):
        print("Serve is not enabled on your tailnet. Visit https://login.tailscale.com/f/serve to enable it.", file=sys.stderr)
        sys.exit(1)
    state["routes"][path_argument(args)] = args[-1]
    save()
else:
    print("unexpected arguments: %r" % (args,), file=sys.stderr)
    sys.exit(2)
'''
