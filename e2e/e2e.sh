#!/usr/bin/env bash
set -euo pipefail

STACK="OrderFlowStack"
REGION="${AWS_REGION:-ap-southeast-1}"

echo "== Reading stack outputs =="
outputs=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs" --output json)
api=$(echo "$outputs" | jq -r '.[]|select(.OutputKey=="ApiUrl")|.OutputValue')
table=$(echo "$outputs" | jq -r '.[]|select(.OutputKey=="TableName")|.OutputValue')
echo "api=$api"; echo "table=$table"

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

# --- Poison path: forceFailure lands in DLQ, consumer writes dead-letter ---
echo "== Poison path (DLQ signal) =="
fail_id=$(curl -sS -X POST "$api/orders" -H 'content-type: application/json' \
  -d '{"items":[{"sku":"SKU-1","qty":1}],"customerEmail":"e2e@example.com","forceFailure":true}' \
  | jq -r '.orderId')
echo "forceFailure orderId=$fail_id; waiting for redrive + DLQ consumer (~up to 90s)"

inv_status=""
for i in $(seq 1 30); do
  inv_status=$(curl -sS "$api/orders/$fail_id" | jq -r '.statuses.inventory.status // "none"')
  echo "  dlq attempt $i: inventory status=$inv_status"
  [ "$inv_status" = "dead-letter" ] && break
  sleep 5
done
[ "$inv_status" = "dead-letter" ] || { echo "FAIL: no dead-letter signal for poison order"; exit 1; }
echo "PASS: poison order recorded as dead-letter via the DLQ consumer"

echo "== E2E PASSED =="
