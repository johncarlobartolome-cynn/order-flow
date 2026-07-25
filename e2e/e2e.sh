#!/usr/bin/env bash
set -euo pipefail

STACK="OrderFlowStack"
REGION="${AWS_REGION:-ap-southeast-1}"

echo "== Reading stack outputs =="
outputs=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs" --output json)
api=$(echo "$outputs" | jq -r '.[]|select(.OutputKey=="ApiUrl")|.OutputValue')
table=$(echo "$outputs" | jq -r '.[]|select(.OutputKey=="TableName")|.OutputValue')
dlq=$(echo "$outputs" | jq -r '.[]|select(.OutputKey=="InventoryDlqUrl")|.OutputValue')
echo "api=$api"; echo "table=$table"; echo "dlq=$dlq"

# --- Happy path: one order fans out to all 3 consumers ---
echo "== Placing a normal order =="
order_id=$(curl -sS -X POST "$api/orders" -H 'content-type: application/json' \
  -d '{"items":[{"sku":"SKU-1","qty":1}],"customerEmail":"e2e@example.com"}' \
  | jq -r '.orderId')
echo "orderId=$order_id"

count=0
for i in $(seq 1 20); do
  count=$(aws dynamodb query --table-name "$table" --region "$REGION" \
    --key-condition-expression "PK = :pk" \
    --expression-attribute-values "{\":pk\":{\"S\":\"ORDER#$order_id\"}}" \
    --query "Count" --output text)
  echo "  fan-out attempt $i: $count/3 status rows"
  [ "$count" -ge 3 ] && break
  sleep 3
done
[ "$count" -ge 3 ] || { echo "FAIL: fan-out incomplete ($count/3)"; exit 1; }
echo "PASS: fan-out reached all 3 consumers"

# --- Poison path: forceFailure raises DLQ depth above baseline ---
echo "== Poison path (DLQ) =="
base=$(aws sqs get-queue-attributes --queue-url "$dlq" --region "$REGION" \
  --attribute-names ApproximateNumberOfMessages \
  --query "Attributes.ApproximateNumberOfMessages" --output text)
echo "DLQ baseline depth=$base"

curl -sS -X POST "$api/orders" -H 'content-type: application/json' \
  -d '{"items":[{"sku":"SKU-1","qty":1}],"customerEmail":"e2e@example.com","forceFailure":true}' >/dev/null
echo "placed forceFailure order; waiting for redrive (~up to 2.5 min)"

depth="$base"
for i in $(seq 1 30); do
  depth=$(aws sqs get-queue-attributes --queue-url "$dlq" --region "$REGION" \
    --attribute-names ApproximateNumberOfMessages \
    --query "Attributes.ApproximateNumberOfMessages" --output text)
  echo "  dlq attempt $i: depth=$depth (baseline $base)"
  [ "$depth" -gt "$base" ] && break
  sleep 5
done
[ "$depth" -gt "$base" ] || { echo "FAIL: poison message did not reach the DLQ"; exit 1; }
echo "PASS: poison message captured in DLQ"

echo "== E2E PASSED =="
