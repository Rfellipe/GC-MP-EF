-- ============================================================
-- A) Idempotência: uma transaction só pode aplicar 1x
-- ============================================================
create table if not exists public.transaction_applications (
  transaction_id uuid primary key references public.transactions(id) on delete cascade,
  applied_at timestamptz not null default now(),
  product_id text not null,
  result jsonb not null default '{}'::jsonb
);

-- ============================================================
-- B) Premium Features: ledger para recursos premium do cliente
--    (se você já tiver algo parecido, me fala o nome e eu adapto)
-- ============================================================
do $$ begin
  if not exists (select 1 from pg_type where typname = 'client_feature_status') then
    create type public.client_feature_status as enum ('active','expired','cancelled');
  end if;
end $$;

create table if not exists public.client_premium_entitlements (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  feature_id text not null,               -- ex: 'see-online'
  billing_model text not null,            -- 'monthly' | 'per_use'
  status public.client_feature_status not null default 'active',
  started_at timestamptz not null default now(),
  expires_at timestamptz null,            -- p/ monthly
  remaining_uses int null,                -- p/ per_use
  metadata jsonb not null default '{}'::jsonb,
  transaction_id uuid unique null references public.transactions(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_client_premium_entitlements_client
  on public.client_premium_entitlements(client_id);

create index if not exists idx_client_premium_entitlements_feature
  on public.client_premium_entitlements(feature_id);

-- ============================================================
-- C) Helpers de catálogo (IDs do seu catalog.ts)
-- ============================================================

-- C1) créditos (wallet.balance = créditos ✅)
create or replace function public.catalog_wallet_credits(product_id text)
returns table(base_credits numeric, bonus_credits numeric)
language sql
stable
as $$
  select
    case product_id
      when 'credits-small'  then 500
      when 'credits-medium' then 1200
      when 'credits-large'  then 2500
      else null
    end::numeric,
    case product_id
      when 'credits-small'  then 50
      when 'credits-medium' then 150
      when 'credits-large'  then 400
      else null
    end::numeric
$$;

-- C2) visibility products
create or replace function public.catalog_visibility_product(product_id text)
returns table(kind text, default_duration interval)
language sql
stable
as $$
  select
    case product_id
      when 'boost-city'        then 'boost'
      when 'highlight-premium' then 'highlight'
      when 'auto-boost'        then 'auto_boost'
      else null
    end,
    case product_id
      when 'boost-city'        then null::interval
      when 'highlight-premium' then interval '30 days'   -- ✅ confirmado
      when 'auto-boost'        then interval '1 month'
      else null
    end
$$;

-- C3) client premium features
create or replace function public.catalog_client_premium_feature(product_id text)
returns table(feature_id text, billing_model text, duration interval, uses int)
language sql
stable
as $$
  select
    case product_id
      when 'see-online'       then 'see-online'
      when 'advanced-filters' then 'advanced-filters'
      when 'chat-priority'    then 'chat-priority'
      when 'chat-history'     then 'chat-history'
      else null
    end as feature_id,
    case product_id
      when 'chat-priority' then 'per_use'
      when 'see-online'    then 'monthly'
      when 'advanced-filters' then 'monthly'
      when 'chat-history'  then 'monthly'
      else null
    end as billing_model,
    case product_id
      when 'chat-priority' then null::interval
      when 'see-online'    then interval '1 month'
      when 'advanced-filters' then interval '1 month'
      when 'chat-history'  then interval '1 month'
      else null
    end as duration,
    case product_id
      when 'chat-priority' then 1
      else null
    end as uses
$$;

-- ============================================================
-- D) Função principal: aplica purchase (CRÉDITOS / BOOSTS / FEATURES)
-- ============================================================
create or replace function public.apply_catalog_purchase_v2(
  p_transaction_id uuid,
  p_product_id text,
  p_target_profile_id uuid,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tx public.transactions%rowtype;
  v_wallet public.wallets%rowtype;

  v_applied_exists boolean;

  -- credits
  v_base_credits numeric;
  v_bonus_credits numeric;
  v_total_credits numeric;

  -- boost
  v_vis_kind text;
  v_vis_default_duration interval;
  v_vis_minutes int;
  v_vis_expires_at timestamptz;
  v_boost_id uuid;

  -- premium feature
  v_feat_id text;
  v_feat_billing text;
  v_feat_duration interval;
  v_feat_uses int;
  v_feat_expires_at timestamptz;
  v_entitlement_id uuid;
begin
  -- tx exists + completed
  select * into v_tx
  from public.transactions
  where id = p_transaction_id;

  if not found then
    raise exception 'transaction % not found', p_transaction_id;
  end if;

  if v_tx.status is distinct from 'completed'::public.transaction_status then
    raise exception 'transaction % must be completed (current=%)', p_transaction_id, v_tx.status;
  end if;

  -- idempotency
  select exists(
    select 1 from public.transaction_applications where transaction_id = p_transaction_id
  ) into v_applied_exists;

  if v_applied_exists then
    return jsonb_build_object(
      'ok', true,
      'already_applied', true,
      'transaction_id', p_transaction_id,
      'product_id', p_product_id
    );
  end if;

  -- wallet of target profile
  select * into v_wallet
  from public.wallets
  where profile_id = p_target_profile_id;

  if not found then
    raise exception 'wallet for profile % not found', p_target_profile_id;
  end if;

  -- =========================
  -- 1) Wallet credits
  -- =========================
  select base_credits, bonus_credits
  into v_base_credits, v_bonus_credits
  from public.catalog_wallet_credits(p_product_id);

  if v_base_credits is not null then
    v_total_credits := coalesce(v_base_credits,0) + coalesce(v_bonus_credits,0);

    update public.wallets
    set balance = balance + v_total_credits,
        updated_at = now()
    where id = v_wallet.id;

    insert into public.transaction_applications(transaction_id, product_id, result)
    values (
      p_transaction_id,
      p_product_id,
      jsonb_build_object(
        'kind','wallet_credits',
        'base_credits', v_base_credits,
        'bonus_credits', v_bonus_credits,
        'total_credits', v_total_credits
      )
    );

    return jsonb_build_object(
      'ok', true,
      'kind','wallet_credits',
      'credited', v_total_credits,
      'transaction_id', p_transaction_id
    );
  end if;

  -- =========================
  -- 2) Boost / Highlight / Auto-boost
  -- =========================
  select kind, default_duration
  into v_vis_kind, v_vis_default_duration
  from public.catalog_visibility_product(p_product_id);

  if v_vis_kind is not null then
    if p_product_id = 'boost-city' then
      v_vis_minutes := nullif((p_metadata->>'minutes')::int, 0);
      if v_vis_minutes is null then
        raise exception 'boost-city requires metadata.minutes (e.g. {"minutes":60})';
      end if;
      v_vis_expires_at := now() + make_interval(mins => v_vis_minutes);
    else
      v_vis_expires_at := now() + coalesce(v_vis_default_duration, interval '30 days');
    end if;

    insert into public.escort_boosts(
      escort_id,
      boost_name,
      package_label,
      expires_at,
      next_activation_at,
      auto_renew
    )
    values (
      p_target_profile_id,
      p_product_id,
      coalesce(p_metadata->>'label', v_vis_kind),
      v_vis_expires_at,
      now(),
      case when p_product_id = 'auto-boost' then true else false end
    )
    returning id into v_boost_id;

    insert into public.transaction_applications(transaction_id, product_id, result)
    values (
      p_transaction_id,
      p_product_id,
      jsonb_build_object(
        'kind','visibility',
        'escort_boost_id', v_boost_id,
        'product', p_product_id,
        'expires_at', v_vis_expires_at
      )
    );

    return jsonb_build_object(
      'ok', true,
      'kind','visibility',
      'escort_boost_id', v_boost_id,
      'product', p_product_id,
      'expires_at', v_vis_expires_at
    );
  end if;

  -- =========================
  -- 3) Client premium features
  -- =========================
  select feature_id, billing_model, duration, uses
  into v_feat_id, v_feat_billing, v_feat_duration, v_feat_uses
  from public.catalog_client_premium_feature(p_product_id);

  if v_feat_id is not null then
    if v_feat_billing = 'monthly' then
      v_feat_expires_at := now() + v_feat_duration;

      insert into public.client_premium_entitlements(
        client_id, feature_id, billing_model, status, started_at, expires_at, remaining_uses, metadata, transaction_id
      )
      values (
        p_target_profile_id,
        v_feat_id,
        v_feat_billing,
        'active'::public.client_feature_status,
        now(),
        v_feat_expires_at,
        null,
        coalesce(p_metadata,'{}'::jsonb),
        p_transaction_id
      )
      returning id into v_entitlement_id;
    else
      insert into public.client_premium_entitlements(
        client_id, feature_id, billing_model, status, started_at, expires_at, remaining_uses, metadata, transaction_id
      )
      values (
        p_target_profile_id,
        v_feat_id,
        v_feat_billing,
        'active'::public.client_feature_status,
        now(),
        null,
        coalesce(v_feat_uses,1),
        coalesce(p_metadata,'{}'::jsonb),
        p_transaction_id
      )
      returning id into v_entitlement_id;
    end if;

    insert into public.transaction_applications(transaction_id, product_id, result)
    values (
      p_transaction_id,
      p_product_id,
      jsonb_build_object(
        'kind','client_premium_feature',
        'entitlement_id', v_entitlement_id,
        'feature_id', v_feat_id,
        'billing_model', v_feat_billing,
        'expires_at', v_feat_expires_at,
        'remaining_uses', v_feat_uses
      )
    );

    return jsonb_build_object(
      'ok', true,
      'kind','client_premium_feature',
      'entitlement_id', v_entitlement_id,
      'feature_id', v_feat_id,
      'billing_model', v_feat_billing,
      'expires_at', v_feat_expires_at,
      'remaining_uses', v_feat_uses
    );
  end if;

  raise exception 'unknown product_id: %', p_product_id;
end;
$$;

revoke all on function public.apply_catalog_purchase_v2(uuid,text,uuid,jsonb) from public;
grant execute on function public.apply_catalog_purchase_v2(uuid,text,uuid,jsonb) to service_role;
