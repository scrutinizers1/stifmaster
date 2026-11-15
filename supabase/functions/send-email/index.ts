/* ============================================================================
   Light Bearers — Supabase Edge Function:  send-email
   ----------------------------------------------------------------------------
   Delivers real email through Resend (https://resend.com).

   Who may call it:  only a signed-in user whose profile role is 'admin'
                     (checked with the public.is_admin() RPC using the caller's
                     own JWT — never a service key in the browser).

   Secrets to set on this function (Dashboard -> Edge Functions -> send-email
   -> Settings -> Secrets, or `supabase secrets set`):
       RESEND_API_KEY   re_xxxxxxxx           (required)
       MAIL_FROM        Light Bearers <hello@yourdomain.co.za>   (optional)

   SUPABASE_URL and SUPABASE_ANON_KEY are injected automatically.

   Request body:  { to, subject, body, from?, replyTo? }
   Response:      { ok:true, id }  or  { error:"..." }
   ============================================================================ */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const auth = req.headers.get('Authorization') || ''
    if (!auth) return json({ error: 'Missing Authorization header' }, 401)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: auth } } }
    )

    const { data: userData, error: userErr } = await supabase.auth.getUser()
    if (userErr || !userData?.user) return json({ error: 'Not signed in' }, 401)

    const { data: isAdmin, error: adminErr } = await supabase.rpc('is_admin')
    if (adminErr) return json({ error: 'Admin check failed: ' + adminErr.message }, 500)
    if (!isAdmin) return json({ error: 'Only staff may send centre email' }, 403)

    const payload = await req.json().catch(() => ({}))
    const to = String(payload.to || '').trim()
    const subject = String(payload.subject || '').trim()
    const body = String(payload.body || '')
    const from = String(payload.from || '').trim()
    const replyTo = String(payload.replyTo || '').trim()

    if (!to || !subject) return json({ error: 'Both "to" and "subject" are required' }, 400)

    const key = Deno.env.get('RESEND_API_KEY')
    if (!key) {
      return json({ error: 'RESEND_API_KEY is not set on this function. Add it in the Edge Function secrets.' }, 500)
    }
    const sender = from || Deno.env.get('MAIL_FROM') || 'Light Bearers <onboarding@resend.dev>'

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: sender,
        to: [to],
        subject,
        text: body,
        reply_to: replyTo || undefined
      })
    })

    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return json({ error: (data && (data.message || data.error)) || `Resend error ${res.status}`, detail: data }, 502)
    }
    return json({ ok: true, id: data.id || null })
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})
