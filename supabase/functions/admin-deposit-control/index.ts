import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Phase 2 활성화 대기 STUB ──────────────────────────────────────
// 현재: 모든 액션이 501 Not Implemented 반환
// Phase 2: PG사 연동 후 아래 TODO 블록 구현
// ─────────────────────────────────────────────────────────────────

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPER_ADMIN_ID    = 'e2a02510-a3d3-453a-a4bb-ba4a6e7a1bf8'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

async function verifyAdmin(authHeader: string): Promise<boolean> {
  if (!authHeader) return false
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } }
  })
  const { data: { user } } = await client.auth.getUser()
  return user?.id === SUPER_ADMIN_ID
}

type DepositAction = 'force_refund' | 'force_confiscate' | 'toggle_bypass' | 'escrow_status'

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  const isAdmin = await verifyAdmin(req.headers.get('Authorization') ?? '')
  if (!isAdmin) return json({ error: 'Forbidden' }, 403)

  const url    = new URL(req.url)
  const action = url.searchParams.get('action') as DepositAction | null

  if (!action) return json({ error: 'action 쿼리 파라미터 필수', available: ['force_refund','force_confiscate','toggle_bypass','escrow_status'] }, 400)

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // force_refund: 예약금 강제 환불
  if (action === 'force_refund') {
    // TODO (Phase 2): body.match_id 로 matches 조회 → PG 에스크로 환불 API 호출
    // const { match_id } = await req.json()
    // await pgEscrowRefund(match_id)
    // await admin.from('matches').update({ status: 'CANCELLED', cancel_reason: '어드민 강제 환불' }).eq('id', match_id)
    return json({ stub: true, message: 'Phase 2 미구현 — PG 에스크로 환불 예정' }, 501)
  }

  // force_confiscate: 예약금 강제 귀속 (귀책 당사자 결정 후)
  if (action === 'force_confiscate') {
    // TODO (Phase 2): body.match_id, body.beneficiary('academy'|'instructor') 로 귀속 처리
    return json({ stub: true, message: 'Phase 2 미구현 — PG 에스크로 귀속 예정' }, 501)
  }

  // toggle_bypass: 특정 매칭의 결제 우회 ON/OFF
  if (action === 'toggle_bypass') {
    const body = await req.json().catch(() => ({}))
    const { match_id, bypass } = body as { match_id?: string; bypass?: boolean }
    if (!match_id || bypass === undefined)
      return json({ error: 'match_id, bypass(boolean) 필수' }, 400)

    const { error } = await admin
      .from('matches')
      .update({ deposit_bypassed: bypass })
      .eq('id', match_id)

    if (error) return json({ error: error.message }, 500)
    return json({ success: true, match_id, deposit_bypassed: bypass })
  }

  // escrow_status: 에스크로 잔액 및 현황 조회
  if (action === 'escrow_status') {
    // TODO (Phase 2): PG사 에스크로 조회 API 연동
    // const summary = await pgEscrowStatus()
    // 현재: DB 기반 집계만 반환
    const { data } = await admin
      .from('matches')
      .select('status, deposit_bypassed, deposit_amount')

    const stats = {
      total:    data?.length ?? 0,
      bypassed: data?.filter(m => m.deposit_bypassed).length ?? 0,
      active:   data?.filter(m => m.status === 'DEPOSIT_PAID').length ?? 0,
      // TODO (Phase 2): pg_escrow_balance 필드 추가
    }
    return json({ stats, pg_integration: 'Phase 2 미구현' })
  }

  return json({ error: `알 수 없는 action: ${action}` }, 400)
})

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  })
}
