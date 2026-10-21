# Copy the shared core/ from copilot-check (where it is authored and tested) into this Worker.
set -e; cd "$(dirname "$0")/.."; src="${CHECK_DIR:-$HOME/Dev/copilot-check}/core"
(cd "$src/.." && node scripts/core-hash.mjs)
rm -rf core && cp -R "$src" core && echo "core synced: $(cut -c1-12 core/VERSION)"
