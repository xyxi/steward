#!/usr/bin/env bash
# Build the Steward DSH plugins and create two isolated DeepSeek Harness homes:
#   var/dsh/robot-1  profile "ego"   (Ego Harness, from the shipped headless template by default)
#   var/dsh/world    profile "world" (World Harness, from the shipped web template)
# Everything goes through upstream launcher commands; no upstream file is modified.
set -euo pipefail

STEWARD="$(cd "$(dirname "$0")/.." && pwd)"
DSH="$STEWARD/dsh/node_modules/.bin/dsh"
VAR="${STEWARD_DSH_VAR:-$STEWARD/var/dsh}"
ROBOT_TEMPLATE="${ROBOT_TEMPLATE:-headless}"

(cd "$STEWARD/dsh" && pnpm install && pnpm run build)

setup_profile() {
  local home="$1" profile="$2" template="$3" bundle="$4"
  mkdir -p "$home"
  if [ ! -f "$home/profiles/$profile/package.json" ]; then
    DSH_HOME="$home" "$DSH" --profile "$profile" --from-default-profile "$template" --dump-default-config >/dev/null
  fi
  DSH_HOME="$home" "$DSH" plugin --profile "$profile" add "$STEWARD/dsh/packages/$bundle"
  echo "profile $profile ready in $home"
}

setup_profile "$VAR/robot-1" ego "$ROBOT_TEMPLATE" dsh-bundle-ego
DSH_HOME="$VAR/robot-1" "$DSH" plugin --profile ego add "$STEWARD/dsh/packages/dsh-bundle-rgbd-video-gen"
DSH_HOME="$VAR/robot-1" "$DSH" plugin --profile ego add "$STEWARD/dsh/packages/dsh-bundle-novelanything"
DSH_HOME="$VAR/robot-1" "$DSH" plugin --profile ego add "$STEWARD/dsh/packages/dsh-bundle-slarm"
setup_profile "$VAR/world" world web dsh-bundle-world
setup_profile "$VAR/world" world-task headless dsh-bundle-world
for profile in world world-task; do
  DSH_HOME="$VAR/world" "$DSH" plugin --profile "$profile" add "$STEWARD/dsh/packages/dsh-bundle-slarm"
  if node -e 'const p = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); process.exit(p.dependencies?.["@steward/dsh-bundle-rgbd-video-gen"] ? 0 : 1)' "$VAR/world/profiles/$profile/package.json"; then
    DSH_HOME="$VAR/world" "$DSH" plugin --profile "$profile" remove @steward/dsh-bundle-rgbd-video-gen
  fi
  if node -e 'const p = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); process.exit(p.dependencies?.["@steward/dsh-bundle-novelanything"] ? 0 : 1)' "$VAR/world/profiles/$profile/package.json"; then
    DSH_HOME="$VAR/world" "$DSH" plugin --profile "$profile" remove @steward/dsh-bundle-novelanything
  fi
done
