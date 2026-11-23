# Contributing to dsh-chat-import

Thanks for considering a contribution. `dsh-chat-import` imports conversation
history from other agents into DeepSeek Harness as full-fidelity, resumable
sessions. The user-facing contract lives in [README.md](../README.md) and its
Chinese counterpart; the engineering rules — layout, commit discipline, DSH
plugin constraints, quality conventions — live in [AGENTS.md](../AGENTS.md).

## Dev setup

- **Node.js >= 22.13**, the first release where `node:sqlite` works without a flag
- `npm ci` installs the dependencies. There are no runtime dependencies; peers are
  installed automatically.
- `npm test` runs the `node:test` suite: converter unit tests, export unit tests,
  and host-mock integration tests
- `npm run check:linux` is the cross-platform path-discipline guard, also enforced
  in CI
- `npm run lint` runs eslint with the flat config
- `npm run build` is the publish-surface self-check: files whitelist, syntax, and
  lockfile version

## What counts as a change

- **Behavior changes stay honest.** The two READMEs must stay in sync (CI compares
  their heading structure). Tests describe the behavior. Any file newly reached
  from `index.mjs`, or referenced by a README, has to join the `files` whitelist in
  `package.json`.
- **Plugin, not engine.** New behavior goes through public dsh host services
  (`sessionPersistence` / `fs` / `tools` / `workspaceRegistry`, optionally
  `webServer` / `commands`). Never modify the dsh engine, apiproxy, or the
  official UI packages.
- **Imported session logs are append-only.** Never rewrite history events; surface
  events carry `surfaceOp: 'append'`.
- **Fail loudly.** Malformed lines and suspected secrets are counted and reported,
  never silently swallowed.

## CHANGELOG

Release notes are taken verbatim from the matching CHANGELOG section, so that
section **is** the release note. Write it for users, not as a summary of the diff.
Since 0.19.0 every section follows the dsh release-note layout: a
`[中文](#cn-x.y.z) | [English](#en-x.y.z)` switch line, then an
`<h3 id="cn-x.y.z">新增功能</h3>` block in Chinese, then an
`<h3 id="en-x.y.z">New Features</h3>` block in English. Within each language the
groups come in this order: `### 体验优化` / `### 问题修复` / `### 其他变更`
(English: `### Improvements` / `### Bug Fixes` / `### Chores`). Empty groups are
omitted as a whole, and the section ends with
`**Full Changelog**: [v-prev...v-this](compare url)`.

One bullet covers one verifiable behavior or contract, not the implementation
journey. Call out contract changes explicitly: tool names, output schema, whether a
source is still supported. Performance work should carry measured numbers, and
user-facing behavior changes should be reflected in the READMEs. Anchor ids carry
the version so several sections can share one page.

## Releases

A release starts from a tag the maintainer pushes (`git push --follow-tags`). That
commit already carries the version's CHANGELOG section and the bumped
`package.json`. `.github/workflows/release.yml` then runs on the tag and checks that
the tag names `package.json`'s version and that the commit is on `main`. It
validates the CHANGELOG section with
`node scripts/release-notes.mjs --version x.y.z --check` (the same script prints
the notes), runs the full gate set, publishes to npm from the tag with trusted
publishing and provenance (no stored token), and creates or updates the GitHub
Release from that section.

There is no local publish step. Rerunning the workflow skips a version already on
npm, and dispatching it by hand (one `tag` input) validates every step without
publishing.

## Commits & PRs

- Use conventional commits (`feat:` / `fix:` / `refactor:` / `chore:` / `docs:` /
  `test:`), one logical change per commit. The existing history uses Chinese
  descriptions.
- Before pushing, `npm test` and `npm run check:linux` must pass and the working
  tree must be clean: nothing from `dev/` or `node_modules/`, no snapshots staged.
  Also run `git diff --cached --check`.
- Fork, branch as `feature/<name>`, then open a PR (a template is included). The
  repo pushes straight to `main`; please don't rewrite published history.
- PRs are welcome for new import sources, fidelity upgrades, and the items on
  [ROADMAP.md](ROADMAP.md).

## New & long-tail agent sources

`dsh-chat-import` is built for users who can code independently — or build
features directly with an AI coding agent. Maintainers do not have every
third-party client installed locally and cannot verify unfamiliar or proprietary
storage layouts on demand.

- **Long-tail / niche agent sources must be contributed via Pull Request**, not
  as bare "please add X" feature-request issues. Issues requesting a long-tail
  source without an accompanying PR will be closed with a pointer to this guide.
- **How to contribute a source:** point your coding agent at the *"新增一个来源"*
  checklist in [AGENTS.md](../AGENTS.md) and the design decisions in
  [architecture.md](architecture.md). A complete PR includes:
  1. Pure converter in `lib/convert/<src>.mjs` (reusing shared helpers or a
     same-family engine where applicable) and host/SQLite adapter in
     `lib/sources/<src>.mjs` if needed.
  2. Registration across toolkit, import specs, discovery, titles, client
     panel, types, docs, and icon wall.
  3. **Synthetic** fixtures and unit/integration tests covering converter,
     discovery, and tool execution.
  4. All local gates passing (`npm test`, `npm run lint`, `npm run check:linux`,
     `npm run check:links`, `npm run build`).
- Maintainers take care of code review, merging, and releasing.

## Security & privacy

Never commit credentials, real user transcripts, or anything under `dev/` (the
local engineering surface, which is gitignored). In issues and PRs, use
**synthetic** fixtures only, with no real conversation content.

