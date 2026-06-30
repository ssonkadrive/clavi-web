import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
// Supabase Dashboard > Edge Functions > Secrets 에 CRON_SECRET 등록 후 사용
const CRON_SECRET      = Deno.env.get('CRON_SECRET') ?? ''

serve(async (req) => {
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } })

  // 내부 Cron 또는 검증된 호출만 허용
  const secret = req.headers.get('x-cron-secret') ?? ''
  if (CRON_SECRET && secret !== CRON_SECRET)
    return new Response('Forbidden', { status: 403 })

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // SQL 섹션 1-H 에 정의된 process_match_timeouts() 호출
  const { error } = await admin.rpc('process_match_timeouts')

  if (error) {
    console.error('[cron-match-timeout] RPC 실패:', error.message)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }

  console.log('[cron-match-timeout] 완료 at', new Date().toISOString())
  return new Response(JSON.stringify({ ok: true, ran_at: new Date().toISOString() }), { status: 200 })
})

// ── Supabase config.toml 에 아래 추가 ─────────────────────────────
// [functions.cron-match-timeout]
// schedule = "*/30 * * * *"
//
// ── 또는 pg_cron 직접 사용 시 SQL Editor 에서 ─────────────────────
// SELECT cron.schedule(
//   'clavi-match-timeout',
//   '*/30 * * * *',
//   'SELECT public.process_match_timeouts()'
// );
