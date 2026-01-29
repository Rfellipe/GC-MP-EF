// supabase/functions/mercadopago-webhook/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { verifyMercadoPagoSignature } from "./crypto.ts";
import {
  getSubscriptionByReference,
  updateSubscriptionsByReference,
  getTransactionByExternalReference,
  getTransactionById,
  insertTransaction,
  updateTransaction,
  updateSubscription,
} from "./db.ts";
import {
  getMeta,
  mapPaymentMethod,
  mapPaymentStatusToTransactionStatus,
  mapServiceTypeToTransactionType,
  mapAuthorizedPaymentStatusToSubscriptionStatus,
  mapAuthorizedPaymentStatusToTransactionStatus,
  mapMpSubscriptionStatus,
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
      const operationType = String(payment.operation_type ?? "").toLowerCase();
      const isCardValidation = operationType === "card_validation";
      const mpAmount = payment.transaction_amount;
      const mpExternalRef = payment.external_reference;

      if (!isCardValidation && Number(mpAmount ?? 0) === 0 && !mpExternalRef) {
        console.log("Ignoring zero-amount payment without reference", {
          payment_id: payment.id,
          operation_type: operationType,
        });
        return new Response("Ignored", { status: 200 });
      }

      const mpStatus = payment.status;
      const mpDescription = payment.description;
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

      const externalReferenceCandidates = [
        mpExternalRef,
        getMeta(metadata, ["externalReference", "external_reference"]),
        String(mpPaymentId),
      ].filter((value): value is string => Boolean(value));

      let existingTx = null;
      for (const candidate of externalReferenceCandidates) {
        existingTx = await getTransactionByExternalReference(candidate);
        if (existingTx) break;
      }

      const tx = existingTx
        ? await updateTransaction(existingTx.id, {
            status: txStatus,
            method: txMethod,
            amount: mpAmount,
            description,
            external_reference:
              existingTx.external_reference ?? txExternalRef ?? null,
            metadata: payment,
            updated_at: new Date().toISOString(),
          })
        : walletId
          ? await insertTransaction(transactionRow)
          : null;

      if (!tx) {
        console.warn("Payment missing walletId; unable to store transaction", {
          payment_id: mpPaymentId,
          metadata,
          is_card_validation: isCardValidation,
        });
        return new Response("Ignored", { status: 200 });
      }

      console.log("Transaction stored (payment):", tx.id);

      if (txStatus === "completed") {
        if (!productId || !targetProfileId) {
          console.error("Missing product_id/profile_id in payment metadata", {
            metadata,
            mpPaymentId,
          });
          return new Response("Missing product_id/profile_id", { status: 400 });
        }

        console.log("Payment completed with catalog metadata", {
          transaction_id: tx.id,
          product_id: productId,
          target_profile_id: targetProfileId,
        });
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
      const externalReference =
        String(
          getMeta(sub, ["external_reference", "externalReference"]) ??
            getMeta(metadata, ["external_reference", "externalReference"]) ??
            "",
        ) || null;

      const subscription = await getSubscriptionByReference({
        preapprovalId,
        externalReference,
      });
      if (!subscription) {
        console.error("Subscription not found for preapproval", {
          preapprovalId,
          externalReference,
        });
        return new Response("Subscription not found", { status: 404 });
      }

      const mappedStatus = mapMpSubscriptionStatus(sub.status);
      const mergedMetadata = {
        ...(subscription.metadata ?? {}),
        mp_preapproval: sub,
        mp_reason: sub.reason ?? null,
        mp_next_payment_date: sub.next_payment_date ?? null,
      };

      const updated = await updateSubscription(subscription.id, {
        preapproval_id: preapprovalId,
        external_reference: externalReference ?? subscription.external_reference,
        status: mappedStatus ?? subscription.status,
        metadata: mergedMetadata,
      });

      const updatedRows = await updateSubscriptionsByReference({
        preapprovalId,
        externalReference: externalReference ?? subscription.external_reference,
        updates: {
          preapproval_id: preapprovalId,
          external_reference:
            externalReference ?? subscription.external_reference,
          status: mappedStatus ?? subscription.status,
          metadata: mergedMetadata,
        },
      });

      console.log("Subscription updated (preapproval):", updated.id, {
        status: updated.status,
        preapproval_id: updated.preapproval_id,
        updated_rows: updatedRows.length,
      });

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
      const externalReference =
        String(
          getMeta(invoice, ["external_reference", "externalReference"]) ?? "",
        ) || null;
      const subscriptionRef = preapprovalId ?? externalReference ?? "unknown";

      if (!preapprovalId && !externalReference) {
        console.error(
          "Authorized payment missing preapproval/subscription id",
          { invoice },
        );
        return new Response("Missing preapproval_id", { status: 400 });
      }

      const subscription = await getSubscriptionByReference({
        preapprovalId,
        externalReference,
      });
      if (!subscription) {
        console.error(
          "No subscriptions mapping found for preapproval_id",
          subscriptionRef,
        );
        return new Response("No subscription mapping", { status: 400 });
      }

      const invStatus = String(invoice.status ?? "").toLowerCase();
      const txStatus = mapAuthorizedPaymentStatusToTransactionStatus(invStatus);

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
      const baseTransaction = subscription.transaction_id
        ? await getTransactionById(subscription.transaction_id)
        : null;
      const walletId = baseTransaction?.wallet_id ?? null;
      if (!walletId) {
        console.error(
          "Subscription mapping missing wallet_id; cannot create transaction",
          { subscriptionId: subscription.id },
        );
        return new Response("Missing wallet_id in subscription map", {
          status: 400,
        });
      }

      const transactionRow = {
        wallet_id: walletId,
        type: "payment", // recurring billing = payment
        method: "card", // best-effort; you can store invoice.payment_method_id if you want
        amount,
        status: txStatus,
        external_reference: txExternalRef,
        description: `Subscription renewal (${subscriptionRef})`,
        metadata: {
          kind: "subscription_authorized_payment",
          preapproval_id: preapprovalId,
          invoice,
          subscription_id: subscription.id,
        },
      };

      const existingTx = await getTransactionByExternalReference(txExternalRef);
      const tx = existingTx ?? (await insertTransaction(transactionRow));
      console.log("Transaction stored (authorized payment):", tx.id);

      const subscriptionStatus =
        mapAuthorizedPaymentStatusToSubscriptionStatus(invStatus);
      const mergedMetadata = {
        ...(subscription.metadata ?? {}),
        last_authorized_payment_id: invoiceId,
        last_authorized_payment_status: invStatus,
        last_authorized_payment_at:
          invoice.date_created ?? invoice.date_last_updated ?? null,
      };
      const shouldExtend =
        txStatus === "completed" && subscription.status !== "canceled";
      const currentExpiry = subscription.expires_at
        ? new Date(subscription.expires_at)
        : new Date();
      const nextExpiry = shouldExtend
        ? new Date(
            currentExpiry.setMonth(
              currentExpiry.getMonth() +
                Number(invoice?.auto_recurring?.frequency ?? 1),
            ),
          )
        : subscription.expires_at ?? null;

      await updateSubscription(subscription.id, {
        status: subscriptionStatus ?? subscription.status,
        metadata: mergedMetadata,
        transaction_id: tx.id,
        expires_at: nextExpiry ? new Date(nextExpiry).toISOString() : null,
      });

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
