[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/renprayoga/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/renprayoga/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend — one patch tool for every AI edit format

`mend` is a command-line tool that applies AI-written edits in four formats
(unified diff, SEARCH/REPLACE blocks, V4A patches and JSON tool calls) to a
tree of text files, to one written specification (SPEC.md in the kit).

It finds the lines each edit names at the first of three matching tiers, so
an edit still lands when the model drifted the whitespace or indentation of
the lines it quoted, and it changes every file or none: all edits are
validated before anything is written, and the write itself is atomic.

## Usage

```sh
node main.ts [options] [PATCH]
```

Run it with the working directory set to the root of the tree of text files
to patch. The patch is read from the file named by `PATCH`, or from standard
input when no patch file is given. See SPEC.md in the kit for the full
contract: exit codes, stdout, and the exact behaviour of every format.

## Design

- One parser per format, each strict about its own syntax, all producing the
  same internal edit list (file, anchor lines, replacement lines).
- Three-tier line matching: exact match first, then whitespace-normalised
  match, then an anchor-based fuzzy match — the first tier that locates an
  edit wins, so a drifted edit still applies deterministically.
- Atomic application: every edit is located and validated before any file
  is touched; files are written through a temporary file plus rename, so a
  failed patch leaves the tree exactly as it was.

## Entry

Built for the make.fun bounty
[Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).
`main.ts` is the CLI; `runner.ts` is the kit's trial runner, kept as shipped.
