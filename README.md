# Mercado Pago Webhook (Supabase Edge Function)

This repository contains a Supabase Edge Function (Deno) that processes Mercado Pago webhooks and keeps transactions/subscriptions in sync with your Supabase database. It validates webhook signatures, fetches authoritative Mercado Pago resources, and applies catalog purchases when payments complete.

## What it does

- **Validates Mercado Pago webhooks** using the `x-signature`/`x-request-id` headers and a shared secret.
- **Fetches the official Mercado Pago resource** for each webhook event.
- **Upserts transactions** by external reference to ensure idempotency.
- **Applies catalog purchases** via the `apply_catalog_purchase` RPC when payments are completed.
- **Tracks subscription mappings** for recurring billing workflows.

Supported topics:

- `payment`
- `subscription_prepapproval`
- `subscription_authorized_payment`

## Environment variables

Configure these in the Supabase Edge Function environment:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MERCADO_PAGO_ACCESS_TOKEN`
- `MERCADO_PAGO_WEBHOOK_SECRET`

## Database expectations

The function expects these tables/functions:

- `subscriptions` table with a unique `preapproval_id` and columns for `status`, `payer_id`, `reason`, `external_reference`, `product_id`, `profile_id`, `wallet_id`, `metadata`, `raw`, `updated_at`.
- `transactions` table with a unique `external_reference`.
- `apply_catalog_purchase` RPC with parameters:
  - `p_transaction_id`
  - `p_product_id`
  - `p_target_profile_id`
  - `p_metadata`

## Metadata expectations

The webhook handler reads metadata to associate purchases with users and products:

- `wallet_id` (required for payments)
- `product_id` / `productId`
- `profile_id` / `profileId`
- `serviceType` / `service_type`
- `method` / `payment_method`
- `serviceName` / `service_name`
- `externalReference` / `external_reference`

For subscriptions, metadata is stored on the preapproval record and reused for authorized payments.

## Local development

This function is written for Supabase Edge Functions (Deno). To run it locally, use the Supabase CLI:

```bash
supabase functions serve mercadopago-webhook
```

Then configure Mercado Pago to send webhooks to the served endpoint.

## Notes

- Webhook signature verification requires `MERCADO_PAGO_WEBHOOK_SECRET`.
- The function is idempotent via upserts keyed on external references.
