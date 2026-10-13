# Working on this repo

Work on a branch, then squash merge into `main`.

Do not force-push `main`. A force-pushed orphan commit does not generate a push
event, so no workflow runs: the dashboard silently stops updating and no
scheduled canary fires. That happened here, and the symptom is a page that looks
fine but is hours stale, which is worse than an obvious break.

```sh
git checkout -b fix/something
# work, commit normally
gh pr create --fill
gh pr merge --squash
```

Commit messages are [conventional commits](https://www.conventionalcommits.org).

## Before you push

```sh
npm run validate   # every run file against the contract
npm test
npm run build
npx prettier --check .
```

`npm run doctor` reads the chain and broadcasts nothing. Run it before pointing
anything at mainnet.
