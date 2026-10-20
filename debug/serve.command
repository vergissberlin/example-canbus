#!/bin/zsh
# Serve the repository locally; USB access is requested by the browser.
cd "${0:A:h}/.." || exit 1
print 'Open CAN/LAB: http://localhost:8765/'
print 'Use Microsoft Edge or Google Chrome. Stop with Ctrl+C.'
python3 -m http.server 8765 --bind 127.0.0.1
