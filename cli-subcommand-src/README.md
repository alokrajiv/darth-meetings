# meetings subcommand — source of truth for `darth-cli meetings`

This folder is copied into `darth-cli/src/subcommands/meetings/` **at darth-cli
build time**. Editing files here does NOT ship anything by itself — installed
CLIs keep running the old bundle until darth-cli is rebuilt and deployed.

Design rule for this subcommand: **no AI commands.** The CLI is used mostly by
people's AI agents; it exposes deterministic primitives (list/get/text/search/
audio/frame/attachments + set-notes/set-report/set-title write-back) and the
calling agent brings the intelligence with its own tokens. `skill` prints the
agent workflow guide.

## After changing anything in this folder

```bash
cd ~/workspace/darth-cli
# 1. Bump src/core/version.ts — MANDATORY. `darth-cli update` (and the passive
#    update check) compare versions; an unbumped bundle never reaches users.
#    New command/feature → minor; fix/copy tweak → patch.
# 2. Build + deploy (copies this folder in, bundles, rsyncs cli-dist to .6,
#    restarts darth-auth, health-checks):
bash scripts/deploy.sh
# 3. Commit + push BOTH repos: darth-cli (version bump) and this repo (source).
# 4. Update your own install and verify:
darth-cli update && darth-cli --version && darth-cli meetings --help
```

Everyone else picks it up via the CLI's passive update check (5-min TTL) or
`darth-cli update`.

Same rule applies to `../darth-artifacts/cli-subcommand-src/` and
`../darth-plagueis/cli-subcommand-src/` — one deploy ships all three, since
build.sh copies every subcommand folder.
