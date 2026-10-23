# Captured akt output shapes

Real bytes, recorded live against mainnet on 2026-10-22 (dseq 29179762, provider hurricane,
akt 1.0.1) by a throwaway `probe-akt.yml` workflow that has since been deleted.

These exist because akt's shapes have been guessed wrong before and the guess reached
production.
`normalizeIps` in `script/lib/akt.mjs` exists only because `ips` was assumed to be an array
of snake_case objects when it is a map keyed by service with Go-capitalised fields, and that
assumption crashed a live mainnet run and reported it as Akash failing.
A paraphrase of a shape is what went wrong then, so what is kept here is the payload itself.

The `lease-shell` and `lease-logs` wrappers in `script/lib/akt.mjs` are not written yet.
When they are, their tests parse these files rather than a hand-written approximation.

## lease-shell

    akt provider lease-shell --dseq <d> --service web -o json -- <cmd>

`lease-shell.json` is a successful run of `echo probe-ok`.

`lease-shell-nonzero.json` is `sh -c 'echo to-stderr >&2; exit 7'`.
Note what is **not** in it: there is no exit-code field.
The remote status never appears in the JSON at all.
It surfaces only as prose on akt's own stderr, kept in `lease-shell-nonzero.akt-stderr`, and
as akt's process exit status.
A check that needs the remote exit code must use one of those two, not the payload.

## lease-logs

    akt provider lease-logs <dseq> --service web --tail N

The dseq is positional here, not a `--dseq` flag, unlike every other provider verb.

`lease-logs.txt` is the default form, one prefixed line per record.
`lease-logs.jsonl` is `-o json`, which is JSONL with one object per line and **not** a JSON
array, so it cannot be `JSON.parse`d whole.

## send-manifest

    akt provider send-manifest <sdl-file> --dseq <d>

A manifest that differs from the one committed on chain is rejected.
`send-manifest.akt-stderr` holds the refusal: the provider validates against the manifest
version hash fixed at deployment creation, so there is no in-place update of a running lease.
akt 1.0.1 offers no deployment-update verb either; `redeploy` creates a new deployment.

This killed two planned checks outright.
A `manifest-update` row cannot be written at all, and `restart-persistence` cannot use a
manifest re-send to force the pod recreation that would catch a Kata tmpfs substitution.
