import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

type MatchAction = 'propose' | 'accept' | 'decline' | 'schedule' | 'complete' | 'cancel'

interface RequestBody {
  action:          MatchAction
  match_id?:       string
  instructor_id?:  string   // propose 시 필수
  interview_at?:   string   // schedule 시 필수 (ISO8601)
  cancel_reason?:  string
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST')   return new Response('Method Not Allowed', { status: 405 })

  const authHeader = req.headers.get('Authorization') ?? ''
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } }
  })
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return json({ error: 'Unauthorized' }, 401)

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // 사용자 역할 및 프로필 id 조회
  const { data: userData } = await admin
    .from('users').select('role').eq('id', user.id).single()
  const role: string = userData?.role ?? ''

  // academies/instructors 테이블의 PK(id) 조회 (auth.uid = user_id)
  let profileId: string | null = null
  if (role === 'academy') {
    const { data: p } = await admin.from('academies').select('id').eq('user_id', user.id).maybeSingle()
    profileId = p?.id ?? null
  } else if (role === 'instructor') {
    const { data: p } = await admin.from('instructors').select('id').eq('user_id', user.id).maybeSingle()
    profileId = p?.id ?? null
  }
  if (!profileId && body.action !== 'propose')
    return json({ error: '프로필이 존재하지 않습니다.' }, 404)

  const body: RequestBody = await req.json()
  const { action } = body

  // ── propose: 원장이 강사에게 제안 ──────────────────────────
  if (action === 'propose') {
    if (role !== 'academy')
      return json({ error: '원장만 스카웃 제안을 보낼 수 있습니다.' }, 403)
    if (!body.instructor_id)
      return json({ error: 'instructor_id 필수' }, 400)

    if (!profileId) return json({ error: '학원 프로필이 존재하지 않습니다.' }, 404)

    const { data: match, error } = await admin
      .from('matches')
      .insert({ academy_id: profileId, instructor_id: body.instructor_id, status: 'PROPOSED' })
      .select()
      .single()

    if (error) return json({ error: error.message }, 409)

    // TODO: FCM / Supabase Realtime 으로 강사에게 알림 발송
    return json({ success: true, match }, 201)
  }

  // ── 이하: match_id 필수 ────────────────────────────────────
  if (!body.match_id) return json({ error: 'match_id 필수' }, 400)

  const { data: match } = await admin
    .from('matches').select('*').eq('id', body.match_id).single()
  if (!match) return json({ error: '매칭 없음' }, 404)

  const isAcademy    = match.academy_id    === profileId
  const isInstructor = match.instructor_id === profileId
  if (!isAcademy && !isInstructor)
    return json({ error: '접근 권한 없음' }, 403)

  // ── accept ─────────────────────────────────────────────────
  if (action === 'accept') {
    if (!isInstructor) return json({ error: '강사만 수락 가능' }, 403)
    if (match.status !== 'PROPOSED')
      return json({ error: `수락 불가 — 현재 상태: ${match.status}` }, 409)

    const chatRoomId = crypto.randomUUID()
    await admin.from('matches')
      .update({ status: 'ACCEPTED', chat_room_id: chatRoomId })
      .eq('id', body.match_id)

    // TODO: 원장에게 수락 알림 발송
    return json({ success: true, chat_room_id: chatRoomId })
  }

  // ── decline ────────────────────────────────────────────────
  if (action === 'decline') {
    if (!isInstructor) return json({ error: '강사만 거절 가능' }, 403)
    if (match.status !== 'PROPOSED')
      return json({ error: `거절 불가 — 현재 상태: ${match.status}` }, 409)

    await admin.from('matches').update({ status: 'DECLINED' }).eq('id', body.match_id)
    return json({ success: true })
  }

  // ── schedule: 원장이 면접 일정 확정 ────────────────────────
  if (action === 'schedule') {
    if (!isAcademy) return json({ error: '원장만 면접 일정을 제안할 수 있습니다.' }, 403)
    if (match.status !== 'ACCEPTED')
      return json({ error: `일정 설정 불가 — 현재 상태: ${match.status}` }, 409)
    if (!body.interview_at)
      return json({ error: 'interview_at 필수 (ISO8601)' }, 400)

    const interviewDate = new Date(body.interview_at)
    if (isNaN(interviewDate.getTime()))
      return json({ error: 'interview_at 형식 오류' }, 400)

    // SCHEDULED 설정
    await admin.from('matches').update({
      status:       'SCHEDULED',
      interview_at: interviewDate.toISOString()
    }).eq('id', body.match_id)

    // ── 결제 우회 (Phase 2에서 PG 연동으로 교체) ──────────────
    // TODO (Phase 2): 실결제 요청 → academy_deposit / instructor_deposit 을
    //                 PG 웹훅 수신 후 true 로 변경하고 DEPOSIT_PAID 전이
    await admin.from('matches').update({
      deposit_bypassed:   true,
      academy_deposit:    true,
      instructor_deposit: true,
      status:             'DEPOSIT_PAID'
    }).eq('id', body.match_id)

    // TODO: 양측에 면접 일정 확정 알림 발송
    return json({
      success:      true,
      interview_at: interviewDate.toISOString(),
      bypassed:     true
    })
  }

  // ── complete: 원장/강사 면접 완료 확인 ─────────────────────
  if (action === 'complete') {
    if (match.status !== 'DEPOSIT_PAID')
      return json({ error: `완료 처리 불가 — 현재 상태: ${match.status}` }, 409)

    const actor = isAcademy ? 'academy' : 'instructor'
    const completed: string[] = match.completed_by ?? []

    if (completed.includes(actor))
      return json({ error: '이미 완료 확인하였습니다.' }, 409)

    const newCompleted = [...completed, actor]
    const update: Record<string, unknown> = { completed_by: newCompleted }

    if (actor === 'academy') update.academy_completed_at = new Date().toISOString()

    const bothDone = newCompleted.includes('academy') && newCompleted.includes('instructor')
    if (bothDone) {
      update.status = 'INTERVIEW_COMPLETED'
      // TODO (Phase 2): 예약금 환불 처리
      // await notifyPgEscrow('REFUND', match.id, match.deposit_amount)
    }

    await admin.from('matches').update(update).eq('id', body.match_id)
    return json({ success: true, completed: bothDone })
  }

  // ── cancel ─────────────────────────────────────────────────
  if (action === 'cancel') {
    const cancellable = ['ACCEPTED', 'SCHEDULED', 'DEPOSIT_PAID']
    if (!cancellable.includes(match.status))
      return json({ error: `취소 불가 상태: ${match.status}` }, 409)

    await admin.from('matches').update({
      status:        'CANCELLED',
      cancel_reason: body.cancel_reason ?? '사용자 취소'
    }).eq('id', body.match_id)

    // TODO (Phase 2): 취소 시점/사유 기반 예약금 정산 정책 실행
    return json({ success: true })
  }

  return json({ error: `알 수 없는 action: ${action}` }, 400)
})

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  })
}
