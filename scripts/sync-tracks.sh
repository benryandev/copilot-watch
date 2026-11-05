# Copy the track registry from copilot-check (where it is generated and tested) into this Worker.
set -e; cd "$(dirname "$0")/.."; src="${CHECK_DIR:-$HOME/Dev/copilot-check}/ecosystem/tracks/tracks.json"
cp "$src" src/tracks.json
echo "tracks synced: $(node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('src/tracks.json','utf8'))).join(', '))")"
