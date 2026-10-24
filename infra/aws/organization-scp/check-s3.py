# Checks the policy logic of before-s3/*.json against the current files with IAM's custom-policy
# simulator: the S3 actions for profile archives are allowed only for the Nevazu account on its
# nevazu-archives-* buckets, and every other case decides as before. Changes nothing in AWS.
#
# usage: python3 -I infra/aws/organization-scp/check-s3.py [aws CLI args, e.g. --profile admin]
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
AWS = ["aws", *sys.argv[1:], "--region", "us-east-1"]
ALLOW_ALL = json.dumps({"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}]})
NEVAZU, OTHER = "346565070970", "168789041921"
FLOOR, USW2 = "NevazuRegionalAPIs-RegionFloor.json", "NevazuRegionalAPIs-UsWest2Partitional.json"
CALLERS = {NEVAZU: f"arn:aws:iam::{NEVAZU}:role/nevazu-provider-runtime", OTHER: f"arn:aws:iam::{OTHER}:role/some-role"}
ARCHIVE_ACTIONS = {"s3:CreateBucket", "s3:DeleteObject", "s3:GetBucketLocation", "s3:GetObject", "s3:ListBucket", "s3:PutBucketOwnershipControls",
                   "s3:PutBucketPolicy", "s3:PutBucketPublicAccessBlock", "s3:PutEncryptionConfiguration", "s3:PutLifecycleConfiguration", "s3:PutObject"}


def bucket(region):
    return f"arn:aws:s3:::nevazu-archives-{NEVAZU}-{region}"


def obj(region):
    return f"{bucket(region)}/archives/inst/backup.cbar"


# (policy, action, region, caller, resource, decision expected after the change)
CASES = [
    (FLOOR, "s3:PutObject", "eu-west-2", NEVAZU, obj("eu-west-2"), "allowed"),
    (FLOOR, "s3:GetObject", "ap-northeast-1", NEVAZU, obj("ap-northeast-1"), "allowed"),
    (FLOOR, "s3:DeleteObject", "sa-east-1", NEVAZU, obj("sa-east-1"), "allowed"),
    (FLOOR, "s3:CreateBucket", "me-central-1", NEVAZU, bucket("me-central-1"), "allowed"),
    (FLOOR, "s3:PutBucketPublicAccessBlock", "eu-central-1", NEVAZU, bucket("eu-central-1"), "allowed"),
    (FLOOR, "s3:PutObject", "eu-west-2", NEVAZU, "arn:aws:s3:::someone-elses-bucket/x", "explicitDeny"),
    (FLOOR, "s3:CreateBucket", "eu-west-2", NEVAZU, "arn:aws:s3:::nevazu-other", "explicitDeny"),
    (FLOOR, "s3:PutObject", "eu-west-2", OTHER, obj("eu-west-2"), "explicitDeny"),
    (FLOOR, "s3:CreateBucket", "eu-west-1", OTHER, "arn:aws:s3:::anything", "explicitDeny"),
    (FLOOR, "s3:DeleteBucket", "eu-west-2", NEVAZU, bucket("eu-west-2"), "explicitDeny"),
    (FLOOR, "s3:PutBucketAcl", "eu-west-2", NEVAZU, bucket("eu-west-2"), "explicitDeny"),
    (FLOOR, "s3:PutObjectAcl", "eu-west-2", NEVAZU, obj("eu-west-2"), "explicitDeny"),
    (FLOOR, "ec2:RunInstances", "ap-northeast-1", NEVAZU, "*", "allowed"),
    (FLOOR, "cloudtrail:LookupEvents", "ap-northeast-1", NEVAZU, "*", "explicitDeny"),
    (FLOOR, "s3:PutObject", "ap-southeast-2", OTHER, "arn:aws:s3:::anything/x", "allowed"),
    (USW2, "s3:PutObject", "us-west-2", NEVAZU, obj("us-west-2"), "allowed"),
    (USW2, "s3:CreateBucket", "us-west-2", NEVAZU, bucket("us-west-2"), "allowed"),
    (USW2, "s3:PutObject", "us-west-2", NEVAZU, "arn:aws:s3:::someone-elses-bucket/x", "explicitDeny"),
    (USW2, "s3:GetObject", "us-west-2", OTHER, obj("us-west-2"), "explicitDeny"),
    (USW2, "s3:DeleteBucket", "us-west-2", NEVAZU, bucket("us-west-2"), "explicitDeny"),
    (USW2, "s3:PutObject", "ap-northeast-1", OTHER, "arn:aws:s3:::anything/x", "allowed"),
]


def decide(policy, action, region, caller, resource):
    arn = CALLERS[caller]
    ctx = [f"ContextKeyName=aws:RequestedRegion,ContextKeyValues={region},ContextKeyType=string",
           f"ContextKeyName=aws:PrincipalAccount,ContextKeyValues={arn.split(':')[4]},ContextKeyType=string",
           f"ContextKeyName=aws:PrincipalArn,ContextKeyValues={arn},ContextKeyType=string"]
    out = subprocess.run([*AWS, "iam", "simulate-custom-policy", "--policy-input-list", ALLOW_ALL, policy, "--action-names", action,
                          "--resource-arns", resource, "--context-entries", *ctx, "--output", "json"], capture_output=True, text=True)
    if out.returncode:
        sys.exit(out.stderr.strip())
    return json.loads(out.stdout)["EvaluationResults"][0]["EvalDecision"]


failures = 0
for name, action, region, caller, resource, want in CASES:
    before = decide(open(os.path.join(HERE, "before-s3", name)).read(), action, region, caller, resource)
    after = decide(open(os.path.join(HERE, name)).read(), action, region, caller, resource)
    intended = action in ARCHIVE_ACTIONS and caller == NEVAZU and resource.startswith(bucket(""))
    ok = after == want and (before == after or intended)
    failures += not ok
    who = "Nevazu" if caller == NEVAZU else "other"
    print(f"{'PASS' if ok else 'FAIL'}  {name.split('-')[-1][:-5]:20} {action:32} {region:15} {who:7} {resource.split(':::')[-1][:48]:48} {before} -> {after}")
print(f"{failures} failure(s)")
sys.exit(1 if failures else 0)
