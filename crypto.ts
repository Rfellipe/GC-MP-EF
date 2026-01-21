import { MP_WEBHOOK_SECRET } from "./config.ts";

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

export async function verifyMercadoPagoSignature(req: Request, dataId: string) {
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
