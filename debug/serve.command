#!/bin/zsh
# Serve the repository locally; USB access is requested by the browser.
cd "${0:A:h}/.." || exit 1
print 'CAN/LAB öffnen: http://localhost:8765/debug/'
print 'Microsoft Edge oder Google Chrome verwenden. Beenden mit Ctrl+C.'
python3 -m http.server 8765 --bind 127.0.0.1
