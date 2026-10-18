# Real browsers on AWS: setup runbook

This runbook takes a new AWS account to the first real browser. It is written so that a person,
or an AI agent helping them, can follow it step by step: every step has exact commands and a
check. Steps marked **(you)** need the account owner in person. An agent cannot do them: sign-up,
payment, MFA and changes to GitHub package visibility.

**What you get:** browsers created in Tokyo run on real EC2 VMs. Each has a dedicated Elastic IP,
an encrypted 20 GB data volume and a 2 vCPU / 8 GB VM. The VM is stopped, never terminated, while
the browser sleeps. Browsers created earlier on the simulator keep running there.

**Cost (public list prices, estimates, not quotes):** about $0.11 per running hour
(`m7i-flex.large` in Tokyo). A sleeping browser costs about $6 a month (Elastic IP $3.65, plus the
20 GB data disk and the 16 GB system disk).

## Rules for whoever runs this

1. **Never show, paste or store AWS secret access keys** in chat, logs, files or the repository.
   Keys go straight from AWS into Cloudflare with `wrangler secret put` (step 6). If a secret
   leaks, delete that access key in IAM at once and create a new one.
2. **Never create access keys for the root user.** Use AWS CloudShell (in the console, no keys
   needed) or an IAM Identity Center / admin user that the owner signed in with.
3. **Region:** everything happens in `ap-northeast-1` (Tokyo) unless a step says otherwise.
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

## 1. AWS account (you)

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

## 8. Switch Tokyo to AWS

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
| *Failed* right after create, alert `forbidden` | /admin → Alerts | Missing key on that Worker, or the key belongs to another IAM user |
| *Failed*, alert `invalid`: "AWS region … is not configured" | engine logs | `AWS_REGIONS` missing or not valid JSON |
| *Waiting for capacity* | /admin → Operations | No capacity for any of the three instance types in the zone; it keeps retrying (a waking browser moves to another zone after 30 minutes) |
| Alert `quota` | Service Quotas | vCPU or Elastic IP limit (step 2) |
| Running, but the live view stays black | browser devtools console; api config | TURN key missing on the api; gateway domain or viewer keys wrong |
| *Needs attention*: "Network paused while we check your dedicated IP" | /admin → the browser → Last IP check | Chrome saw a different IP than the Elastic IP; it stays blocked until checked |

Engine logs: `cd apps/engine && pnpm exec wrangler tail` (the reaper: add `-c wrangler.reaper.jsonc`).

## Turning it off or cleaning up

- **Stop new AWS browsers:** set the region back to `fake` (step 8).
- **Remove one browser:** delete it in the app. Within 7 days it can be restored. After that the
  reaper deletes the VM, disks, network interface and snapshots and releases the IP. The engine
  itself never deletes anything.
- **Remove everything:** delete every AWS browser in the app and wait for the purge (or for a
  test account, terminate the tagged resources in the EC2 console). Then delete the stack:
  `aws cloudformation delete-stack --stack-name cloudbrowser`. The stack can only be deleted once
  no network interface uses its subnets.

## Second region (US West)

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
- Trying another zone when a zone has no capacity at create time. Today a new browser tries the
  other instance types in the first zone, then retries; `recover` moves existing browsers.
- After a confirmed IP change, the live view needs one sleep and wake to advertise the new IP.
- Signed images (cosign) that the agent checks before running them.
