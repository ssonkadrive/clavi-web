import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const NAVER_CLIENT_ID     = Deno.env.get('NAVER_CLIENT_ID')!;
const NAVER_CLIENT_SECRET = Deno.env.get('NAVER_CLIENT_SECRET')!;
const SUPABASE_URL        = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const APP_URL             = 'https://clavi-web.vercel.app';

serve(async (req) => {
  const url = new URL(req.url);

  // 1단계: 네이버 로그인 페이지로 리다이렉트
  if (url.pathname.endsWith('/login')) {
    const state = crypto.randomUUID();
    const role  = url.searchParams.get('role') || 'instructor';
    const naverAuthUrl = new URL('https://nid.naver.com/oauth2.0/authorize');
    naverAuthUrl.searchParams.set('response_type', 'code');
    naverAuthUrl.searchParams.set('client_id', NAVER_CLIENT_ID);
    naverAuthUrl.searchParams.set('redirect_uri', `${SUPABASE_URL}/functions/v1/naver-auth/callback`);
    naverAuthUrl.searchParams.set('state', `${state}:${role}`);
    return Response.redirect(naverAuthUrl.toString(), 302);
  }

  // 2단계: 네이버 콜백 처리
  if (url.pathname.endsWith('/callback')) {
    const code  = url.searchParams.get('code');
    const state = url.searchParams.get('state') || '';
    const role  = state.split(':')[1] || 'instructor';

    if (!code) {
      return Response.redirect(`${APP_URL}?error=naver_no_code`, 302);
    }

    // 네이버 토큰 교환
    const tokenRes = await fetch('https://nid.naver.com/oauth2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     NAVER_CLIENT_ID,
        client_secret: NAVER_CLIENT_SECRET,
        code,
        state,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return Response.redirect(`${APP_URL}?error=naver_token_fail`, 302);
    }

    // 네이버 유저정보 조회
    const profileRes = await fetch('https://openapi.naver.com/v1/nid/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profileData = await profileRes.json();
    const naver = profileData.response;
    if (!naver?.id) {
      return Response.redirect(`${APP_URL}?error=naver_profile_fail`, 302);
    }

    // Supabase admin으로 유저 생성/로그인
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const email = naver.email || `naver_${naver.id}@clavi.naver`;

    // 기존 유저 확인
    const { data: existing } = await admin.auth.admin.listUsers();
    const existingUser = existing?.users?.find(u =>
      u.user_metadata?.naver_id === naver.id
    );

    let userId: string;
    if (existingUser) {
      userId = existingUser.id;
    } else {
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: {
          naver_id:   naver.id,
          name:       naver.name,
          email:      naver.email,
          mobile:     naver.mobile,
          gender:     naver.gender,
          birthyear:  naver.birthyear,
          provider:   'naver',
          role,
        },
      });
      if (createErr || !created?.user) {
        return Response.redirect(`${APP_URL}?error=naver_create_fail`, 302);
      }
      userId = created.user.id;
    }

    // 매직링크로 세션 발급
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email,
    });
    if (linkErr || !linkData?.properties?.hashed_token) {
      return Response.redirect(`${APP_URL}?error=naver_session_fail`, 302);
    }

    const redirectUrl = `${APP_URL}?naver_token=${linkData.properties.hashed_token}&role=${role}`;
    return Response.redirect(redirectUrl, 302);
  }

  return new Response('Not found', { status: 404 });
});
