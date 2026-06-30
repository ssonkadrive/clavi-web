-- ================================================================
-- CLAVI Phase 1 Migration
-- 실행 순서: Supabase SQL Editor 에 전체 붙여넣기 후 실행
-- ================================================================


-- ────────────────────────────────────────────────────────────────
-- 1-A. premium_schools_managed
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.premium_schools_managed (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_name TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.premium_schools_managed (school_name) VALUES
  ('한국예술종합학교'), ('중앙대학교'), ('동국대학교'),
  ('서울예술대학교'), ('경희대학교'), ('단국대학교'), ('추계예술대학교')
ON CONFLICT (school_name) DO NOTHING;

ALTER TABLE public.premium_schools_managed ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_manage_premium_schools"  ON public.premium_schools_managed;
DROP POLICY IF EXISTS "service_read_premium_schools"  ON public.premium_schools_managed;

CREATE POLICY "admin_manage_premium_schools" ON public.premium_schools_managed
  FOR ALL USING (auth.uid() = 'e2a02510-a3d3-453a-a4bb-ba4a6e7a1bf8'::uuid);

-- Edge Function (service key)이 읽기 가능하도록
CREATE POLICY "service_read_premium_schools" ON public.premium_schools_managed
  FOR SELECT USING (true);


-- ────────────────────────────────────────────────────────────────
-- 1-B. instructors — edu_ 컬럼 추가
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.instructors
  ADD COLUMN IF NOT EXISTS edu_school      TEXT,
  ADD COLUMN IF NOT EXISTS edu_degree      TEXT,
  ADD COLUMN IF NOT EXISTS edu_major       TEXT,
  ADD COLUMN IF NOT EXISTS edu_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS edu_provider    TEXT CHECK (edu_provider IN ('kakao','gov24')),
  ADD COLUMN IF NOT EXISTS edu_is_premium  BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_instructors_edu_school   ON public.instructors (edu_school);
CREATE INDEX IF NOT EXISTS idx_instructors_edu_premium  ON public.instructors (edu_is_premium);
CREATE INDEX IF NOT EXISTS idx_instructors_edu_verified ON public.instructors (edu_verified_at);


-- ────────────────────────────────────────────────────────────────
-- 1-C. 학력 인증 완료 후 edu_* 수정 차단
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.prevent_edu_update()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF OLD.edu_verified_at IS NOT NULL THEN
    IF NEW.edu_school      IS DISTINCT FROM OLD.edu_school    OR
       NEW.edu_degree      IS DISTINCT FROM OLD.edu_degree    OR
       NEW.edu_major       IS DISTINCT FROM OLD.edu_major     OR
       NEW.edu_verified_at IS DISTINCT FROM OLD.edu_verified_at OR
       NEW.edu_provider    IS DISTINCT FROM OLD.edu_provider
    THEN
      RAISE EXCEPTION 'edu_locked: 학력 인증 완료 후 edu 필드는 수정 불가';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_edu_update ON public.instructors;
CREATE TRIGGER trg_prevent_edu_update
  BEFORE UPDATE ON public.instructors
  FOR EACH ROW EXECUTE FUNCTION public.prevent_edu_update();


-- ────────────────────────────────────────────────────────────────
-- 1-D. premium_schools_managed 변경 → 강사 edu_is_premium 재계산
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sync_instructor_premium()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.instructors
       SET edu_is_premium = true
     WHERE edu_school = NEW.school_name AND edu_verified_at IS NOT NULL;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.instructors
       SET edu_is_premium = false
     WHERE edu_school = OLD.school_name AND edu_verified_at IS NOT NULL;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_instructor_premium ON public.premium_schools_managed;
CREATE TRIGGER trg_sync_instructor_premium
  AFTER INSERT OR DELETE ON public.premium_schools_managed
  FOR EACH ROW EXECUTE FUNCTION public.sync_instructor_premium();


-- ────────────────────────────────────────────────────────────────
-- 1-E. matches 테이블
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.matches (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- academies.id / instructors.id (각 테이블 PK) 참조
  academy_id           UUID        NOT NULL REFERENCES public.academies(id)    ON DELETE CASCADE,
  instructor_id        UUID        NOT NULL REFERENCES public.instructors(id)  ON DELETE CASCADE,
  status               TEXT        NOT NULL DEFAULT 'PROPOSED'
    CHECK (status IN (
      'PROPOSED','ACCEPTED','DECLINED',
      'SCHEDULED','DEPOSIT_PAID','INTERVIEW_COMPLETED',
      'NO_SHOW','CANCELLED'
    )),
  chat_room_id         UUID,
  interview_at         TIMESTAMPTZ,

  -- 결제 관련: Phase 2 활성화 대비 구조만 선반영
  deposit_amount       INTEGER     NOT NULL DEFAULT 30000,
  academy_deposit      BOOLEAN     NOT NULL DEFAULT false,
  instructor_deposit   BOOLEAN     NOT NULL DEFAULT false,
  deposit_bypassed     BOOLEAN     NOT NULL DEFAULT true,   -- 현재 항상 true

  -- 면접 완료 추적
  completed_by         TEXT[]      NOT NULL DEFAULT '{}',   -- ['academy','instructor','system_auto']
  academy_completed_at TIMESTAMPTZ,
  gps_verified         BOOLEAN     NOT NULL DEFAULT false,

  cancel_reason        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 동일 academy-instructor 간 중복 활성 매칭 방지
-- (종료된 매칭 후 재매칭 허용)
CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_active_unique
  ON public.matches (academy_id, instructor_id)
  WHERE status NOT IN ('DECLINED','CANCELLED','INTERVIEW_COMPLETED','NO_SHOW');

CREATE INDEX IF NOT EXISTS idx_matches_status        ON public.matches (status);
CREATE INDEX IF NOT EXISTS idx_matches_interview_at  ON public.matches (interview_at);
CREATE INDEX IF NOT EXISTS idx_matches_academy_id    ON public.matches (academy_id);
CREATE INDEX IF NOT EXISTS idx_matches_instructor_id ON public.matches (instructor_id);

-- updated_at 자동 갱신
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_matches_updated_at ON public.matches;
CREATE TRIGGER trg_matches_updated_at
  BEFORE UPDATE ON public.matches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "match_academy_rw"    ON public.matches;
DROP POLICY IF EXISTS "match_instructor_rw" ON public.matches;
DROP POLICY IF EXISTS "match_admin_all"     ON public.matches;

-- academy_id / instructor_id 는 각 테이블의 PK(id)를 참조하므로
-- auth.uid() 와 비교하려면 user_id 컬럼을 통해 조인
CREATE POLICY "match_academy_rw" ON public.matches
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.academies WHERE id = academy_id AND user_id = auth.uid())
  );
CREATE POLICY "match_instructor_rw" ON public.matches
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.instructors WHERE id = instructor_id AND user_id = auth.uid())
  );
CREATE POLICY "match_admin_all" ON public.matches
  FOR ALL USING (auth.uid() = 'e2a02510-a3d3-453a-a4bb-ba4a6e7a1bf8'::uuid);


-- ────────────────────────────────────────────────────────────────
-- 1-F. chat_messages 테이블
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    UUID        NOT NULL,
  sender_id  UUID        NOT NULL REFERENCES auth.users(id),
  content    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_room_time ON public.chat_messages (room_id, created_at);

-- 전화번호 · SNS 연락처 자동 마스킹
CREATE OR REPLACE FUNCTION public.mask_contact_in_message()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- 한국 전화번호
  NEW.content := regexp_replace(NEW.content,
    '0\d{1,2}[-\.\s]?\d{3,4}[-\.\s]?\d{4}',
    '[연락처 비공개]', 'g');
  -- 카카오 / SNS 외부 채널
  NEW.content := regexp_replace(NEW.content,
    '(카카오|카톡|오픈채팅|open\.kakao|pf\.kakao|instagram|인스타|@)[^\s]{2,}',
    '[외부 채널 차단]', 'gi');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mask_contact ON public.chat_messages;
CREATE TRIGGER trg_mask_contact
  BEFORE INSERT ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.mask_contact_in_message();

ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "chat_participant_rw" ON public.chat_messages;
CREATE POLICY "chat_participant_rw" ON public.chat_messages
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.matches m
      WHERE m.chat_room_id = room_id
        AND (
          EXISTS (SELECT 1 FROM public.academies    WHERE id = m.academy_id    AND user_id = auth.uid()) OR
          EXISTS (SELECT 1 FROM public.instructors  WHERE id = m.instructor_id AND user_id = auth.uid())
        )
    )
  );


-- ────────────────────────────────────────────────────────────────
-- 1-G. search_instructors RPC (원장용 · 이름 마스킹)
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.search_instructors(
  p_schools      TEXT[]  DEFAULT NULL,
  p_premium_only BOOLEAN DEFAULT false,
  p_region       TEXT    DEFAULT NULL
)
RETURNS TABLE (
  instructor_id    UUID,
  masked_name      TEXT,
  edu_school       TEXT,
  edu_degree       TEXT,
  edu_major        TEXT,
  edu_is_premium   BOOLEAN,
  region_tags      JSONB,
  required_skills  JSONB,
  preferred_skills JSONB
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    i.user_id,
    CASE
      WHEN char_length(u.name) <= 1 THEN '*'
      WHEN char_length(u.name) = 2  THEN substring(u.name,1,1) || '*'
      ELSE substring(u.name,1,1)
           || repeat('*', char_length(u.name) - 2)
           || right(u.name, 1)
    END                    AS masked_name,
    i.edu_school,
    i.edu_degree,
    i.edu_major,
    i.edu_is_premium,
    ic.regions             AS region_tags,
    ic.required_skills,
    ic.preferred_skills
  FROM public.instructors i
  JOIN public.users u ON u.id = i.user_id
  LEFT JOIN public.instructor_conditions ic ON ic.user_id = i.user_id
  WHERE i.edu_verified_at IS NOT NULL
    AND (p_schools      IS NULL OR i.edu_school = ANY(p_schools))
    AND (p_premium_only = false  OR i.edu_is_premium = true)
    AND (p_region       IS NULL  OR ic.regions::text ILIKE '%' || p_region || '%')
  ORDER BY i.edu_is_premium DESC, i.edu_verified_at DESC;
END;
$$;


-- ────────────────────────────────────────────────────────────────
-- 1-H. 타임아웃 배치 함수 (pg_cron or Edge Function Cron 공용)
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.process_match_timeouts()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
BEGIN
  -- ① NO_SHOW: interview_at + 2h 초과 & 아무도 완료 확인 안 함
  UPDATE public.matches
     SET status        = 'NO_SHOW',
         cancel_reason = 'interview_at + 2h 초과 자동 처리'
   WHERE status = 'DEPOSIT_PAID'
     AND interview_at IS NOT NULL
     AND interview_at + INTERVAL '2 hours' < v_now
     AND cardinality(completed_by) = 0;

  -- TODO (Phase 2): 노쇼 시 예약금 귀속 처리
  -- PERFORM public.notify_pg_escrow('NO_SHOW', id, deposit_amount) FROM ...

  -- ② INTERVIEW_COMPLETED: 원장 확인 후 강사 24h 미응답 자동 완료
  UPDATE public.matches
     SET status        = 'INTERVIEW_COMPLETED',
         completed_by  = array_append(completed_by, 'system_auto'),
         cancel_reason = '강사 미확인 24시간 자동 완료'
   WHERE status = 'DEPOSIT_PAID'
     AND interview_at IS NOT NULL
     AND 'academy' = ANY(completed_by)
     AND NOT ('instructor' = ANY(completed_by))
     AND academy_completed_at IS NOT NULL
     AND academy_completed_at + INTERVAL '24 hours' < v_now;

  -- TODO (Phase 2): 자동 완료 시 예약금 환불 트리거
  -- PERFORM public.notify_pg_escrow('REFUND', id, deposit_amount) FROM ...
END;
$$;

-- pg_cron 등록 (Extensions > pg_cron 활성화 후 아래 실행)
-- SELECT cron.schedule(
--   'clavi-match-timeout',
--   '*/30 * * * *',
--   'SELECT public.process_match_timeouts()'
-- );
