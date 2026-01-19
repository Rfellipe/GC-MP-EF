export function getMeta(metadata: any, keys: string[]) {
  for (const k of keys) {
    const v = metadata?.[k];
    if (v !== undefined && v !== null && String(v).length > 0) return v;
  }
  return null;
}

export function mapPaymentStatusToTransactionStatus(status?: string) {
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

export function mapServiceTypeToTransactionType(serviceType?: string) {
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

export function mapPaymentMethod(metadataMethod: unknown, payment: any) {
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
