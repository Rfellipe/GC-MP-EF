import { supabase } from "./config.ts";

// ========= subscription mapping (DB) =========
export type MpSubscriptionMap = {
  preapproval_id: string;
  status?: string | null;
  payer_id?: string | null;
  reason?: string | null;
  external_reference?: string | null;
  product_id?: string | null;
  profile_id?: string | null;
  wallet_id?: string | null;
  metadata?: any;
  raw?: any;
  updated_at?: string;
};

export async function upsertMpSubscriptionMap(map: MpSubscriptionMap) {
  const { data, error } = await supabase
    .from("subscriptions")
    .upsert(
      {
        preapproval_id: map.preapproval_id,
        status: map.status ?? null,
        payer_id: map.payer_id ?? null,
        reason: map.reason ?? null,
        external_reference: map.external_reference ?? null,
        product_id: map.product_id ?? null,
        profile_id: map.profile_id ?? null,
        wallet_id: map.wallet_id ?? null,
        metadata: map.metadata ?? null,
        raw: map.raw ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "preapproval_id" },
    )
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function getMpSubscriptionMapByPreapprovalId(
  preapprovalId: string,
) {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("preapproval_id", preapprovalId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ========= transaction upsert =========
export async function upsertTransactionByExternalRef(transactionRow: any) {
  const { data: tx, error: txErr } = await supabase
    .from("transactions")
    .upsert(transactionRow, { onConflict: "external_reference" })
    .select()
    .single();

  if (txErr || !tx) throw txErr ?? new Error("Failed to upsert transaction");
  return tx;
}

export async function applyCatalogPurchaseOrThrow(args: {
  transaction_id: string;
  product_id: string;
  target_profile_id: string;
  metadata: any;
}) {
  const { data, error } = await supabase.rpc("apply_catalog_purchase", {
    p_transaction_id: args.transaction_id,
    p_product_id: args.product_id,
    p_target_profile_id: args.target_profile_id,
    p_metadata: args.metadata ?? {},
  });

  if (error) throw error;
  return data;
}
