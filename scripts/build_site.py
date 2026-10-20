#!/usr/bin/env python3
"""Build the static Pages artifact and version the offline app shell."""
import hashlib
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / '_site'
if OUTPUT == ROOT or ROOT.is_relative_to(OUTPUT):
    raise SystemExit('The output directory must not contain the repository.')
if OUTPUT.exists() and any(OUTPUT.iterdir()):
    if OUTPUT != ROOT / '_site':
        raise SystemExit('A custom output directory must be empty.')
    shutil.rmtree(OUTPUT)
OUTPUT.mkdir(parents=True, exist_ok=True)
for name in ['index.html', 'manifest.webmanifest', 'browserconfig.xml']:
    shutil.copyfile(ROOT / name, OUTPUT / name)
for directory in ['debug', 'docs']:
    (OUTPUT / directory).mkdir(exist_ok=True)
for name in ['index.html', 'style.css', 'app.mjs', 'i18n.mjs', 'translations.mjs', 'pwa.mjs', 'protocol.mjs', 'communication.mjs', 'load-test.mjs']:
    shutil.copyfile(ROOT / 'debug' / name, OUTPUT / 'debug' / name)
for name in ['canbus-breadboard.svg', 'canbus-communication.svg', 'canlab-opengraph.png']:
    shutil.copyfile(ROOT / 'docs' / name, OUTPUT / 'docs' / name)
shutil.copytree(ROOT / 'pwa', OUTPUT / 'pwa', dirs_exist_ok=True)
source = (ROOT / 'sw.js').read_text()
digest = hashlib.sha256(source.encode())
for path in sorted(OUTPUT.rglob('*')):
    if path.is_file() and path.name != 'sw.js':
        digest.update(path.relative_to(OUTPUT).as_posix().encode())
        digest.update(path.read_bytes())
(OUTPUT / 'sw.js').write_text(source.replace('__CANLAB_CACHE_VERSION__', digest.hexdigest()[:16]))
print(f'Built {OUTPUT} (offline version {digest.hexdigest()[:16]})')
