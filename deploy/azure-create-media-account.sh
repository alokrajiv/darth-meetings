#!/usr/bin/env bash
# Provision the PERMANENT media account for Darth Meetings (docs/recordings-blob-spec.md, Stage A;
# runbook docs/rollout-recordings-2026-09.md §D). Run once, as a person with Owner on prod-internal-rg.
#
#   ./deploy/azure-create-media-account.sh
#
# Separate from `darthuploads` on purpose: that account's lifecycle rule `expire-uploads` deletes every
# blob a day after its last write (no prefix filter). This account gets NO lifecycle rule; the app's
# canary (Stage A.4) stops archiving if one ever appears.
set -euo pipefail

SUB="c73c1edd-4c0c-44e0-bf14-be89e0b1b94d"          # Trames Pte Ltd (WT)
RG="prod-internal-rg"
ACCOUNT="darthmedia"
LOCATION="southeastasia"                              # same region as the VM and darthuploads
VM_IDENTITY="6b68b6e9-2d98-490a-8a16-6eeff4293ee5"   # darth-p01 system-assigned identity (already Contributor on darthuploads)
ORIGIN="https://meetings.darth-internal.trames.io"

az account set --subscription "$SUB"

echo "==> 1/5 storage account $ACCOUNT (LRS, no shared keys, no public blobs, TLS 1.2, https only)"
az storage account create -n "$ACCOUNT" -g "$RG" -l "$LOCATION" \
  --sku Standard_LRS --kind StorageV2 --access-tier Hot \
  --allow-shared-key-access false --allow-blob-public-access false \
  --min-tls-version TLS1_2 --https-only true \
  --query '{name:name,state:provisioningState}' -o json

echo "==> 2/5 blob + container soft delete, 14 days"
az storage account blob-service-properties update --account-name "$ACCOUNT" -g "$RG" \
  --enable-delete-retention true --delete-retention-days 14 \
  --enable-container-delete-retention true --container-delete-retention-days 14 \
  --query '{blobDays:deleteRetentionPolicy.days,containerDays:containerDeleteRetentionPolicy.days}' -o json

echo "==> 3/5 VM identity gets Storage Blob Data Contributor"
az role assignment create --assignee-object-id "$VM_IDENTITY" --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Contributor" \
  --scope "/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Storage/storageAccounts/$ACCOUNT" \
  --query '{role:roleDefinitionName,principal:principalId}' -o json

echo "==> 4/5 CORS: NOT here — \`az storage cors add\` cannot authenticate against an account with shared keys off."
echo "    Run ./deploy/azure-media-account-cors.sh afterwards (management-plane PUT). Needed from Stage B on."

echo "==> 5/5 checks"
echo "lifecycle policy (must be 'not found'):"
az storage account management-policy show --account-name "$ACCOUNT" -g "$RG" -o json 2>&1 | tail -1 || true
az storage account show -n "$ACCOUNT" -g "$RG" \
  --query '{keys:allowSharedKeyAccess,publicBlobs:allowBlobPublicAccess,tls:minimumTlsVersion}' -o json

cat <<MSG

Done. The container 'meetings-media' is created by the VM (its identity now has the role) — next step on the VM:
  az storage container create --account-name $ACCOUNT -n meetings-media --auth-mode login   # or let Claude do it
then in ~/apps/meeting-whisperer/.env.local:
  DARTH_MEDIA_ACCOUNT=$ACCOUNT
  DARTH_MEDIA_CONTAINER=meetings-media
  MW_MEDIA_ARCHIVE=1
and pm2 restart meeting-whisperer (check pgrep -f 'claude-agent-sd[k]' first).
MSG
