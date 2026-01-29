import { supabase } from "./config.ts";

// ========= subscriptions =========
export type SubscriptionRow = {
  id: string;
  profile_id: string;
  profile_type: string;
  tier: string;
  price: number;
  status: string;
  started_at: string;
  expires_at?: string | null;
  metadata?: any;
  transaction_id?: string | null;
  preapproval_id?: string | null;
  external_reference?: string | null;
};

export async function getSubscriptionByPreapprovalId(preapprovalId: string) {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("preapproval_id", preapprovalId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as SubscriptionRow | null;
}

export async function getSubscriptionByExternalReference(
  externalReference: string,
) {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("*")
    .or(`external_reference.eq.${externalReference},id.eq.${externalReference}`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as SubscriptionRow | null;
}

export async function getSubscriptionByReference(args: {
  preapprovalId?: string | null;
  externalReference?: string | null;
}) {
  if (args.preapprovalId) {
    const byPreapproval = await getSubscriptionByPreapprovalId(
      args.preapprovalId,
    );
    if (byPreapproval) return byPreapproval;
  }
  if (args.externalReference) {
    return await getSubscriptionByExternalReference(args.externalReference);
  }
  return null;
}

export async function updateSubscription(
  id: string,
  updates: Partial<SubscriptionRow>,
) {
  const { data, error } = await supabase
    .from("subscriptions")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data as SubscriptionRow;
}

export async function updateSubscriptionsByReference(args: {
  preapprovalId?: string | null;
  externalReference?: string | null;
  updates: Partial<SubscriptionRow>;
}) {
  const conditions: string[] = [];
  if (args.preapprovalId) {
    conditions.push(`preapproval_id.eq.${args.preapprovalId}`);
  }
  if (args.externalReference) {
    conditions.push(`external_reference.eq.${args.externalReference}`);
    conditions.push(`id.eq.${args.externalReference}`);
  }
  if (conditions.length === 0) return [];

  const { data, error } = await supabase
    .from("subscriptions")
    .update(args.updates)
    .or(conditions.join(","))
    .select();
  if (error) throw error;
  return data as SubscriptionRow[];
}

// ========= transactions =========
export async function getTransactionById(id: string) {
  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getTransactionByExternalReference(
  externalReference: string,
) {
  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("external_reference", externalReference)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function insertTransaction(transactionRow: any) {
  const { data: tx, error: txErr } = await supabase
    .from("transactions")
    .insert(transactionRow)
    .select()
    .single();

  if (txErr || !tx) throw txErr ?? new Error("Failed to insert transaction");
  return tx;
}

export async function updateTransaction(
  id: string,
  updates: Record<string, unknown>,
) {
  const { data, error } = await supabase
    .from("transactions")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}
