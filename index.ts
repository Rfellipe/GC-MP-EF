// supabase/functions/mercadopago-webhook/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Env vars (configure no painel do Supabase)
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MP_ACCESS_TOKEN = Deno.env.get("MERCADO_PAGO_ACCESS_TOKEN")!;
const MP_WEBHOOK_SECRET = Deno.env.get("MERCADO_PAGO_WEBHOOK_SECRET") || "";

// Supabase client com service role (ignora RLS)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ===== Helpers de criptografia / comparação =====

// HMAC-SHA256 em Web Crypto (Deno)
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

// Comparação “timing-safe”
function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Valida x-signature conforme doc do Mercado Pago
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

  // Exemplo: ts=1704208880,v1=...
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

  // Template conforme doc:
  // id:[data.id.url];request-id:[x-request-id.header];ts:[ts.header];
  const template = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
  const computed = await createHmacSha256Hex(template, MP_WEBHOOK_SECRET);

  // (Timestamp tolerance removido, como você pediu)
  const valid = timingSafeEqual(computed, v1);
  if (!valid) {
    console.error("Signature mismatch", { computed, v1 });
  }
  return valid;
}

// ===== Escolhe o endpoint correto baseado no tipo / tópico =====
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

  // fallback: olhar o payment_type_id do MP
  const paymentTypeId = String(payment?.payment_type_id || "").toLowerCase();
  if (paymentTypeId === "pix") return "pix";
  if (paymentTypeId === "credit_card") return "card";
  if (paymentTypeId === "account_money") return "wallet";
  if (paymentTypeId === "crypto") return "crypto";
  return "card";
}

function getMeta(metadata: any, keys: string[]) {
  for (const k of keys) {
    const v = metadata?.[k];
    if (v !== undefined && v !== null && String(v).length > 0) return v;
  }
  return null;
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const url = new URL(req.url);

  // Mercado Pago manda type/topic e data.id como query params
  const topic = url.searchParams.get("type") ?? url.searchParams.get("topic");
  const dataId = url.searchParams.get("data.id") ?? url.searchParams.get("id");

  if (!topic || !dataId) {
    console.error("Missing topic/type or data.id in URL", url.search);
    return new Response("Bad Request", { status: 400 });
  }

  // Valida a assinatura ANTES de processar qualquer coisa
  const isValid = await verifyMercadoPagoSignature(req, dataId);
  if (!isValid) {
    return new Response("Invalid signature", { status: 401 });
  }

  // Tenta ler o body (só para log)
  let payload: any = null;
  try {
    payload = await req.json();
  } catch {
    // ok
  }

  console.log("Valid MP webhook received", { topic, dataId, payload });

  // Escolhe o endpoint correto baseado no tipo
  const resourcePath = buildMercadoPagoResourcePath(topic, dataId);
  if (!resourcePath) {
    console.log("Unknown or unsupported topic, ignoring", topic);
    return new Response("Ignored", { status: 200 });
  }

  const mpRes = await fetch(`https://api.mercadopago.com${resourcePath}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  if (!mpRes.ok) {
    console.error("Failed to fetch resource from Mercado Pago", {
      topic,
      resourcePath,
      status: mpRes.status,
      text: await mpRes.text().catch(() => ""),
    });
    return new Response("Failed to fetch resource", { status: 500 });
  }

  const resource = await mpRes.json();

  // Se for payment, criamos transação e (se approved) aplicamos a compra via RPC
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

    // ✅ novos: product_id e profile_id (target)
    const productId = getMeta(metadata, ["product_id", "productId"]) as
      | string
      | null;
    const targetProfileId = getMeta(metadata, ["profile_id", "profileId"]) as
      | string
      | null;

    if (!walletId) {
      console.error("Payment metadata missing walletId", { metadata, payment });
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

    // ----------------------------------------------------------
    // 1) UPSERT de transaction por external_reference (evita duplicar)
    // ----------------------------------------------------------
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

    // ⚠️ Isso assume que você tem UNIQUE em transactions.external_reference.
    // Se não tiver, recomendo fortemente adicionar.
    const { data: tx, error: txErr } = await supabase
      .from("transactions")
      .upsert(transactionRow, { onConflict: "external_reference" })
      .select()
      .single();

    if (txErr || !tx) {
      console.error("Failed to upsert transaction:", txErr);
      return new Response("DB upsert error", { status: 500 });
    }

    console.log("Transaction upserted:", tx);

    // ----------------------------------------------------------
    // 2) Se approved/completed: aplicar compra do catálogo via RPC
    // ----------------------------------------------------------
    if (txStatus === "completed") {
      // Para depósitos (wallet topup) você pode optar por aplicar via produto credits-*
      // ou manter como "deposit". Aqui focamos no catálogo (product_id obrigatório).
      if (!productId || !targetProfileId) {
        console.error(
          "Missing product_id or profile_id in metadata for completed payment",
          {
            metadata,
            payment_id: mpPaymentId,
          },
        );
        // retorna 400 porque não dá pra aplicar compra sem saber qual item e pra quem
        return new Response("Missing product_id/profile_id", { status: 400 });
      }

      const { data: applyRes, error: applyErr } = await supabase.rpc(
        "apply_catalog_purchase",
        {
          p_transaction_id: tx.id,
          p_product_id: productId,
          p_target_profile_id: targetProfileId,
          p_metadata: metadata,
        },
      );

      if (applyErr) {
        console.error("Failed to apply catalog purchase", {
          applyErr,
          tx_id: tx.id,
          productId,
        });
        // 500 => MP tenta novamente; função é idempotente então não duplica efeitos
        return new Response("Failed to apply purchase", { status: 500 });
      }

      console.log("Purchase applied successfully", applyRes);
    }
  } else {
    // Outros tópicos: só loga por enquanto
    console.log("Non-payment resource from Mercado Pago", { topic, resource });
  }

  return new Response("OK", { status: 200 });
});
