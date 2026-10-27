#!/usr/bin/env python3
"""Download inert dictionaries only; verify pinned SHA-256 before installing a file."""
import hashlib,json,urllib.request
from pathlib import Path
HERE=Path(__file__).resolve().parent
DATA=HERE.parents[1]/'data/russian-prefix-research'

def main():
    DATA.mkdir(parents=True,exist_ok=True)
    for item in json.loads((HERE/'sources.json').read_text()):
        if item['file'].startswith('inputs/'):
            target=HERE/item['file']
            if hashlib.sha256(target.read_bytes()).hexdigest()!=item['sha256']:raise ValueError('Bundled dictionary checksum failed')
            continue
        target=DATA/item['file']
        if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest()==item['sha256']:
            print('verified',target.name);continue
        with urllib.request.urlopen(item['url'],timeout=90) as response:content=response.read(20_000_001)
        if len(content)>20_000_000 or hashlib.sha256(content).hexdigest()!=item['sha256']:raise ValueError('Checksum mismatch: '+target.name)
        temp=target.with_suffix(target.suffix+'.download');temp.write_bytes(content);temp.replace(target)
        print('downloaded and verified',target.name)

if __name__=='__main__':main()
