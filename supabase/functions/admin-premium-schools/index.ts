import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  const isAdmin = await verifyAdmin(req.headers.get('Authorization') ?? '')
  if (!isAdmin) return json({ error: 'Forbidden' }, 403)

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const url   = new URL(req.url)

  // GET — 전체 목록 조회
  if (req.method === 'GET') {
    const { data, error } = await admin
      .from('premium_schools_managed')
      .select('*')
      .order('school_name')

    if (error) return json({ error: error.message }, 500)
    return json({ schools: data })
  }

  // POST — 학교 추가 (sync_instructor_premium 트리거가 기존 강사 자동 태깅)
  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}))
    const name = body.school_name?.trim()
    if (!name) return json({ error: 'school_name 필수' }, 400)

    const { data, error } = await admin
      .from('premium_schools_managed')
      .insert({ school_name: name })
      .select()
      .single()

    if (error) return json({ error: error.message }, 409)
    return json({ success: true, school: data }, 201)
  }

  // DELETE ?id=xxx — 학교 제거 (트리거가 기존 강사 premium 해제)
  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id')
    if (!id) return json({ error: 'id 쿼리 파라미터 필수' }, 400)

    const { error } = await admin
      .from('premium_schools_managed')
      .delete()
      .eq('id', id)

    if (error) return json({ error: error.message }, 500)
    return json({ success: true })
  }

  return json({ error: 'Method Not Allowed' }, 405)
})

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  })
}
