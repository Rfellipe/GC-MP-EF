// supabase/functions/mercadopago-webhook/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Env vars (configure in Supabase dashboard)
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MP_ACCESS_TOKEN = Deno.env.get("MERCADO_PAGO_ACCESS_TOKEN")!;
const MP_WEBHOOK_SECRET = Deno.env.get("MERCADO_PAGO_WEBHOOK_SECRET") || "";

// Supabase client with service role (bypasses RLS)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ========= crypto helpers =========
async function createHmacSha256Hex(message: string, secret: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  const bytes = new Uint8Array(signature);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyMercadoPagoSignature(req: Request, dataId: string) {
  if (!MP_WEBHOOK_SECRET) {
    console.error("MERCADO_PAGO_WEBHOOK_SECRET is not configured");
    return false;
  }

  const xSignature = req.headers.get("x-signature");
  const xRequestId = req.headers.get("x-request-id");
  if (!xSignature || !xRequestId) {
    console.error("Missing x-signature or x-request-id header");
    return false;
  }

  const parts = xSignature.split(",");
  const sigMap: Record<string, string> = {};
  for (const part of parts) {
    const [k, v] = part.split("=");
    if (k && v) sigMap[k.trim()] = v.trim();
  }

  const ts = sigMap["ts"];
  const v1 = sigMap["v1"];
  if (!ts || !v1) {
    console.error("Invalid x-signature format", xSignature);
    return false;
  }

  // Template per MP docs:
  // id:[data.id.url];request-id:[x-request-id.header];ts:[ts.header];
  const template = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
  const computed = await createHmacSha256Hex(template, MP_WEBHOOK_SECRET);

  // (timestamp tolerance intentionally removed as requested)
  const valid = timingSafeEqual(computed, v1);
  if (!valid) console.error("Signature mismatch", { computed, v1 });
  return valid;
}

// ========= MP resource path =========
function buildMercadoPagoResourcePath(topic: string, id: string) {
  switch (topic) {
    case "order":
      return `/v1/orders/${id}`;
    case "payment":
      return `/v1/payments/${id}`;
    case "subscription_prepapproval":
      return `/preapproval/${id}`;
    case "subscription_prepapproval_plan":
      return `/preapproval_plan/search?preapproval_plan_id=${encodeURIComponent(id)}`;
    case "subscription_authorized_payment":
      return `/authorized_payments/${id}`;
    case "topic_claims_integration_wh":
      return `/post-purchase/v1/claims/${id}`;
    case "topic_merchant_order_wh":
      return `/merchant_orders/${id}`;
    case "topic_chargebacks_wh":
      return `/v1/chargebacks/${id}`;
    default:
      return null;
  }
}

// ========= mapping helpers =========
function getMeta(metadata: any, keys: string[]) {
  for (const k of keys) {
    const v = metadata?.[k];
    if (v !== undefined && v !== null && String(v).length > 0) return v;
  }
  return null;
}

function mapPaymentStatusToTransactionStatus(status?: string) {
  switch (status) {
    case "approved":
      return "completed";
    case "in_process":
    case "pending":
      return "pending";
    case "rejected":
      return "failed";
    case "refunded":
    case "charged_back":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "pending";
  }
}

function mapServiceTypeToTransactionType(serviceType?: string) {
  if (!serviceType) return "payment";
  switch (serviceType) {
    case "funds":
    case "wallet_topup":
    case "wallet-deposit":
      return "deposit";
    case "withdrawal":
      return "withdrawal";
    case "refund":
      return "refund";
    default:
      return "payment";
  }
}

function mapPaymentMethod(metadataMethod: unknown, payment: any) {
  const method = String(metadataMethod || "").toLowerCase();
  if (method === "pix") return "pix";
  if (method === "wallet") return "wallet";
  if (method === "card" || method === "credit-card" || method === "credit_card")
    return "card";
  if (method === "crypto") return "crypto";
  if (method === "giftcard") return "giftcard";

  const paymentTypeId = String(payment?.payment_type_id || "").toLowerCase();
  if (paymentTypeId === "pix") return "pix";
  if (paymentTypeId === "credit_card") return "card";
  if (paymentTypeId === "account_money") return "wallet";
  if (paymentTypeId === "crypto") return "crypto";
  return "card";
}

async function fetchMpResource(resourcePath: string) {
  const mpRes = await fetch(`https://api.mercadopago.com${resourcePath}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  if (!mpRes.ok) {
    const text = await mpRes.text().catch(() => "");
    throw new Error(`MP fetch failed: ${mpRes.status} ${text}`);
  }

  return await mpRes.json();
}

// ========= subscription mapping (DB) =========
type MpSubscriptionMap = {
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

async function upsertMpSubscriptionMap(map: MpSubscriptionMap) {
  const { data, error } = await supabase
    .from("mp_subscriptions")
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

async function getMpSubscriptionMapByPreapprovalId(preapprovalId: string) {
  const { data, error } = await supabase
    .from("mp_subscriptions")
    .select("*")
    .eq("preapproval_id", preapprovalId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ========= transaction upsert =========
async function upsertTransactionByExternalRef(transactionRow: any) {
  const { data: tx, error: txErr } = await supabase
    .from("transactions")
    .upsert(transactionRow, { onConflict: "external_reference" })
    .select()
    .single();

  if (txErr || !tx) throw txErr ?? new Error("Failed to upsert transaction");
  return tx;
}

async function applyCatalogPurchaseOrThrow(args: {
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

// ========= webhook =========
serve(async (req) => {
  try {
    if (req.method !== "POST")
      return new Response("Method Not Allowed", { status: 405 });

    const url = new URL(req.url);
    const topic = url.searchParams.get("type") ?? url.searchParams.get("topic");
    const dataId =
      url.searchParams.get("data.id") ?? url.searchParams.get("id");

    if (!topic || !dataId) {
      console.error("Missing topic/type or data.id in URL", url.search);
      return new Response("Bad Request", { status: 400 });
    }

    const isValid = await verifyMercadoPagoSignature(req, dataId);
    if (!isValid) return new Response("Invalid signature", { status: 401 });

    let payload: any = null;
    try {
      payload = await req.json();
    } catch {
      // ok
    }

    console.log("Valid MP webhook received", { topic, dataId, payload });

    const resourcePath = buildMercadoPagoResourcePath(topic, dataId);
    if (!resourcePath) {
      console.log("Unsupported topic, ignoring:", topic);
      return new Response("Ignored", { status: 200 });
    }

    const resource = await fetchMpResource(resourcePath);

    // =========================================================
    // 1) payment topic (one-time purchases + sometimes recurring)
    // =========================================================
    if (topic === "payment") {
      const payment = resource;

      const mpStatus = payment.status;
      const mpDescription = payment.description;
      const mpAmount = payment.transaction_amount;
      const mpExternalRef = payment.external_reference;
      const mpPaymentId = payment.id;

      const metadata = payment.metadata || {};
      const serviceType = getMeta(metadata, ["serviceType", "service_type"]) as
        | string
        | null;
      const walletId = getMeta(metadata, ["wallet_id", "walletId"]) as
        | string
        | null;
      const metadataMethod = getMeta(metadata, ["method", "payment_method"]);

      const productId = getMeta(metadata, ["product_id", "productId"]) as
        | string
        | null;
      const targetProfileId = getMeta(metadata, ["profile_id", "profileId"]) as
        | string
        | null;

      if (!walletId) {
        console.error("Payment metadata missing walletId", {
          metadata,
          payment_id: mpPaymentId,
        });
        return new Response("No walletId in metadata", { status: 400 });
      }

      const txStatus = mapPaymentStatusToTransactionStatus(mpStatus);
      const txType = mapServiceTypeToTransactionType(serviceType ?? undefined);
      const txMethod = mapPaymentMethod(metadataMethod, payment);

      const description =
        mpDescription ??
        getMeta(metadata, ["serviceName", "service_name"]) ??
        "Payment via Mercado Pago";

      const txExternalRef =
        mpExternalRef ??
        getMeta(metadata, ["externalReference", "external_reference"]) ??
        String(mpPaymentId);

      const transactionRow = {
        wallet_id: walletId,
        type: txType,
        method: txMethod,
        amount: mpAmount,
        status: txStatus,
        external_reference: txExternalRef,
        description,
        metadata: payment,
      };

      const tx = await upsertTransactionByExternalRef(transactionRow);
      console.log("Transaction upserted (payment):", tx.id);

      if (txStatus === "completed") {
        if (!productId || !targetProfileId) {
          console.error("Missing product_id/profile_id in payment metadata", {
            metadata,
            mpPaymentId,
          });
          return new Response("Missing product_id/profile_id", { status: 400 });
        }

        const applied = await applyCatalogPurchaseOrThrow({
          transaction_id: tx.id,
          product_id: productId,
          target_profile_id: targetProfileId,
          metadata,
        });

        console.log("Purchase applied (payment):", applied);
      }

      return new Response("OK", { status: 200 });
    }

    // =========================================================
    // 2) subscription_prepapproval (subscription lifecycle)
    //    Store mapping so renewals know what to apply.
    // =========================================================
    if (topic === "subscription_prepapproval") {
      const sub = resource;
      const metadata = sub.metadata || sub?.auto_recurring?.metadata || {};

      const preapprovalId = String(sub.id ?? dataId);

      const productId =
        getMeta(metadata, ["product_id", "productId"]) ??
        getMeta(sub, ["external_reference"]); // fallback only

      const profileId = getMeta(metadata, ["profile_id", "profileId"]) as
        | string
        | null;
      const walletId = getMeta(metadata, ["wallet_id", "walletId"]) as
        | string
        | null;

      // In subscriptions, it’s common to have payer_id somewhere; keep it if present
      const payerId = String(sub?.payer_id ?? sub?.payer?.id ?? "") || null;

      const map = await upsertMpSubscriptionMap({
        preapproval_id: preapprovalId,
        status: String(sub.status ?? "") || null,
        payer_id: payerId,
        reason: String(sub.reason ?? "") || null,
        external_reference: String(sub.external_reference ?? "") || null,
        product_id: productId ? String(productId) : null,
        profile_id: profileId ? String(profileId) : null,
        wallet_id: walletId ? String(walletId) : null,
        metadata,
        raw: sub,
      });

      console.log("Subscription map upserted:", map.preapproval_id, map.status);

      return new Response("OK", { status: 200 });
    }

    // =========================================================
    // 3) subscription_authorized_payment (recurring invoice/charge)
    //    Create a transaction and apply_catalog_purchase using map.
    // =========================================================
    if (topic === "subscription_authorized_payment") {
      const invoice = resource;

      // We need subscription/preapproval id to find mapping
      const preapprovalId =
        String(
          invoice.preapproval_id ??
            invoice.subscription_id ??
            invoice.preapproval?.id ??
            "",
        ) || null;

      if (!preapprovalId) {
        console.error(
          "Authorized payment missing preapproval/subscription id",
          { invoice },
        );
        return new Response("Missing preapproval_id", { status: 400 });
      }

      const map = await getMpSubscriptionMapByPreapprovalId(preapprovalId);
      if (!map) {
        console.error(
          "No mp_subscriptions mapping found for preapproval_id",
          preapprovalId,
        );
        return new Response("No subscription mapping", { status: 400 });
      }

      // Decide tx status: treat "approved/paid" as completed; everything else pending
      const invStatus = String(invoice.status ?? "").toLowerCase();
      const completedStatuses = new Set(["approved", "paid", "success"]);
      const txStatus = completedStatuses.has(invStatus)
        ? "completed"
        : "pending";

      // Amount/currency: best-effort fields
      const amount = Number(
        invoice.transaction_amount ??
          invoice.amount ??
          invoice.total_amount ??
          0,
      );

      // Use invoice id as external_reference uniqueness
      const invoiceId = String(invoice.id ?? dataId);
      const txExternalRef = `mp_authorized_payment_${invoiceId}`;

      // Wallet id must come from mapping (recommended) or invoice metadata
      const walletId = map.wallet_id ?? null;
      if (!walletId) {
        console.error(
          "Subscription mapping missing wallet_id; cannot create transaction",
          { map },
        );
        return new Response("Missing wallet_id in subscription map", {
          status: 400,
        });
      }

      const productId = map.product_id ?? null;
      const targetProfileId = map.profile_id ?? null;
      if (!productId || !targetProfileId) {
        console.error("Subscription mapping missing product_id/profile_id", {
          map,
        });
        return new Response(
          "Missing product_id/profile_id in subscription map",
          { status: 400 },
        );
      }

      const transactionRow = {
        wallet_id: walletId,
        type: "payment", // recurring billing = payment
        method: "card", // best-effort; you can store invoice.payment_method_id if you want
        amount,
        status: txStatus,
        external_reference: txExternalRef,
        description: `Subscription renewal (${preapprovalId})`,
        metadata: {
          kind: "subscription_authorized_payment",
          preapproval_id: preapprovalId,
          invoice,
          map,
        },
      };

      const tx = await upsertTransactionByExternalRef(transactionRow);
      console.log("Transaction upserted (authorized payment):", tx.id);

      if (txStatus === "completed") {
        // Merge metadata from map with invoice info
        const mergedMetadata = {
          ...(map.metadata ?? {}),
          preapproval_id: preapprovalId,
          authorized_payment_id: invoiceId,
          invoice_status: invStatus,
        };

        const applied = await applyCatalogPurchaseOrThrow({
          transaction_id: tx.id,
          product_id: productId,
          target_profile_id: targetProfileId,
          metadata: mergedMetadata,
        });

        console.log("Purchase applied (authorized payment):", applied);
      }

      return new Response("OK", { status: 200 });
    }

    // Other topics: log
    console.log("Non-handled topic (logged):", topic, resource);
    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("Webhook handler error:", err);
    // returning 500 makes MP retry; we are idempotent (transactions + apply function)
    return new Response("Internal Error", { status: 500 });
  }
});
