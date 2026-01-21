// supabase/functions/mercadopago-webhook/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { verifyMercadoPagoSignature } from "./crypto.ts";
import {
  applyCatalogPurchaseOrThrow,
  getMpSubscriptionMapByPreapprovalId,
  upsertMpSubscriptionMap,
  upsertTransactionByExternalRef,
} from "./db.ts";
import {
  getMeta,
  mapPaymentMethod,
  mapPaymentStatusToTransactionStatus,
  mapServiceTypeToTransactionType,
} from "./mapping.ts";
import { buildMercadoPagoResourcePath, fetchMpResource } from "./mp.ts";

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
    // 2) subscription_preapproval (subscription lifecycle)
    //    Store mapping so renewals know what to apply.
    // =========================================================
    if (topic === "subscription_preapproval") {
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
          "No subscriptions mapping found for preapproval_id",
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
