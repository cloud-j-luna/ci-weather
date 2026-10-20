# CI Weather

A daily canary that deploys real workloads to the Akash Network, checks they serve traffic, closes them, and publishes the history as a weather dashboard.

Existing Akash dashboards report declared capacity and chain state.
This one reports whether a deployment actually completes, and when it does not, which stage it died at.

## What a red cell means

Deploying on Akash is a pipeline, not one operation: create the deployment, wait for bids, pick one, open the lease, send the manifest, wait for the workload, serve traffic.

`akt` reports each stage separately, so a run records the stage it stopped at rather than a bare pass or fail.
"`wait-for-bids` has failed for the GPU scenario for three days" is more useful than "Akash is down".

## Scenarios

Rows are deployment shapes, not providers.
Mainnet has over a hundred providers with inconsistent self-declared attributes, so a per-provider grid would be unaffordable daily and keyed on unreliable data.

| Scenario             | Question                                                                  |
| -------------------- | ------------------------------------------------------------------------- |
| `web`                | Can anyone deploy an ordinary web workload right now?                     |
| `gpu`                | Is GPU supply leasable, and does the device actually work?                |
| `persistent-storage` | Do providers advertising persistent volumes honour a lease that uses one? |
| `ip-lease`           | Can a workload still get a dedicated public IP?                           |
| `tee`                | Is a confidential-compute lease really backed by TEE hardware?            |

## What a green GPU cell means

Three independent facts, not one.

A provider leased the GPU. `torch.cuda.is_available()` returned true inside the
container, so the CUDA runtime reached the device through libcuda. And `nvidia-smi`
enumerated it through NVML, reporting the device name, driver version, memory and
compute capability, which the run records under `lease.gpu`.

The last two go through different paths, so "CUDA works but NVML cannot enumerate" is
a real provider-configuration state. A row that only asserted torch would call that
healthy.

If the image has no `nvidia-smi` at all, the workload still starts and still serves,
and the step fails saying so. A container that refuses to start would tell us nothing
about the provider.

## Usage

```sh
npm install
npm run doctor                                 # reads only, broadcasts nothing
node script/canary.mjs run --scenario web      # defaults to sandbox-2
npm run reap                                   # close what this project created, nothing else
```

`--probe-timeout <duration>` overrides how long `http-probe` and `gpu-check` keep asking the workload whether it is serving, for diagnosing a provider without editing the registry.

The default network is `sandbox-2`.
CI opts into mainnet with `--context mainnet`, so a laptop cannot spend from the mainnet wallet by forgetting a flag.

```sh
npm run build                                  # data/runs -> site/dist
npm run build -- --source testdata/runs        # build against the fixture corpus
npm run validate                               # every run file against the contract
npm test
```

## Cleanup, and what it will not touch

Every run begins and ends by closing the deployments this project created, and nothing else.

Ownership is proven rather than assumed.
The committed run files under `data/runs` record every dseq the canary has ever created, so a run killed halfway is still cleaned up by the next one, even on a fresh CI runner that has no memory of it.
Anything else active on the account is reported as foreign and left alone.

`akt close` is not idempotent, so cleanup cannot work by closing a remembered id.
It asks the chain what is open, intersects that with what it owns, and closes only the overlap.

An earlier version did the opposite: it closed everything that was not on an explicit exclusion list.
Pointed at a funded mainnet wallet it destroyed seven deployments that predated it.
A safeguard that depends on the operator having supplied a complete exclusion list is not a safeguard, which is why the rule is now inverted.

`doctor` reports both counts before a run and broadcasts nothing.
If the canary ever loses its own record of a deployment, `--adopt <dseq>` hands it back.

A full cycle on sandbox cost 5 uact of lease time and about 1900 uakt of gas.
The deposit returns on close.
The canary sets the deposit explicitly instead of `--deposit auto`, which picks 20 ACT on mainnet against a 0.5 ACT chain minimum.
1 ACT covers every scenario but `tee`, which gets 2 ACT because confidential GPU has never had its bid price measured here.
The deposit only bounds the loss when a close fails.
A smaller one empties its escrow and self-closes sooner.

## How it works

One `akt deploy` call carries the chain-side lifecycle:

```sh
akt deploy <sdl> --bid-select cheapest --bid-timeout 5m --ready-timeout 5m --yes -o jsonl
```

The runner consumes that event stream, then probes the workload, then closes.

Seven details are non-obvious:

**Attribution never comes from the exit code.**
`akt` defines eight exit codes and constructs none of them in the deploy path, so a bid timeout and a manifest failure both exit 1.
The failing stage comes from the event stream's `step` field, with the error text carried verbatim.

**Step durations come from `akt context log`, not from the event stream.**
akt flushes several jsonl events at once, so timing a step by when its line arrives misattributes whole minutes.
A live run timed that way reported 24.5s of `create-deployment` and 0ms for everything after it; the action log showed the truth, 1.3s of `create-deployment` and 15.4s of waiting for bids.

**The probe tries both schemes.**
Lease URIs carry no scheme and provider ingress commonly refuses 443 while serving 80.
An HTTPS-only probe would report a false failure every day.

**The dedicated IP scenario probes the IP, never the lease URI.**
`akt`'s event stream never reports an allocated IP, and the `uris` it hands back are the provider's shared ingress hostname, which every deployment gets whether or not an IP was allocated.
A run that probed that hostname would go green against a provider that allocated nothing.
Only `akt provider lease-status` reports the IP, so a scenario with `probe.target: ip` asks for it and dials `http://<ip>:<port>/` directly.
Finding no IP fails the run at `http-probe`; there is no fallback to the hostname, because the fallback is the bug.

**Attestation is a provider API, not something the workload can prove about itself.**
Akash injects an attestation sidecar into a TEE pod, and `akt provider lease-attestation` challenges it with a fresh 64-byte nonce and checks the hardware report echoes that nonce back.
The one answer that looks like a pass without being one is a mock report: the sidecar's synthetic format echoes the nonce correctly with no TEE hardware behind it.
A mock, a nonce that was not echoed, or a TEE type other than the one the scenario asked for each fail the run at `attestation`, so a green cell on that row cannot mean "labelled confidential".

**A 503 is a workload still starting, not a verdict.**
A provider's ingress answers 503 while the route exists but nothing is accepting connections behind it yet, which is every workload's first seconds.
It is path-independent, so it says nothing about which file was asked for.
Across every run recorded here, a probe that saw a 5xx went on to get a 200 within 0.5s to 7.1s; it has never once been terminal.
Both `http-probe` and the `gpu-check` that follows it therefore retry on 5xx and on transport errors, on one shared backoff schedule and one shared budget.
A status the origin itself produced, 404 included, is a real answer and is not retried.

`gpu-check` used to fetch once with no retry, milliseconds after the probe's first success.
On 2026-10-20 it sampled the tail of that startup window and reported a working A100 as a dead one.

**`--bid-select` is always passed.**
It defaults to `interactive`, which blocks on stdin and would hang CI until the job timeout.

## Why the CLI and not a client library

`@akashnetwork/akashjs` is archived and deprecated on npm.
`akash-api` is deprecated in favour of `chain-sdk`.
`chain-sdk` is pre-1.0 and its TypeScript surface excludes `sendManifest`; its own example drops to a raw HTTPS request with TLS verification disabled.

No package orchestrates the deployment lifecycle, and the provider-gateway auth helpers a Go program would need are unexported.
`akt deploy` is the only maintained thing that does all of it.

## The data contract

`schema/run.schema.json` is the contract between the runner and the site.

The verdict is a sum type, so a run cannot claim to have passed while naming the step it failed at.
Escrow is a separate axis, because serving traffic and recovering the deposit vary independently.
A `leaked` escrow means funds are locked on chain now.

An aborted run is not a failed run.
Abort means our own job was cancelled or ran out of budget, so aborts are excluded from the pass rate.

`steps[].step` is an open string.
akt's vocabulary changed between 0.0.4 and 1.0.1, and a closed enum would reject every run the day akt adds a step.

`npm run validate` checks every run file against the schema, the cross-field invariants JSON Schema cannot express, and a corpus of illegal shapes the contract must keep rejecting.

## Weather

One lookback window and one pass-rate definition, both in `scenarios/scenarios.yaml`, used everywhere including the sort.
A day with no run is drawn as "no data" and excluded from both sides of the ratio, so a day CI was down does not read as a day Akash was down.

## Price ceilings

The scenario SDLs set generous ceilings.
An observed winning bid was 2.93 uact per block against a ceiling of 10000.

A `wait-for-bids` failure therefore means no provider offered the resources, not that the ceiling was too low.
Raising the ceiling to clear a persistent storm would only hide the finding.

## Layout

```
schema/run.schema.json      the contract
scenarios/                  scenario registry, weather config, SDLs
script/canary.mjs           the runner: run, reap, doctor
script/validate-runs.mjs    contract enforcement, imported by the runner
script/build-site.mjs       globs run files into what the page fetches
site/                       the dashboard
data/runs/<scenario>/       one directory per run
testdata/                   fixtures and the illegal-shape corpus
```

Each run writes only its own directory.
Nothing appends to a shared index, so parallel producers cannot race; the index is derived at build time by globbing.

## Licence

Apache 2.0.
