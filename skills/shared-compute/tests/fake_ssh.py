"""Offline executable stand-in: records argv/stdin, never opens a socket."""
import json
import os
from pathlib import Path
import sys
import time

wire = json.load(sys.stdin)
request = wire['request']
assert set(wire['sources']) == {'common.py', 'remote.py'}
Path(os.environ['FAKE_SSH_CAPTURE']).write_text(json.dumps({'argv': sys.argv[1:], 'request': request}))
mode = os.environ.get('FAKE_SSH_MODE', 'ok')
if mode == 'exit':
    raise SystemExit(255)
if mode == 'timeout':
    time.sleep(10)
if mode == 'invalid':
    print('invalid-json')
else:
    print(Path(os.environ['FAKE_SSH_RESPONSE']).read_text())
