-- ================================================================
-- CLAVI Admin v2 Migration
-- 회원 로직 고도화 + 어드민 인프라
-- ================================================================

-- ────────────────────────────────────────────────────────────────
-- A. users 테이블 컬럼 추가
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS email_verified  BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS role_locked     BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS banned_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ban_reason      TEXT,
  ADD COLUMN IF NOT EXISTS auth_providers  TEXT[]      NOT NULL DEFAULT '{}';

-- email 컬럼 (auth.users.email 미러링용)
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS email TEXT;

CREATE INDEX IF NOT EXISTS idx_users_email  ON public.users (email);
CREATE INDEX IF NOT EXISTS idx_users_role   ON public.users (role);
CREATE INDEX IF NOT EXISTS idx_users_banned ON public.users (banned_at) WHERE banned_at IS NOT NULL;


-- ────────────────────────────────────────────────────────────────
-- B. 약관 동의 시 role 자동 잠금 트리거
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.lock_role_on_agree()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.agreed_at IS NULL AND NEW.agreed_at IS NOT NULL THEN
    NEW.role_locked := true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lock_role_on_agree ON public.users;
CREATE TRIGGER trg_lock_role_on_agree
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.lock_role_on_agree();


-- ────────────────────────────────────────────────────────────────
-- C. role 변경 차단 트리거 (어드민 제외)
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.prevent_role_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role_locked
     AND NEW.role IS DISTINCT FROM OLD.role
     AND auth.uid() != 'e2a02510-a3d3-453a-a4bb-ba4a6e7a1bf8'::uuid THEN
    RAISE EXCEPTION 'role_locked: 역할은 최초 가입 후 변경 불가';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_role_change ON public.users;
CREATE TRIGGER trg_prevent_role_change
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.prevent_role_change();


-- ────────────────────────────────────────────────────────────────
-- D. 어드민 활동 로그 테이블
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.admin_action_logs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id     UUID        NOT NULL REFERENCES auth.users(id),
  target_uid   UUID        NOT NULL,
  target_email TEXT,
  action       TEXT        NOT NULL CHECK (action IN ('ban','unban','role_change','note')),
  reason       TEXT,
  meta         JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_logs_target  ON public.admin_action_logs (target_uid);
CREATE INDEX IF NOT EXISTS idx_admin_logs_time    ON public.admin_action_logs (created_at DESC);

ALTER TABLE public.admin_action_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_logs_admin_only" ON public.admin_action_logs;
CREATE POLICY "admin_logs_admin_only" ON public.admin_action_logs
  FOR ALL USING (auth.uid() = 'e2a02510-a3d3-453a-a4bb-ba4a6e7a1bf8'::uuid);


-- ────────────────────────────────────────────────────────────────
-- E. RLS: 제재 계정 API 차단 (이중 방어)
-- ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "banned_block_ic"      ON public.instructor_conditions;
DROP POLICY IF EXISTS "banned_block_matches" ON public.matches;
DROP POLICY IF EXISTS "banned_block_chat"    ON public.chat_messages;

CREATE POLICY "banned_block_ic" ON public.instructor_conditions
  FOR ALL USING (
    NOT EXISTS (
      SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'banned'
    )
  );

CREATE POLICY "banned_block_matches" ON public.matches
  FOR ALL USING (
    NOT EXISTS (
      SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'banned'
    )
  );

CREATE POLICY "banned_block_chat" ON public.chat_messages
  FOR ALL USING (
    NOT EXISTS (
      SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'banned'
    )
  );


-- ────────────────────────────────────────────────────────────────
-- F. 어드민용 회원 조회 RPC (서버사이드 페이지네이션 + 필터)
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_list_users(
  p_search        TEXT    DEFAULT NULL,
  p_role          TEXT    DEFAULT NULL,
  p_verified      BOOLEAN DEFAULT NULL,
  p_date_from     DATE    DEFAULT NULL,
  p_date_to       DATE    DEFAULT NULL,
  p_page          INT     DEFAULT 0,
  p_page_size     INT     DEFAULT 20
)
RETURNS TABLE (
  id           UUID,
  email        TEXT,
  role         TEXT,
  email_verified BOOLEAN,
  agreed_at    TIMESTAMPTZ,
  banned_at    TIMESTAMPTZ,
  ban_reason   TEXT,
  auth_providers TEXT[],
  created_at   TIMESTAMPTZ,
  total_count  BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  WITH filtered AS (
    SELECT u.*
    FROM public.users u
    WHERE
      (p_search    IS NULL OR u.email ILIKE '%' || p_search || '%')
      AND (p_role  IS NULL OR u.role = p_role)
      AND (p_verified IS NULL OR u.email_verified = p_verified)
      AND (p_date_from IS NULL OR u.created_at::date >= p_date_from)
      AND (p_date_to   IS NULL OR u.created_at::date <= p_date_to)
  ),
  counted AS (SELECT COUNT(*) AS cnt FROM filtered)
  SELECT
    f.id, f.email, f.role, f.email_verified,
    f.agreed_at, f.banned_at, f.ban_reason, f.auth_providers,
    f.created_at,
    c.cnt AS total_count
  FROM filtered f, counted c
  ORDER BY f.created_at DESC
  LIMIT p_page_size OFFSET (p_page * p_page_size);
END;
$$;
