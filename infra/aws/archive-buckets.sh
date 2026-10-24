#!/usr/bin/env bash
# Creates the S3 bucket for profile archives in each offered region (docs/deploy-cloudflare.md,
# "Profile archives"): <prefix><region>, private, owner-enforced, TLS only, SSE-S3 at rest (the
# archives are also encrypted by the agent before upload). Safe to run again: existing buckets are
# left as they are and their settings re-applied.
#
#   infra/aws/archive-buckets.sh nevazu-archives-346565070970- [region ...]
#
# Without regions it uses every region in packages/contracts/src/aws-regions.ts. Needs the AWS CLI
# with credentials of the Nevazu account that may create buckets.
set -euo pipefail

prefix=${1:?usage: archive-buckets.sh <bucket-prefix> [region ...]}
shift
here=$(cd "$(dirname "$0")" && pwd)
if [ $# -gt 0 ]; then
  regions=("$@")
else
  mapfile -t regions < <(grep -oE "^  '[a-z]{2}-[a-z]+-[0-9]'" "$here/../../packages/contracts/src/aws-regions.ts" | tr -d " '")
fi

for region in "${regions[@]}"; do
  bucket="$prefix$region"
  if aws s3api head-bucket --bucket "$bucket" --region "$region" 2>/dev/null; then
    echo "exists: $bucket"
  elif [ "$region" = us-east-1 ]; then
    aws s3api create-bucket --bucket "$bucket" --region "$region" --object-ownership BucketOwnerEnforced >/dev/null
    echo "created: $bucket"
  else
    aws s3api create-bucket --bucket "$bucket" --region "$region" --object-ownership BucketOwnerEnforced \
      --create-bucket-configuration "LocationConstraint=$region" >/dev/null
    echo "created: $bucket"
  fi
  aws s3api put-public-access-block --bucket "$bucket" --region "$region" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-encryption --bucket "$bucket" --region "$region" \
    --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
  aws s3api put-bucket-policy --bucket "$bucket" --region "$region" --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"TlsOnly\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:*\",\"Resource\":[\"arn:aws:s3:::$bucket\",\"arn:aws:s3:::$bucket/*\"],\"Condition\":{\"Bool\":{\"aws:SecureTransport\":\"false\"}}}]}"
  # The reaper decides when archives expire; only abandoned multipart uploads are cleaned up here.
  aws s3api put-bucket-lifecycle-configuration --bucket "$bucket" --region "$region" \
    --lifecycle-configuration '{"Rules":[{"ID":"abort-incomplete-uploads","Status":"Enabled","Filter":{},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}}]}'
done
