# Real browsers on AWS (aws-ec2 executor)

Browsers created in a region whose executor is `aws-ec2` run on real EC2 VMs: a dedicated Elastic
IP, an encrypted 20 GB data volume and a 2 vCPU / 8 GB VM that is stopped (never terminated) while
the browser sleeps. Browsers created earlier on the simulator keep running there.

Start with Tokyo (`ap-northeast-1`). US West works the same way (second stack, see the end).

**Cost (public list prices, estimates):** about $0.11 per running hour (`m7i-flex.large`), and
about $6 per month per browser while it sleeps (Elastic IP $3.65 + 20 GB data and 16 GB root disk).

## 1. AWS account (once)

1. Turn on MFA for the root user. Don't use root day to day.
2. Pick **Asia Pacific (Tokyo) ap-northeast-1** in the console's region menu.
3. **Service Quotas → Amazon EC2 → "Running On-Demand Standard (A, C, D, H, I, M, R, T, Z)
   instances"**: if it is below 8 vCPUs, request 16. New accounts sometimes start lower. The default
   of 5 Elastic IPs is enough for a first test (request 20 later: "EC2-VPC Elastic IPs").

## 2. CloudFormation stack (once per region)

CloudFormation → **Create stack → With new resources** → *Upload a template file* →
`infra/aws/cloudbrowser.yaml` from this repository.

- Stack name: `cloudbrowser`
- `BudgetEmail`: your email for budget alerts at 50%, 80% and 100% (optional); `MonthlyBudgetUsd`: 50
- Leave the other parameters as they are.
- Tick **"I acknowledge that AWS CloudFormation might create IAM resources with custom names"**.

It creates:

- a VPC with one subnet per availability zone, no automatic public IPs;
- a security group with **no inbound rules** and no outbound mail ports;
- three IAM users, each limited to resources tagged `cb:managed=true`:
  - `cloudbrowser-runtime`: create, start, stop; explicitly denied every delete;
  - `cloudbrowser-reaper`: stop and delete only; explicitly denied every create;
  - `cloudbrowser-readonly`: describe and read quotas.

When the stack is `CREATE_COMPLETE`, open its **Outputs** tab and copy the value of `AwsRegions`
(one line of JSON with the subnet and security group ids).

## 3. Access keys (once)

IAM → Users → **cloudbrowser-runtime** → Security credentials → **Create access key** → "Application
running outside AWS". Copy both values straight into the Worker (step 5): the secret is shown once.
Repeat for **cloudbrowser-reaper** and **cloudbrowser-readonly**.

Never paste these keys anywhere else (not in chat, not in the repository).

## 4. Images (GitHub, once)

1. GitHub → this repository → **Actions → Images → Run workflow** (branch `main`). It builds
   `ghcr.io/<owner>/cloudbrowser-browser` (neko + Chrome) and `ghcr.io/<owner>/cloudbrowser-agent`
   (the agent and the VM's systemd units, scripts and firewall rules). It also runs on every push
   to `main` that changes `images/` or `services/agent/`.
2. New packages are private. Make both public once: your GitHub profile → **Packages** → the
   package → **Package settings → Change visibility → Public**. They contain no secrets; VMs pull
   them without a password.

## 5. Cloudflare Workers

```bash
# Engine: runtime user
cd apps/engine
pnpm exec wrangler secret put AWS_ACCESS_KEY_ID          # cloudbrowser-runtime key id
pnpm exec wrangler secret put AWS_SECRET_ACCESS_KEY      # cloudbrowser-runtime secret
pnpm exec wrangler secret put AWS_REGIONS                # paste the AwsRegions output

# Reaper: delete-only user
pnpm exec wrangler secret put AWS_ACCESS_KEY_ID -c wrangler.reaper.jsonc       # cloudbrowser-reaper
pnpm exec wrangler secret put AWS_SECRET_ACCESS_KEY -c wrangler.reaper.jsonc
pnpm exec wrangler secret put AWS_REGIONS -c wrangler.reaper.jsonc

# Reconciler: read-only user
cd ../reconciler
pnpm exec wrangler secret put AWS_ACCESS_KEY_ID          # cloudbrowser-readonly
pnpm exec wrangler secret put AWS_SECRET_ACCESS_KEY
pnpm exec wrangler secret put AWS_REGIONS
```

`apps/engine/wrangler.jsonc` → `vars`:

- `APP_URL`: your app's origin, e.g. `https://app.example.com`. VMs check what IP websites see
  through `${APP_URL}/api/echo/ip`.
- `GATEWAY_URL`: `wss://connect.example.com` (same as the api's).

Check that these from earlier are set, or live view on a real VM cannot work:

- api: `GATEWAY_URL`, `VIEWER_TOKEN_PRIVATE_KEY`, and the TURN key (`TURN_KEY_ID`,
  `TURN_KEY_API_TOKEN`). The VM accepts no inbound connections, so video always flows through
  Cloudflare's TURN relay.
- gateway: `VIEWER_TOKEN_PUBLIC_KEY` and its custom domain `connect.example.com`.
- `ENV_NAME` is the same in the engine, reaper and reconciler configs (it tags every AWS resource).

Then deploy: `pnpm db:migrate:remote && pnpm deploy`.

## 6. Switch Tokyo to AWS

```bash
pnpm --filter @cloudbrowser/api exec wrangler d1 execute cloudbrowser --remote \
  --command "UPDATE regions SET executor = 'aws-ec2' WHERE id = 'tyo1'"
```

New browsers in Tokyo now go to AWS. To go back: `executor = 'fake'`.

## 7. First browser

Create a browser in Tokyo. What happens:

| Step | Time |
|---|---|
| Elastic IP, network interface, volume, VM | about 1 minute |
| First boot: install Docker, pull the images (about 2 GB), start Chrome and the agent | 3–8 minutes, once per browser |
| IP checked inside Chrome, status *Running* | seconds |
| Later wakes (VM start, Chrome, IP check) | about 1 minute |

Then open it, browse, let it sleep (or use *Sleep*), wake it, and check **Settings → Verify IP**.
The operator console (`/admin`) shows each step's journal and the AWS resource ids.

## Troubleshooting

- **Stuck at "Starting Chrome" / failed after 16 minutes:** EC2 → Instances → the instance
  (tagged `Name=cloudbrowser-<browser id>`) → **Actions → Monitor and troubleshoot → Get system log**.
  Lines starting with `cloudbrowser:` are the first-boot script. Common causes: the GHCR packages
  are still private (pull denied), or `GATEWAY_URL` points somewhere the VM cannot reach.
- **`forbidden` errors in /admin alerts:** an access key is missing on that Worker, or it belongs to
  the wrong IAM user (the engine needs runtime, the reaper needs reaper).
- **"Waiting for capacity":** the zone has no capacity for any of the allowed instance types. A
  waking browser is moved to another zone (same IP and data) after 30 minutes; a new browser
  retries until its 20-minute deadline.
- **`quota` errors:** Elastic IPs or vCPUs are at their limit (step 1.3).
- Nothing is ever deleted by the engine. Deleted browsers are purged by the reaper after 7 days;
  the reconciler raises an alert for any tagged AWS resource that is not in the ledger.

## Second region (US West)

Deploy the same template in **us-west-2** with `CreateAccountResources = false` (the IAM users and
the budget already exist). Merge its `AwsRegions` output into the existing secret value:
`{"ap-northeast-1":{...},"us-west-2":{...}}`, then switch `usw1` like step 6.

## Not done yet

- A pre-built golden image (`images/vm`, Packer) so new browsers skip the first-boot install.
- Trying another zone when a zone has no capacity at create time (today: other instance types in
  the first zone, then retries; `recover` moves zones for existing browsers).
- After a confirmed IP change, the live view needs one sleep and wake to advertise the new IP.
- Signed images (cosign) checked by the agent before it runs them.
