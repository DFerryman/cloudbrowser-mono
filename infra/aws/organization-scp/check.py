# Checks the policy logic of before/*.json against the current files with IAM's custom-policy
# simulator: the KMS actions EBS needs are allowed only for the Nevazu account through EC2, and
# every other case decides as before. Changes nothing in AWS.
#
# usage: python3 -I infra/aws/organization-scp/check.py [aws CLI args, e.g. --profile admin]
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
AWS = ["aws", *sys.argv[1:], "--region", "us-east-1"]
ALLOW_ALL = json.dumps({"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}]})
NEVAZU, OTHER = "346565070970", "168789041921"
FLOOR, USW2 = "NevazuRegionalAPIs-RegionFloor.json", "NevazuRegionalAPIs-UsWest2Partitional.json"

# (policy, action, region, account, KMS caller service, decision expected after the change)
CASES = [
    (FLOOR, "kms:CreateGrant", "ap-northeast-1", NEVAZU, "ec2.ap-northeast-1.amazonaws.com", "allowed"),
    (FLOOR, "kms:GenerateDataKeyWithoutPlaintext", "ap-northeast-1", NEVAZU, "ec2.ap-northeast-1.amazonaws.com", "allowed"),
    (FLOOR, "kms:Decrypt", "eu-central-1", NEVAZU, "ec2.eu-central-1.amazonaws.com", "allowed"),
    (FLOOR, "kms:CreateGrant", "ap-northeast-1", NEVAZU, None, "explicitDeny"),
    (FLOOR, "kms:Decrypt", "ap-northeast-1", NEVAZU, "s3.ap-northeast-1.amazonaws.com", "explicitDeny"),
    (FLOOR, "kms:CreateGrant", "ap-northeast-1", OTHER, "ec2.ap-northeast-1.amazonaws.com", "explicitDeny"),
    (FLOOR, "kms:Encrypt", "ap-northeast-1", NEVAZU, "ec2.ap-northeast-1.amazonaws.com", "explicitDeny"),
    (FLOOR, "kms:CreateKey", "ap-northeast-1", NEVAZU, None, "explicitDeny"),
    (FLOOR, "ec2:RunInstances", "ap-northeast-1", NEVAZU, None, "allowed"),
    (FLOOR, "cloudtrail:LookupEvents", "ap-northeast-1", NEVAZU, None, "explicitDeny"),
    (FLOOR, "s3:CreateBucket", "eu-west-1", OTHER, None, "explicitDeny"),
    (FLOOR, "kms:Encrypt", "ap-southeast-2", OTHER, None, "allowed"),
    (USW2, "kms:CreateGrant", "us-west-2", NEVAZU, "ec2.us-west-2.amazonaws.com", "allowed"),
    (USW2, "kms:GenerateDataKeyWithoutPlaintext", "us-west-2", NEVAZU, "ec2.us-west-2.amazonaws.com", "allowed"),
    (USW2, "kms:CreateGrant", "us-west-2", OTHER, "ec2.us-west-2.amazonaws.com", "explicitDeny"),
    (USW2, "kms:CreateGrant", "us-west-2", NEVAZU, None, "explicitDeny"),
    (USW2, "kms:Decrypt", "us-west-2", OTHER, None, "allowed"),
    (USW2, "kms:Encrypt", "us-west-2", NEVAZU, "ec2.us-west-2.amazonaws.com", "explicitDeny"),
    (USW2, "kms:CreateGrant", "ap-northeast-1", OTHER, None, "allowed"),
]

# The KMS actions added for EBS; every other case must decide exactly as before.
EBS_KMS = {"kms:CreateGrant", "kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKeyWithoutPlaintext", "kms:ReEncryptFrom", "kms:ReEncryptTo"}


def decide(policy, action, region, account, via):
    ctx = [f"ContextKeyName=aws:RequestedRegion,ContextKeyValues={region},ContextKeyType=string",
           f"ContextKeyName=aws:PrincipalAccount,ContextKeyValues={account},ContextKeyType=string"]
    if via:
        ctx.append(f"ContextKeyName=kms:ViaService,ContextKeyValues={via},ContextKeyType=string")
    out = subprocess.run([*AWS, "iam", "simulate-custom-policy", "--policy-input-list", ALLOW_ALL, policy, "--action-names", action,
                          "--resource-arns", "*", "--context-entries", *ctx, "--output", "json"], capture_output=True, text=True)
    if out.returncode:
        sys.exit(out.stderr.strip())
    return json.loads(out.stdout)["EvaluationResults"][0]["EvalDecision"]


failures = 0
for name, action, region, account, via, want in CASES:
    before = decide(open(os.path.join(HERE, "before", name)).read(), action, region, account, via)
    after = decide(open(os.path.join(HERE, name)).read(), action, region, account, via)
    intended = action in EBS_KMS and account == NEVAZU and (via or "").startswith("ec2.")
    ok = after == want and (before == after or intended)
    failures += not ok
    who = "Nevazu" if account == NEVAZU else "other"
    print(f"{'PASS' if ok else 'FAIL'}  {name.split('-')[-1][:-5]:20} {action:38} {region:15} {who:6} via={(via or '-').split('.')[0]:4} {before} -> {after}")
print(f"{failures} failure(s)")
sys.exit(1 if failures else 0)
