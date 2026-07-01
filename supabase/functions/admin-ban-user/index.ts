import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')!
const ANON_KEY        = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_KEY     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPER_ADMIN_ID  = 'e2a02510-a3d3-453a-a4bb-ba4a6e7a1bf8'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405)

  const authHeader = req.headers.get('Authorization') ?? ''
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } }
  })
  const { data: { user } } = await userClient.auth.getUser()
  if (user?.id !== SUPER_ADMIN_ID) return json({ error: 'Forbidden' }, 403)

  const body = await req.json().catch(() => ({}))
  const { target_uid, action, reason } = body as {
    target_uid?: string
    action?:     'ban' | 'unban'
    reason?:     string
  }

  if (!target_uid)                          return json({ error: 'target_uid 필수' }, 400)
  if (!action || !['ban','unban'].includes(action)) return json({ error: 'action: ban | unban' }, 400)
  if (target_uid === SUPER_ADMIN_ID)        return json({ error: '어드민 계정은 제재 불가' }, 403)

  const admin = createClient(SUPABASE_URL, SERVICE_KEY)

  // 현재 대상 회원 정보 조회
  const { data: targetUser } = await admin
    .from('users').select('role, email').eq('id', target_uid).maybeSingle()

  let updatePayload: Record<string, unknown>

  if (action === 'ban') {
    updatePayload = {
      role:       'banned',
      banned_at:  new Date().toISOString(),
      ban_reason: reason ?? '어드민 제재',
    }
  } else {
    // unban: 가장 최근 ban 로그에서 원래 role 복원
    const { data: lastBan } = await admin
      .from('admin_action_logs')
      .select('meta')
      .eq('target_uid', target_uid)
      .eq('action', 'ban')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const originalRole = lastBan?.meta?.original_role ?? 'instructor'
    updatePayload = {
      role:       originalRole,
      banned_at:  null,
      ban_reason: null,
    }
  }

  const { error: updateErr } = await admin
    .from('users').update(updatePayload).eq('id', target_uid)
  if (updateErr) return json({ error: updateErr.message }, 500)

  // 제재 시 기존 세션 즉시 무효화
  if (action === 'ban') {
    await admin.auth.admin.signOut(target_uid)
  }

  // 활동 로그 기록
  await admin.from('admin_action_logs').insert({
    admin_id:     user.id,
    target_uid,
    target_email: targetUser?.email ?? '',
    action,
    reason:       reason ?? '',
    meta:         { original_role: targetUser?.role },
  })

  return json({ success: true, action, target_uid })
})

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
