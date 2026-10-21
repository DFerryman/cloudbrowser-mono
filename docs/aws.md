# Real browsers on AWS: setup runbook

This runbook takes a new AWS account to the first real browser. It is written so that a person,
or an AI agent helping them, can follow it step by step: every step has exact commands and a
check. Steps marked **(you)** need the account owner in person. An agent cannot do them: sign-up,
payment, MFA and changes to GitHub package visibility.

**What you get:** browsers created in a region configured for AWS run on real EC2 VMs. Each has
a dedicated Elastic IP, an encrypted 10 GB data volume (users can grow it) and its own 2 vCPU / 4 GB VM (`c7i-flex.large`). The VM is stopped, never terminated, while
the browser sleeps. Browsers created earlier on the simulator keep running there.

**Cost:** the product reads AWS's own prices for each region from the Price List API
(`pricing:GetProducts`), and users see them, times the markup, before every action; the console's
*Pricing & margin* page shows the current sheet. For orientation, Sydney list prices in October
2026: `c7i-flex.large` $0.1107 per running hour, gp3 storage $0.096 per GB-month, public IPv4
$0.005 per hour ($3.65 a month), snapshots $0.055 per GB-month, data out $0.114 per GB. A sleeping
browser with the default 10 GB data disk and 16 GB system disk costs about $6.15 a month at cost.

**Why 2 vCPU / 4 GB.** Each browser gets its own small VM rather than sharing a large host: the
VM is stopped while the browser sleeps, so it costs nothing to run then, and isolation, the
dedicated IP (an Elastic IP on the VM's own interface) and persistence (its own volume) need no
extra machinery. The proposed default is 4 GB plus a 1 GB swap file for spikes and 2 vCPU;
real-hardware memory, swap and stream performance still need validation. `c7i-flex` has the CPU
the first real browsers ran smoothly on (`m7i-flex.large`, 8 GB) for 7.5% less in the sampled
Sydney price sheet. The fallbacks `c6i.large` and `c5.large` are also 2 vCPU / 4 GB; their actual
unit prices are queried separately (customers pay the region's price for the first type).
Burstable `t3` types are not used:
when their CPU credits run out they either throttle the video or bill surplus credits that the
price list does not show. Graviton is not an option: Google Chrome for Linux is x86-64 only.

## Premium: 4 vCPU / 8 GB, 60 fps

Basic is capped at 25 fps by two things: its neko pipeline encodes 25 fps, and its desktop runs
at 30 Hz, which Chrome follows (it draws no more frames than the display shows). Premium browsers
run a 60 Hz desktop and the 60 fps pipeline in `images/browser/neko-premium.yaml` on
**`c7i.xlarge`** (4 vCPU, 8 GiB, Sapphire Rapids, full-performance), falling back to
`c6i.xlarge` and `c5.xlarge` (the same shape, at or below its price). Sydney list prices in
October 2026 were about $0.23 an hour for `c7i.xlarge` against $0.11 for Basic's `c7i-flex.large`;
customers see the region's own price list times the compute markup, as for Basic. A browser's
tier is chosen when it is created and never changes.

**Why these numbers.** Measured with the pinned neko image and Chrome 155 on a 4 vCPU Cascade Lake
host at 2.8 GHz (slower per core than `c7i`), with Chrome scrolling a dense page every frame:

| Live view | Encoded | VM busy |
|---|---|---|
| Basic: VP8, 25 fps, 30 Hz desktop | 24 fps | 1.7 vCPU (85% of a 2 vCPU VM) |
| VP8 at 60 fps, every speed setting tried | 17–32 fps | all 4 vCPUs |
| H.264 (x264 superfast) at 60 fps | 59.5 fps | 2.2 vCPU |
| H.264 at 60 fps with a 1080p60 video playing in Chrome | 59.6 fps | 2.3 vCPU |
| H.264 at 60 fps limited to 2 CPUs | 59.4 fps | 2.0 (no headroom left) |
| H.264 at 60 fps, 2560×1440 desktop, scrolling (neko's own frame counter, viewer on the same host) | about 40 fps | 2.7 vCPU |

VP8 cannot encode 1080p60 in real time on four vCPUs, so Premium streams H.264 (every browser the
viewer supports decodes it in WebRTC; Firefox through its OpenH264 plugin). Four vCPUs leave about
40% headroom for heavier pages; two would have none. Premium encodes at constant quality with a
4.5 Mbit/s cap, so it sends only what changes: about 0.1 Mbit/s on a still page and 1.7–3
Mbit/s while scrolling, depending on how dense the page is. The image adds a 2560×1440 60 Hz
mode for large windows; it is the heaviest case: Chrome's software compositor, the X server and
the screen capture share the CPUs, and it streamed about 40 fps while scrolling (above; `c7i`'s
faster cores leave more). Pages are still drawn on the CPU,
so WebGL-heavy sites and 3D games remain slower than on a local computer; a GPU tier (`g4dn`,
`g6`) would need NVIDIA drivers, an NVENC pipeline and a G-instance vCPU quota (zero by default).

**Holding 60 fps on a constrained path.** The first Premium release held 60 fps on a fast link,
then fell to 10 fps within minutes on a slower one, while Basic kept working: what a path drops
is bursts, not the average rate. Reproduced with the production image, the real viewer in Google
Chrome, and a local TURN relay (the live view always goes through TURN) that adds 80 ms of round
trip, 0.5% bursty loss and a bottleneck with a finite queue, while the remote Chrome scrolled a
dense page at 1080p (Basic limited to 2 CPUs, as on its VM):

| Path | Basic | Premium, first release | Premium now |
|---|---|---|---|
| 20 Mbit/s | 10 fps (CPU-bound on this page) | 58.5 fps, 0.6 s frozen | 58.5 fps, nothing frozen |
| 4 Mbit/s, 200 ms queue | 15 fps, 104 s frozen | 23 fps (mostly 20), 5 s frozen | 57 fps, nothing frozen |
| 3.5 Mbit/s, 100 ms queue | 13 fps, 97 s frozen | 23 fps, 46 s at 10 fps, 20 s frozen | 59 fps, nothing frozen |
| 20 Mbit/s, 3 Mbit/s for 70 s, 20 Mbit/s again | 11 fps, 65 s frozen | 39 fps, down to 10, 33 s frozen | 58 fps, 1.6 s frozen |

Runs of 2.5 minutes (3.5 for the last). Four causes, all fixed:

- *Keyframe bursts.* Each periodic keyframe (every 2 s) could be 600 ms of the bitrate cap,
  about 337 kB, handed to the network at once. `vbv-buf-capacity` is now 100 ms (at most
  56 kB at full), and there are no periodic keyframes.
- *Lost frames stayed lost.* neko 3.2.0 ignores a viewer's keyframe request (RTCP PLI), so a
  frame lost beyond repair froze the picture until the next periodic keyframe. The browser image
  now builds neko with `images/browser/neko/keyframes-and-resends.patch`: a request is answered
  with a keyframe at once (at most one per 300 ms), which also makes periodic ones unnecessary.
- *Retransmission storms.* neko resent every packet a viewer reported lost, all at once (a NACK
  can list hundreds), which overflowed the path again; through a 2.5 Mbit/s bottleneck no frame
  decoded for 20 s. The same patch gives resends a budget: half the stream's rate over the last
  second (at least 300 kbit/s), about ten packets back to back.
- *A ladder that gave up frame rate first, and slow adaptation.* Premium's ladder is now 60 fps
  at 4.5 Mbit/s, 60 fps at 2.5 Mbit/s, 30 and 20 fps (was 60, 30, 20, 10). The viewer steps down
  after two readings (4 s) when nothing decodes or a fifth of the packets are lost (three
  otherwise), and a step up that turns out too much is undone at its first bad reading instead of
  costing 6 s of stalls; a stream that decodes nothing at all now counts as 0 fps (it was
  "unknown" and never stepped down).

**Latency does not lower Premium's frame rate.** A lower frame rate does not bring the picture
sooner: each frame is encoded and sent as soon as it is drawn, and fewer frames only add the wait
for the next one. What does call for fewer frames is a link that cannot carry the stream, and the
viewer measures that directly at every round trip. So Premium (`TIERS.premium` in
`packages/contracts/src/tiers.ts`, applied by `packages/viewer/src/quality.ts`) has no round-trip
caps; it steps down only for lost packets (over 6%), frames not arriving (under half the level's
rate: 60, 60, 30 and 20 fps for full, high, medium and low), stutter (the picture frozen more than 10% of the time; WebRTC's frozen time, not the count
of freezes, because on a long path every resent packet is a short freeze), or a queue building
(round trip above the path's best of the last minute by more than 300 ms and by more than that
best round trip itself, so a long path's jitter is not mistaken for one). Basic keeps its
round-trip caps (20 fps above about 180 ms, 15 above about 320 ms) and steps down on any freeze.

**Turning Premium on in an existing deployment.** Premium is off (`premium` cap 0) until all of
this is done, so nothing below affects Basic browsers:

1. Let the runtime identity launch the Premium types. CloudFormation stacks: re-run the
   `aws cloudformation deploy` command of step 3 with
   `AllowedInstanceTypes=c7i-flex.large,c6i.large,c5.large,c7i.xlarge,c6i.xlarge,c5.xlarge` (the
   new default). AWS Provider deployments: add the three types wherever the
   `nevazu-provider-runtime` role's policy (or an SCP) lists instance types.
2. Publish the browser and agent images built from this commit (GitHub Actions → Images): the
   browser image carries `neko-premium.yaml`, the 60 Hz modes (up to 2560×1440) and the patched
   neko, the agent image the VM script that selects it. A VM takes images at first boot, so this
   reaches new browsers only: a Premium browser created before the image that fixed constrained
   paths (`keyframes-and-resends.patch`) keeps the old stream; delete and recreate it. The current
   viewer still works with it (its high level is 30 fps there, which the viewer treats as
   struggling and moves on to medium).
3. Apply migration `0029_browser_tiers` and deploy every Worker (`pnpm db:migrate:remote`,
   `pnpm deploy`). Within five minutes the reconciler lists which zones offer the Premium types
   and the engine prices them; the console's *Pricing & margin* page shows each region's Premium
   machine and price, and *AWS* shows Premium stock.
4. Create a Premium browser for yourself first: `INSERT INTO caps (scope, metric, "limit") VALUES
   ('user:<your user id>', 'premium', 1)` (or console → Limits with that scope). Check the toolbar
   shows about 60 fps and the codec `H264`.
5. Console → Limits → **Offer Premium** (`user:default` / `premium` = 1).

Each Premium browser holds 4 of the region's Standard On-Demand vCPUs (Basic holds 2), so ask for
a larger vCPU quota (step 2) before offering it widely.

**Switching an existing deployment to 4 GB VMs.** Re-run the deploy command above with the new
`AllowedInstanceTypes`, set `instanceTypes` in `AWS_REGIONS` as above (or remove it), and redeploy
the engine. New browsers get the new type. Existing browsers keep their VM (`m7i-flex.large`):
they still wake and sleep and use the region's customer price. The engine discovers and records
each retained VM's actual type and root disk size and queries its own type's price for cost
estimates, so changing the default does not relabel an existing machine as a 4 GB VM.

**Updating an existing stack for prices and storage growth.** This release adds
`pricing:GetProducts` (runtime and read-only users) and `ec2:ModifyVolume` (runtime) to the
template. Re-run the `aws cloudformation deploy` command below; until then prices show as
unavailable and no new browsers can be created. Growing a volume also needs agent **0.2.0** in the
agent image (step 4): rebuild and push that image. Browsers created with an older agent
keep working, but their Storage tab does not offer more space.

## Current deployment: Advanced mode and dynamic AWS Provider

Production uses the AWS Provider integration described in [aws-provider.md](aws-provider.md).
The existing Sydney product id `syd1` and browser placements stay immutable. Additional enabled
AWS regions are discovered through AWS APIs and use their AWS region code as product id.

The admin console at `https://admin.console.nevazu.com/aws-provider` shows organization accounts,
billing, credits, regional quotas and inventory. Runtime, reaper, reader and organization billing
access use separate STS roles. Worker secrets contain role references/external IDs and the
existing IAM bootstrap keys. STS sessions refresh automatically; bootstrap key rotation remains
an operator responsibility. The temporary AWS CLI sign-in is never used by production.

Regional network ids are discovered from tagged VPCs, subnets and security groups and stored in
D1. `AWS_REGIONS` remains a compatibility fallback for the original Sydney deployment. The
network-only template is `infra/aws/regional-network.json`; it creates no VM, IP allocation, NAT
gateway or IAM resources. AWS opt-in regions stay unavailable until enabled in the account and
prepared with a regional network.

For AWS Provider regions, what AWS can allocate under the account's live quotas replaces legacy
fixed regional/global instance caps; a budget never limits it. The per-user browser limit, prepaid
balances, immutable placements and the create/delete credential separation still apply. AWS
Budgets alerts, if configured, remain notifications only.

The remainder of this runbook documents initial bootstrap and legacy single-region installations.
Do not rerun its old single-region settings over an active dynamic Provider deployment.

## Rules for whoever runs this

1. **Never show, paste or store AWS secret access keys** in chat, logs, files or the repository.
   Keys go straight from AWS into Cloudflare with `wrangler secret put` (step 6). If a secret
   leaks, delete that access key in IAM at once and create a new one.
2. **Never create access keys for the root user.** Use AWS CloudShell (in the console, no keys
   needed) or an IAM Identity Center / admin user that the owner signed in with.
3. **Region:** use the project's selected Region. This deployment uses `ap-southeast-2` (Sydney).
   Tokyo and US West commands below are reference examples only for advanced AWS projects that
   permit those Regions; the current new AWS experience cannot deploy across Regions.
4. **Don't edit `infra/aws/cloudbrowser.yaml`** or its IAM policies, and never add inbound
   security-group rules. If something is refused, report the exact error instead.
5. **Spending:** nothing here costs money until the first browser is created in step 9.
   Quota increases are free.

## 0. Before you start (check what already exists)

The app must already run on Cloudflare (`docs/deploy-cloudflare.md`, sections 1 to 5). Check:

```bash
# From a checkout of this repository, logged in with `pnpm exec wrangler login`:
cd apps/api && pnpm exec wrangler secret list                 # BETTER_AUTH_SECRET, VIEWER_TOKEN_PRIVATE_KEY, TURN_KEY_API_TOKEN
cd ../gateway && pnpm exec wrangler secret list               # (VIEWER_TOKEN_PUBLIC_KEY is a var in wrangler.jsonc)
cd ../engine && pnpm exec wrangler secret list                # BOOTSTRAP_SECRET
```

and in the configs:

| File | Must be set |
|---|---|
| `apps/api/wrangler.jsonc` | `APP_URL` = `https://<app domain>`, `GATEWAY_URL` = `wss://<gateway domain>`, `TURN_KEY_ID` |
| `apps/gateway/wrangler.jsonc` | `VIEWER_TOKEN_PUBLIC_KEY`, and the gateway Worker has its custom domain |
| `apps/engine/wrangler.jsonc` | `GATEWAY_URL` = the same `wss://…`, `APP_URL` = the same `https://…` (step 7) |
| engine, reaper, reconciler configs | the same `ENV_NAME` in all three (it tags every AWS resource) |

**TURN is required on AWS.** A VM accepts no inbound connections, so live video always flows
through Cloudflare's TURN relay. Without `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` on the api, the
browser runs but the live view stays black.

Check: open `https://<app domain>/api/v1/health`; it returns `{"ok":true}`.

## 1. AWS account (you; Tokyo reference for advanced projects)

1. Sign up at aws.amazon.com and add a payment method.
2. Turn on **MFA for the root user**: account menu → Security credentials.
3. Day to day, sign in with something other than root. The simplest is an admin through IAM
   Identity Center. Alternatively, an IAM user with `AdministratorAccess`, a console password
   and MFA.
4. In the console's region menu, pick **Asia Pacific (Tokyo) ap-northeast-1**.
5. Open **CloudShell** (the terminal icon in the console's top bar). The next steps' commands run
   there; it is already signed in and needs no keys.

Check (CloudShell):

```bash
aws sts get-caller-identity          # shows your account id; the Arn must not end in :root
aws configure get region || export AWS_DEFAULT_REGION=ap-northeast-1
```

## 2. Quotas

```bash
export AWS_DEFAULT_REGION=ap-northeast-1
# Running On-Demand Standard instances (vCPUs). Each browser VM uses 2 while running.
aws service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A --query Quota.Value
# Elastic IPs. Each browser keeps one, also while asleep. The default 5 is enough for a first test.
aws service-quotas get-service-quota --service-code ec2 --quota-code L-0263D0A3 --query Quota.Value
```

If the vCPU value is below 8, request 16 (free, usually approved within hours):

```bash
aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-1216C47A --desired-value 16
```

Later, before inviting more people, request 20 Elastic IPs the same way (`L-0263D0A3`).

## 3. CloudFormation stack

It creates:

- a VPC with one subnet per availability zone and no automatic public IPs;
- a security group with **no inbound rules** and no outbound mail ports;
- three IAM users, each limited to resources tagged `cb:managed=true`:
  - `cloudbrowser-runtime`: create, start and stop; denied every delete;
  - `cloudbrowser-reaper`: stop and delete only; denied every create;
  - `cloudbrowser-readonly`: describe resources and read quotas;
- optionally, a monthly budget with email alerts at 50%, 80% and 100%.

```bash
export AWS_DEFAULT_REGION=ap-northeast-1
curl -fsSLO https://raw.githubusercontent.com/DFerryman/cloudbrowser-mono/main/infra/aws/cloudbrowser.yaml
aws cloudformation deploy \
  --stack-name cloudbrowser \
  --template-file cloudbrowser.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides BudgetEmail=you@example.com MonthlyBudgetUsd=50
```

Replace `you@example.com` (or pass `BudgetEmail=` to skip the budget). It takes 2 to 4 minutes.
If it fails on `MonthlyBudget`, run it again with `BudgetEmail=` and create the budget in
Billing → Budgets instead.

The same can be done in the console: CloudFormation → Create stack → With new resources → Upload
a template file. Use stack name `cloudbrowser`, and tick the IAM acknowledgement.

Check:

```bash
aws cloudformation describe-stacks --stack-name cloudbrowser --query 'Stacks[0].StackStatus' --output text   # CREATE_COMPLETE
aws cloudformation describe-stacks --stack-name cloudbrowser \
  --query "Stacks[0].Outputs[?OutputKey=='AwsRegions'].OutputValue" --output text
```

The last command prints one line of JSON, like
`{"ap-northeast-1":{"subnets":{"ap-northeast-1a":"subnet-…","ap-northeast-1c":"subnet-…","ap-northeast-1d":"subnet-…"},"securityGroupId":"sg-…"}}`.
This is the value of `AWS_REGIONS` in step 6. It holds no secret, so it can be copied around.

## 4. Container images (GitHub)

GitHub Actions already builds the two images the VMs run, on every push to `main` that changes
`images/` or `services/agent/`. To build them on demand: repository → Actions → **Images** → Run
workflow.

- `ghcr.io/dferryman/cloudbrowser-browser:main`: neko + Google Chrome
- `ghcr.io/dferryman/cloudbrowser-agent:main`: the agent and the VM's systemd units, scripts and
  firewall rules

A VM takes both images at its first boot only; waking it does not pull them again. A new build
therefore reaches new browsers, and an existing browser only when it gets a new VM: operator
console → the browser → **Recover** (same IP and data; put it to sleep first, so Chrome closes
cleanly instead of with the VM). Its agent version
is in D1 (`instance_health.agent_version`, reported at each `ready`).

**(you)** New packages are private, and VMs pull without a password. Make both public once: GitHub
→ your profile → **Packages** → `cloudbrowser-browser` → Package settings → Danger Zone → **Change
visibility → Public**. Then the same for `cloudbrowser-agent`. They contain no secrets.

Check, from any machine with Docker and **without** logging in to ghcr.io:

```bash
docker logout ghcr.io
docker manifest inspect ghcr.io/dferryman/cloudbrowser-agent:main >/dev/null && echo agent public
docker manifest inspect ghcr.io/dferryman/cloudbrowser-browser:main >/dev/null && echo browser public
```

## 5. Access keys

One key per IAM user. Each key goes to exactly one Worker:

| IAM user | Worker | wrangler config |
|---|---|---|
| `cloudbrowser-runtime` | `cloudbrowser-engine` | `apps/engine/wrangler.jsonc` |
| `cloudbrowser-reaper` | `cloudbrowser-reaper` | `apps/engine/wrangler.reaper.jsonc` |
| `cloudbrowser-readonly` | `cloudbrowser-reconciler` | `apps/reconciler/wrangler.jsonc` |

**Option A: the console.** IAM → Users → the user → Security credentials → **Create access key**
→ "Application running outside AWS". Keep the page open, and paste the two values into the
`wrangler secret put` prompts in step 6. The secret is shown only this once.

**Option B: one machine with both the AWS CLI and wrangler** (signed in to both). The key never
appears on screen:

```bash
# From the repository root. Run once per user; the three blocks differ only in user and config.
put_key() {  # $1 = IAM user, $2 = Worker directory, $3 = extra wrangler args
  local key; key=$(aws iam create-access-key --user-name "$1" --output json) || return 1
  (cd "$2" && printf '%s' "$(jq -r .AccessKey.AccessKeyId <<<"$key")" | pnpm exec wrangler secret put AWS_ACCESS_KEY_ID $3 \
    && printf '%s' "$(jq -r .AccessKey.SecretAccessKey <<<"$key")" | pnpm exec wrangler secret put AWS_SECRET_ACCESS_KEY $3)
}
put_key cloudbrowser-runtime  apps/engine
put_key cloudbrowser-reaper   apps/engine "-c wrangler.reaper.jsonc"
put_key cloudbrowser-readonly apps/reconciler
```

Check: each user has exactly one active key, created just now.

```bash
for u in cloudbrowser-runtime cloudbrowser-reaper cloudbrowser-readonly; do
  aws iam list-access-keys --user-name $u --query 'AccessKeyMetadata[].[UserName,Status,CreateDate]' --output text
done
```

## 6. Cloudflare secrets

From the repository root. Run the commands left out by step 5 option B, and the `AWS_REGIONS` ones
in any case. Each command prompts for the value; paste it and press Enter.

```bash
cd apps/engine
pnpm exec wrangler secret put AWS_ACCESS_KEY_ID                        # runtime key id      (option A only)
pnpm exec wrangler secret put AWS_SECRET_ACCESS_KEY                    # runtime secret      (option A only)
pnpm exec wrangler secret put AWS_REGIONS                              # the JSON from step 3
pnpm exec wrangler secret put AWS_ACCESS_KEY_ID -c wrangler.reaper.jsonc        # reaper key id   (option A only)
pnpm exec wrangler secret put AWS_SECRET_ACCESS_KEY -c wrangler.reaper.jsonc    # reaper secret   (option A only)
pnpm exec wrangler secret put AWS_REGIONS -c wrangler.reaper.jsonc             # the JSON from step 3
cd ../reconciler
pnpm exec wrangler secret put AWS_ACCESS_KEY_ID                        # read-only key id    (option A only)
pnpm exec wrangler secret put AWS_SECRET_ACCESS_KEY                    # read-only secret    (option A only)
pnpm exec wrangler secret put AWS_REGIONS                              # the JSON from step 3
```

Check: each list shows `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGIONS`.

```bash
cd apps/engine && pnpm exec wrangler secret list && pnpm exec wrangler secret list -c wrangler.reaper.jsonc
cd ../reconciler && pnpm exec wrangler secret list
```

## 7. Engine settings and deploy

Edit `apps/engine/wrangler.jsonc` → `vars`:

- `APP_URL`: `https://<app domain>` (VMs check what IP websites see at `<APP_URL>/api/echo/ip`)
- `GATEWAY_URL`: `wss://<gateway domain>` (VMs connect their agent here)

Optional: `AGENT_IMAGE` and `BROWSER_IMAGE` pin the images to a build, e.g.
`ghcr.io/dferryman/cloudbrowser-browser:sha-<commit>`. Without them, new VMs use `:main`.

Then, from the repository root:

```bash
pnpm install
pnpm db:migrate:remote
pnpm deploy
```

Check: `pnpm deploy` ends without errors for the engine, reaper, reconciler, api and gateway.

## 8. Switch Tokyo to AWS (advanced-project reference)

```bash
pnpm --filter @cloudbrowser/api exec wrangler d1 execute cloudbrowser --remote \
  --command "UPDATE regions SET executor = 'aws-ec2' WHERE id = 'tyo1'"
pnpm --filter @cloudbrowser/api exec wrangler d1 execute cloudbrowser --remote \
  --command "SELECT id, executor, provider_region FROM regions"
```

Check: `tyo1 | aws-ec2 | ap-northeast-1`. New browsers in Tokyo now go to AWS. To switch back, set
`executor = 'fake'`; existing AWS browsers keep running on AWS.

## 9. First browser (this starts spending)

In the app, create a browser in **Tokyo**. What to expect:

| Stage | Time | Shown as |
|---|---|---|
| Elastic IP, network interface, volume, VM | about 1 minute | Creating |
| First boot: install Docker, pull the images (about 2 GB), start Chrome and the agent | 3–8 minutes, once per browser | Starting Chrome |
| IP checked inside Chrome | seconds | Running |
| Later wakes: VM start, Chrome, IP check | about 1 minute | Waking |

Then:

1. Open the browser and visit a site; the toolbar shows the dedicated IP.
2. **Settings → Verify IP**: should say websites see that IP.
3. Put it to sleep (toolbar → **More** → **Sleep now**), then open it again. It should wake with the same IP,
   tabs and sign-ins.

Check in AWS (CloudShell):

```bash
aws ec2 describe-instances --filters Name=tag:cb:managed,Values=true \
  --query 'Reservations[].Instances[].[InstanceId,State.Name,InstanceType,PublicIpAddress,Tags[?Key==`cb:instance`]|[0].Value]' --output table
aws ec2 describe-addresses --filters Name=tag:cb:managed,Values=true --query 'Addresses[].[PublicIp,AllocationId]' --output table
```

The operator console (`https://<app domain>/admin`) shows each step's journal, the AWS ids and any
alerts.

## Troubleshooting

| Symptom | Where to look | Usual cause |
|---|---|---|
| Stuck at *Starting Chrome*, then *Failed* after 16 minutes | `aws ec2 get-console-output --instance-id i-… --latest --output text \| grep cloudbrowser:` (or EC2 → instance → Actions → Monitor and troubleshoot → Get system log) | Images still private (`pull access denied`); `GATEWAY_URL` wrong or not `wss://` |
| *Starting Chrome* with supervisor permission or pid/socket errors | VM bootstrap and browser container logs | Supervisor must start as root; its Chrome and neko child programs must still run as the unprivileged `neko` user |
| *Starting Chrome* with CDP unavailable or isolated-context errors | Chrome managed policies and agent logs | Inherited policies disable DevTools or incognito; remove only those conflicting policy keys as described below |
| IP check fails with a CORS error from origin `null` | Agent logs; `GET /api/echo/ip` response | The fresh `about:blank` context needs `Access-Control-Allow-Origin: *` on the public IP echo endpoint |
| *Failed* right after create, alert `forbidden` | /admin → Alerts | Missing key on that Worker, or the key belongs to another IAM user |
| *Failed*, alert `invalid`: "AWS region … is not configured" | engine logs | `AWS_REGIONS` missing or not valid JSON |
| *Failed* within a minute of create, alert `forbidden` with "ended during launch: … Client.InvalidKMSKey.InvalidState …" or "EBS could not create volume …"; the region shows *Blocked* | /admin → Alerts (the message carries EC2's state reason); /admin → AWS Provider → Launches; `launch_health` in D1 | The account may not use the region's EBS encryption key. EC2 reports a KMS call denied by IAM, an organization SCP or the key policy as "the KMS key is in an incorrect state", so it looks like a disabled key. Check any organization SCP regional restriction first: it must allow the KMS calls EC2 makes on the role's behalf there (`kms:CreateGrant`, `kms:Decrypt`, `kms:GenerateDataKeyWithoutPlaintext`, `kms:ReEncryptFrom`, `kms:ReEncryptTo`, `kms:DescribeKey`); see `infra/aws/organization-scp/`. Then the key's state and key policy. New browsers there are refused, without probes, until the operator reopens the region (/admin → AWS Provider → Reopen, or `DELETE FROM launch_health WHERE region_id = '…'`) or a launch there succeeds |
| *Waiting for capacity* | /admin → Operations | No capacity for any of the three instance types in any zone of the region. A new browser first moves to the region's other zones (the reaper releases the empty disk and interface it leaves), then keeps retrying; a waking browser moves to another zone after 30 minutes. A VM that EC2 ends during launch is relaunched with a new token, never retried as the same dead VM |
| Alert `quota` | Service Quotas | vCPU or Elastic IP limit (step 2) |
| Premium create *Failed* with `UnauthorizedOperation`; Basic still works | engine logs; the runtime policy | The runtime identity may not launch `c7i.xlarge`/`c6i.xlarge`/`c5.xlarge` yet (Premium step 1). Such a refusal does not block the region for Basic |
| Premium browser runs at about 25 fps | VM system log (`cloudbrowser:` lines); toolbar codec | The browser image predates `neko-premium.yaml` (the VM falls back to the Basic stream and logs it), or `BROWSER_IMAGE`/`AGENT_IMAGE` pin an older build |
| Running, but the live view stays black | browser devtools console; api config | TURN key missing on the api; gateway domain or viewer keys wrong |
| Chrome fills only part of the desktop, with black space on the right | Browser supervisor configuration and `openbox` process | Preserve the upstream Openbox program when replacing the Chrome configuration; `--start-maximized` needs a window manager |
| *Needs attention*: "Network paused while we check your dedicated IP" | /admin → the browser → Last IP check | Chrome saw a different IP than the Elastic IP; it stays blocked until checked |

The browser container starts supervisor as root (`--user root` in the systemd Docker command),
while the supervisor program configurations keep Chrome and neko running as `neko`. Running the
whole container as `neko` prevents supervisor from managing its pid/socket and leaves startup stuck.

Some upstream browser images set `DeveloperToolsAvailability=2` and
`IncognitoModeAvailability=1` in inherited managed policies. Remove those two keys from the
inherited policy files, preserving all other policies, and set `DeveloperToolsAvailability=1`
and `IncognitoModeAvailability=0` in `cloudbrowser.json`. The agent needs CDP and an isolated
browser context for its IP check. The first-boot script also patches older image versions and
mounts the corrected policy directory read-only; clearing all managed policies is unnecessary.
The public `/api/echo/ip` endpoint must return `Access-Control-Allow-Origin: *` and
`Cache-Control: no-store` so that check can read its result from a fresh `about:blank` context.

Engine logs: `cd apps/engine && pnpm exec wrangler tail` (the reaper: add `-c wrangler.reaper.jsonc`).

## Turning it off or cleaning up

- **Stop new browsers in Sydney:** set `regions.enabled = 0` for `syd1`; existing instances remain
  usable. For the Tokyo reference, switching its executor back to `fake` (step 8) sends new creates
  to the simulator instead of AWS.
- **Remove one browser:** delete it in the app. Within 7 days it can be restored. After that the
  reaper deletes the VM, disks, network interface and snapshots and releases the IP. The engine
  itself never deletes anything.
- **Remove everything:** delete every AWS browser in the app and wait for the purge (or for a
  test account, terminate the tagged resources in the EC2 console). Then delete the stack:
  `aws cloudformation delete-stack --stack-name cloudbrowser`. The stack can only be deleted once
  no network interface uses its subnets.

## Second region (US West; advanced-project reference only)

This example requires an advanced AWS project that permits both Regions. It does not apply to
the current Sydney project in the new AWS experience; do not run it there.

```bash
export AWS_DEFAULT_REGION=us-west-2
aws cloudformation deploy --stack-name cloudbrowser --template-file cloudbrowser.yaml \
  --capabilities CAPABILITY_NAMED_IAM --parameter-overrides CreateAccountResources=false
```

`CreateAccountResources=false`: the IAM users and the budget already exist. Merge the new
`AwsRegions` output into the existing value (`{"ap-northeast-1":{…},"us-west-2":{…}}`), put it again
on all three Workers (step 6), then switch `usw1` as in step 8.

## Not done yet

- A pre-built golden image (`images/vm`, Packer), so new browsers skip the first-boot install.
- Signed images (cosign) that the agent checks before running them.
