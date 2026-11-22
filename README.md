# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/afox63375-maker/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/afox63375-maker/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit an AI model wrote to a tree of text files, in any of the four formats models use: unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON text-editor calls. It finds each edit's lines with three tiers of whitespace-tolerant matching, writes every file or none at all, and reports exactly what changed or why an edit failed. Node 22 standard library only, no dependencies.

## Run it

```sh
node main.ts fix.patch
```

Read the patch from a file, or from standard input with `node main.ts -` (or no argument at all). `--format=unified|search-replace|v4a|json` forces one format (auto-detection is the default), `--check` reports without writing, and `--strict` matches lines exactly. The full contract is in `SPEC.md`; `node check.ts <practice.json>` runs the 100 public practice checks.
---

<sub>Entered on [make.fun](https://make.fun/?ref=1hh4a8y6&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
