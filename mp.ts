import { MP_ACCESS_TOKEN } from "./config.ts";

export function buildMercadoPagoResourcePath(topic: string, id: string) {
  switch (topic) {
    case "order":
      return `/v1/orders/${id}`;
    case "payment":
      return `/v1/payments/${id}`;
    case "subscription_preapproval":
      return `/preapproval/${id}`;
    case "subscription_preapproval_plan":
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

export async function fetchMpResource(resourcePath: string) {
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
