#!/usr/bin/env bash
# Step 4 of deploy/azure-create-media-account.sh, redone through the management plane: with shared keys
# disabled, `az storage cors add` cannot authenticate (it has no --auth-mode), so CORS is set by a PUT on the
# blob service resource instead. Needed from Stage B on (browsers follow /audio's redirect to a SAS URL).
# Idempotent. Run as a person with Owner/Contributor on prod-internal-rg.
set -euo pipefail
SUB="c73c1edd-4c0c-44e0-bf14-be89e0b1b94d"; RG="prod-internal-rg"; ACCOUNT="darthmedia"
ORIGIN="https://meetings.darth-internal.trames.io"
BASE="https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Storage/storageAccounts/$ACCOUNT/blobServices/default"
az account set --subscription "$SUB"
az rest --method put --url "$BASE?api-version=2023-05-01" --body "{\"properties\":{
  \"cors\":{\"corsRules\":[{\"allowedOrigins\":[\"$ORIGIN\"],\"allowedMethods\":[\"GET\",\"HEAD\",\"OPTIONS\"],
    \"allowedHeaders\":[\"*\"],\"exposedHeaders\":[\"*\"],\"maxAgeInSeconds\":3600}]},
  \"deleteRetentionPolicy\":{\"enabled\":true,\"days\":14},
  \"containerDeleteRetentionPolicy\":{\"enabled\":true,\"days\":14}}}" \
  --query 'properties.{corsOrigins:cors.corsRules[0].allowedOrigins,blobSoftDeleteDays:deleteRetentionPolicy.days,containerSoftDeleteDays:containerDeleteRetentionPolicy.days}' -o json
echo "CORS set. (The meetings-media container was already created by the VM's identity on 2026-09-22.)"
