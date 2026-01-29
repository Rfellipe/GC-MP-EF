// supabase/functions/apply-pending-downgrades/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { CRON_SECRET, supabase } from "./config.ts";

serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (CRON_SECRET) {
      const headerSecret = req.headers.get("x-cron-secret") ?? "";
      if (headerSecret !== CRON_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const nowIso = new Date().toISOString();
    const { data: subscriptions, error } = await supabase
      .from("subscriptions")
      .select("*")
      .not("metadata->pending_plan", "is", null)
      .lte("metadata->pending_plan->>start_at", nowIso);

    if (error) throw error;

    let updated = 0;
    for (const subscription of subscriptions ?? []) {
      const pendingPlan = subscription.metadata?.pending_plan;
      if (!pendingPlan) continue;

      const { pending_plan, ...restMetadata } = subscription.metadata ?? {};
      const nextPrice =
        pendingPlan.price !== undefined && pendingPlan.price !== null
          ? Number(pendingPlan.price)
          : subscription.price;

      const updates = {
        tier: pendingPlan.tier ?? subscription.tier,
        price: Number.isNaN(nextPrice) ? subscription.price : nextPrice,
        started_at: pendingPlan.start_at ?? subscription.started_at,
        expires_at: pendingPlan.end_at ?? subscription.expires_at,
        metadata: restMetadata,
      };

      const { error: updateError } = await supabase
        .from("subscriptions")
        .update(updates)
        .eq("id", subscription.id);

      if (updateError) throw updateError;
      updated += 1;
    }

    return Response.json({
      ok: true,
      scanned: subscriptions?.length ?? 0,
      updated,
      now: nowIso,
    });
  } catch (err) {
    console.error("Pending plan cron error:", err);
    return new Response("Internal Error", { status: 500 });
  }
});
