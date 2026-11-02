"""Publish inert digest metadata bound to this exact CI revision and run."""
import json
import os
import re
import urllib.request

repository = os.environ['GITHUB_REPOSITORY']
sha = os.environ['GITHUB_SHA']
digest = os.environ['IMAGE_DIGEST']
component = os.environ['IMAGE_COMPONENT']
run = os.environ['GITHUB_RUN_ID']
if (repository != 'chelokot/Loylex' or not re.fullmatch(r'[0-9a-f]{40}', sha)
        or not re.fullmatch(r'sha256:[0-9a-f]{64}', digest)
        or component not in {'agent', 'gateway'} or not run.isdecimal()):
    raise SystemExit('Invalid image publication metadata')
request = urllib.request.Request(f'https://api.github.com/repos/{repository}/statuses/{sha}',
    data=json.dumps({'state': 'success', 'context': f'loylex-image/{component}',
                     'description': digest, 'target_url': f'https://github.com/{repository}/actions/runs/{run}'}).encode(),
    headers={'Authorization': 'Bearer ' + os.environ['GITHUB_TOKEN'],
             'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json'}, method='POST')
# This fixed GitHub API endpoint must not redirect the token to another origin.
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
    if response.status != 201:
        raise SystemExit('Could not record image digest')
