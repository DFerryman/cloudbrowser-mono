# Organization SCPs: EBS encryption for Nevazu

The organization `o-t1n78xynb0` (management account `976637053683`) attaches these service control
policies to its root, so they apply to every member account: `346565070970` (Nevazu-CloudBrowser)
and `168789041921` (Identity Delegated Admin). SCPs never apply to the management account.

| Policy | Id | Applies in | Effect |
|---|---|---|---|
| `NevazuRegionalAPIs-RegionFloor` | `p-e0g0f8sh` | every region except ap-southeast-2, us-east-1, us-west-2 | denies all but an enumerated list of Nevazu APIs |
| `NevazuRegionalAPIs-UsWest2Partitional` | `p-zxswrdjc` | us-west-2 | denies all but an enumerated list |
| `AdvancedModeRegionRestrictionSecurityControlPolicy` | `p-vse3360r` | us-east-1 | denies all but listed services (includes `kms:*`); unchanged |
| `ManagedAccountSecurityControlPolicy` | `p-oqj3bf21` | everywhere | blocks leaving the organization and editing managed roles; unchanged |

## The problem (found 2026-10-19)

Nevazu encrypts every browser disk (`Encrypted: true`, the account's default EBS key). EC2 then calls
KMS **as the caller** (`kms:CreateGrant`, `kms:GenerateDataKeyWithoutPlaintext`, `kms:Decrypt`, ...),
and SCPs apply to those calls. Neither Nevazu policy listed any KMS action that EBS needs, so in
31 of the 34 offered regions (all but Sydney and N. Virginia; Oregon lacked `CreateGrant` and
`GenerateDataKeyWithoutPlaintext`):

- an encrypted volume went from `creating` to deleted within ~20 s (`InvalidVolume.NotFound`);
- a VM with an encrypted root disk ended during launch with
  `Client.InvalidKMSKey.InvalidState: The KMS key provided is in an incorrect state`
  (transition reason `Client.InternalError`). This is a permission failure, not
  `Server.InsufficientInstanceCapacity`.

Evidence (2026-10-19): production creates in ap-northeast-1 and ap-southeast-1 failing with "VM …
ended while starting"; `iam simulate-principal-policy` for `role/nevazu-provider-runtime` in
ap-northeast-1 returning `explicitDeny`, `AllowedByOrganizations: false` for those KMS actions;
controlled probes in ap-northeast-1 at 09:01 UTC reproducing both symptoms above (an encrypted
1 GiB volume and a c7i-flex.large with an encrypted root disk); after the change at 09:05 UTC, the
same volume probe became `available` within 7 s, encrypted with the account's `aws/ebs` key
(`67e434da-…`), so the key itself was healthy, and the simulator allowed every action the
runtime, reaper and reader roles use in all 34 offered regions. Neither check covers EC2's own
decrypt at boot: the first real launch afterwards still failed, which led to the
`aws:ec2-infrastructure` condition (applied 09:42 UTC). After it, a production browser in
ap-northeast-3 launched and its agent connected (09:56 UTC), and a probe instance with an
encrypted root volume ran in ap-northeast-1 (10:08 UTC, terminated at once).

## The change

`before/` holds the exact policy content as fetched on 2026-10-19 before the change. The files
next to it are what was applied. The only differences:

1. The six KMS actions EBS needs (`kms:CreateGrant`, `kms:Decrypt`, `kms:DescribeKey`,
   `kms:GenerateDataKeyWithoutPlaintext`, `kms:ReEncryptFrom`, `kms:ReEncryptTo`) are added to the
   existing statement's `NotAction` list (UsWest2Partitional already allowed `Decrypt` and
   `DescribeKey`, so it adds four). The existing statement is otherwise byte-for-byte the same.
2. Two new Deny statements re-deny exactly those added actions in the same regions unless
   - the caller is the Nevazu account (`aws:PrincipalAccount` = `346565070970`), **and**
   - the call comes from EC2: through an EC2 request (`kms:ViaService` like
     `ec2.*.amazonaws.com`), or from EC2's own per-instance role in the Nevazu account
     (`aws:PrincipalArn` like `arn:aws:iam::346565070970:role/*aws:ec2-infrastructure`).

EC2 needs both. Creating an encrypted volume only makes KMS calls through EC2 as the caller, but
when an instance boots, the `aws:ec2-infrastructure` role decrypts each attached volume's data
key itself, under a grant, without `kms:ViaService`. The first version (applied 09:05 UTC) lacked
that condition: an encrypted volume could be created, but every instance still ended at launch
with `Client.InternalError: Client error on launch` (a production create in ap-northeast-1 at
09:35 UTC). IAM does not let accounts create role names containing `aws:`, so the pattern only
matches EC2's role.

So the other member account sees no change, Nevazu's own roles and users cannot call KMS directly
or through any other service, and no other KMS action (Encrypt, CreateKey, key administration,
...) opens.
Within Nevazu, which principal may use a key is still decided by IAM and the key policy; the
production roles have no KMS permissions of their own and use the AWS-managed `aws/ebs` key only
through EC2.

A volume probe alone does not prove the change: verify with an instance launch (below).

## Check, apply, verify

Run with management-account credentials (e.g. `aws login --remote --profile admin`).

```sh
# 1. Policy logic, before vs after, without changing anything (exit 0 = every case as intended)
python3 -I infra/aws/organization-scp/check.py --profile admin

# 2. The live policies must still equal before/ (otherwise someone changed them: merge first)
for p in p-e0g0f8sh:NevazuRegionalAPIs-RegionFloor p-zxswrdjc:NevazuRegionalAPIs-UsWest2Partitional; do
  cmp <(aws organizations describe-policy --profile admin --policy-id ${p%%:*} --query Policy.Content --output text) \
    <(cat infra/aws/organization-scp/before/${p#*:}.json; echo) && echo "${p#*:} unchanged"
done

# 3. Apply
aws organizations update-policy --profile admin --policy-id p-e0g0f8sh \
  --content file://infra/aws/organization-scp/NevazuRegionalAPIs-RegionFloor.json
aws organizations update-policy --profile admin --policy-id p-zxswrdjc \
  --content file://infra/aws/organization-scp/NevazuRegionalAPIs-UsWest2Partitional.json

# 4. Effective policy for the production runtime role (Nevazu account credentials; SCPs included)
aws iam simulate-principal-policy --region us-east-1 \
  --policy-source-arn arn:aws:iam::346565070970:role/nevazu-provider-runtime \
  --action-names kms:CreateGrant kms:GenerateDataKeyWithoutPlaintext --resource-arns '*' \
  --context-entries ContextKeyName=aws:RequestedRegion,ContextKeyValues=ap-northeast-1,ContextKeyType=string \
    ContextKeyName=kms:ViaService,ContextKeyValues=ec2.ap-northeast-1.amazonaws.com,ContextKeyType=string \
  --query 'EvaluationResults[].[EvalActionName,OrganizationsDecisionDetail.AllowedByOrganizations]'
# expect: True for both (was False)

# 5. A real launch: an instance with an encrypted root volume must reach `running`
#    (Nevazu account credentials; terminate it right after; about $0.002)
```

SCP changes take effect within minutes. Then reopen any region the engine blocked
(operator console → AWS Provider → *Reopen*, or `DELETE FROM launch_health WHERE region_id = '…'`)
and run one create there; the region shows as tested once it succeeds.

## Rollback

```sh
aws organizations update-policy --profile admin --policy-id p-e0g0f8sh \
  --content file://infra/aws/organization-scp/before/NevazuRegionalAPIs-RegionFloor.json
aws organizations update-policy --profile admin --policy-id p-zxswrdjc \
  --content file://infra/aws/organization-scp/before/NevazuRegionalAPIs-UsWest2Partitional.json
```

Rolling back blocks encrypted disks again in every region except Sydney and N. Virginia: new
browsers there fail, and existing browsers there cannot start or restore. The engine then marks
those regions blocked after the first failure, so pause creation in them first (operator
console, or disable the region).

## Notes

- SCP documents are limited to 5,120 characters; these are about 3,200.
- These policies are managed by hand in AWS Organizations, not by CloudFormation. Keep this
  directory in sync when either policy changes, and update `before/` with the live content first.
- A CLI sign-in to the Nevazu account must refresh through us-east-1 (`signin:*` is denied in
  the other restricted regions): run any command with `--region us-east-1` once after 15 minutes.
