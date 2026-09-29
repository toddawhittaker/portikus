# Contributing to Portikus

Thank you for helping. Bug reports, fixes, and documentation improvements
are all welcome. For anything larger, open an issue first so we can agree
on the approach before you write code.

## Setting up and running checks

Follow [Running it locally](README.md#running-it-locally) in the README to
install the tools and start the apps. Before opening a pull request, run:

```sh
make check        # typecheck, lint, docs links, tests with coverage, build, infra checks
pnpm test:e2e     # Playwright browser tests
```

[docs/WORKFLOW.md](docs/WORKFLOW.md) covers local development, branching,
pull requests, CI, secret scanning, and the pre-commit hook in full.

## Opening a pull request

Branch from `main`, keep the change focused, and fill in the pull request
template: what changed, which [docs/SPEC.md](docs/SPEC.md) sections it
serves, and how you verified it. Link the issue with `Fixes #123`.

## Rules that matter

- **Tests are part of done.** Logic ships with unit tests. Anything a
  student or administrator can see ships with Playwright tests too. A bug
  fix starts with a test that fails without it.
- **Pin dependencies.** Use exact versions and commit the lockfile. If you
  add a dependency, say why in the pull request.
- **No secrets.** Never commit keys, tokens, or passwords. The pre-commit
  hook and CI scan for them.
- **Plain English docs.** Write short, complete sentences, and explain a
  technical term the first time you use it.
- **Never touch a student's Git history.** Portikus must not commit,
  branch, tag, or stash in a user's repository on their behalf.

Report security problems privately, as described in
[SECURITY.md](SECURITY.md). By taking part you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
