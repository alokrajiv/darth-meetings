#!/usr/bin/env bash
# Allow-list the two deploy scripts for Claude Code in THIS project, so an agent
# session can run them itself (auto mode otherwise refuses when the agent starts them).
#
#   scripts/allow-deploys.sh          add the rules to .claude/settings.local.json
#   scripts/allow-deploys.sh --show   print the rules that would be added
#
# Rules (Claude Code permission syntax: `Bash(<prefix>:*)` = that command with any args):
#   ./deploy.sh                                   server: rsync + build + pm2 restart on .6
#   poc/mac-recorder/dist-scripts/deploy-to-dot6.sh   tray: publish the notarized zip
#   poc/mac-recorder/make-app.sh --release        tray: build + notarize the release zip
#   deploy/vm-setup-blue-green.sh                 server: one-time blue/green VM setup (idempotent)
#   ../admin/scripts/deploy.sh                    admin app: rsync + build + pm2 restart on .6
#   scripts/vm-apply-migration.sh NNN             server: apply migrations/NNN_*.sql to prod PG on .6
#   cd ../desktop && npm run release / deploy    desktop shell: signed build + publish to cli-dist
#
# settings.local.json is per-machine and git-ignored by Claude Code; allow rules take
# precedence over the auto-mode classifier. Re-running is idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."
FILE=".claude/settings.local.json"
RULES=(
  "Bash(./deploy.sh)"
  "Bash(./deploy.sh:*)"
  "Bash(poc/mac-recorder/dist-scripts/deploy-to-dot6.sh)"
  "Bash(poc/mac-recorder/dist-scripts/deploy-to-dot6.sh:*)"
  "Bash(./poc/mac-recorder/dist-scripts/deploy-to-dot6.sh)"
  "Bash(./poc/mac-recorder/dist-scripts/deploy-to-dot6.sh:*)"
  "Bash(poc/mac-recorder/make-app.sh --release)"
  "Bash(./make-app.sh --release)"
  "Bash(deploy/vm-setup-blue-green.sh)"
  "Bash(deploy/vm-setup-blue-green.sh:*)"
  "Bash(./deploy/vm-setup-blue-green.sh)"
  "Bash(./deploy/vm-setup-blue-green.sh:*)"
  "Bash(scripts/vm-apply-migration.sh)"
  "Bash(scripts/vm-apply-migration.sh:*)"
  "Bash(./scripts/vm-apply-migration.sh)"
  "Bash(./scripts/vm-apply-migration.sh:*)"
  "Bash(../admin/scripts/deploy.sh)"
  "Bash(../admin/scripts/deploy.sh:*)"
  "Bash(/Users/alokrajiv/crp-workspace/darth/admin/scripts/deploy.sh)"
  "Bash(/Users/alokrajiv/crp-workspace/darth/admin/scripts/deploy.sh:*)"
)
if [[ "${1:-}" == "--show" ]]; then printf '%s\n' "${RULES[@]}"; exit 0; fi
mkdir -p .claude
[[ -f "$FILE" ]] || echo '{}' > "$FILE"
RULES_JSON=$(printf '%s\n' "${RULES[@]}" | python3 -c 'import json,sys; print(json.dumps([l.rstrip("\n") for l in sys.stdin if l.strip()]))')
python3 - "$FILE" "$RULES_JSON" <<'PY'
import json, sys
path, rules = sys.argv[1], json.loads(sys.argv[2])
with open(path) as f:
    data = json.load(f)
perms = data.setdefault("permissions", {})
allow = perms.setdefault("allow", [])
added = [r for r in rules if r not in allow]
allow.extend(added)
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print(f"{path}: {len(added)} rule(s) added, {len(allow)} allow rule(s) total")
for r in added:
    print("  +", r)
PY
echo "Takes effect for new tool calls in the running session (restart the session if a deploy is still refused)."
