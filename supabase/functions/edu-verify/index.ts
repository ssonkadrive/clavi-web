import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

type Provider = 'kakao' | 'gov24'

interface ParsedEdu { school: string; degree: string; major: string }

// 카카오 지갑 교육 증명서 응답 구조
function parseKakao(p: Record<string, string>): ParsedEdu {
  const degreeMap: Record<string, string> = {
    '학사': '4년제 학사', '전문학사': '전문학사',
    '석사': '석사',       '박사': '박사'
  }
  if (!p.school_name || !p.degree || !p.department)
    throw new Error('kakao payload 필드 누락: school_name, degree, department 필요')
  return {
    school: p.school_name,
    degree: degreeMap[p.degree] ?? p.degree,
    major:  p.department
  }
}

// 정부24 학력 조회 API 응답 구조
function parseGov24(p: Record<string, string>): ParsedEdu {
  const degreeMap: Record<string, string> = {
    '11': '4년제 학사', '12': '전문학사',
    '21': '석사',       '31': '박사'
  }
  if (!p.univNm || !p.degreeCd || !p.mjorNm)
    throw new Error('gov24 payload 필드 누락: univNm, degreeCd, mjorNm 필요')
  return {
    school: p.univNm,
    degree: degreeMap[p.degreeCd] ?? p.degreeCd,
    major:  p.mjorNm
  }
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST')   return new Response('Method Not Allowed', { status: 405 })

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader) return json({ error: 'Unauthorized' }, 401)

  // 사용자 신원 확인
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } }
  })
  const { data: { user }, error: authErr } = await userClient.auth.getUser()
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  // RLS 우회용 서비스 클라이언트
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // 강사 프로필 존재 여부 + 이미 인증 여부 확인
  const { data: instructor } = await admin
    .from('instructors')
    .select('user_id, edu_verified_at')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!instructor)
    return json({ error: '강사 프로필이 존재하지 않습니다.' }, 404)

  if (instructor.edu_verified_at)
    return json({ error: '이미 학력 인증이 완료되었습니다.' }, 409)

  const body = await req.json().catch(() => null)
  if (!body?.provider || !body?.raw_payload)
    return json({ error: 'provider와 raw_payload가 필요합니다.' }, 400)

  let parsed: ParsedEdu
  try {
    if      (body.provider === 'kakao')  parsed = parseKakao(body.raw_payload)
    else if (body.provider === 'gov24')  parsed = parseGov24(body.raw_payload)
    else throw new Error('지원하지 않는 provider (kakao | gov24)')
  } catch (e) {
    return json({ error: '페이로드 파싱 실패', detail: String(e) }, 422)
  }

  // 프리미엄 학교 여부 조회
  const { data: premiumRow } = await admin
    .from('premium_schools_managed')
    .select('id')
    .eq('school_name', parsed.school)
    .maybeSingle()

  const isPremium = !!premiumRow

  // DB 기록 (edu_verified_at 최초 설정 — 트리거가 이후 수정 차단)
  const { error: updateErr } = await admin
    .from('instructors')
    .update({
      edu_school:      parsed.school,
      edu_degree:      parsed.degree,
      edu_major:       parsed.major,
      edu_verified_at: new Date().toISOString(),
      edu_provider:    body.provider as Provider,
      edu_is_premium:  isPremium
    })
    .eq('user_id', user.id)

  if (updateErr) return json({ error: 'DB 업데이트 실패', detail: updateErr.message }, 500)

  return json({
    success:    true,
    school:     parsed.school,
    degree:     parsed.degree,
    major:      parsed.major,
    is_premium: isPremium
  }, 200)
})

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  })
}
