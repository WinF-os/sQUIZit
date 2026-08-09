// Inlined rather than imported from ../_shared/cors.ts -- see the comment
// in register-instructor/index.ts.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function handleOptions(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  return null
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

import bcrypt from 'npm:bcryptjs@2.4.3'

const MAX_FAILED_ATTEMPTS = 8
const LOCKOUT_MINUTES = 15
const GENERIC_AUTH_ERROR = 'That Digital ID or PIN is incorrect, or this Digital ID is temporarily locked. Please wait and try again.'

async function verifyInstructor(
  supabaseUrl: string, serviceRoleKey: string, headers: Record<string, string>,
  instructorDigitalId: string, instructorPin: string,
): Promise<{ error: Response | null; displayName?: string }> {
  const selectRes = await fetch(
    `${supabaseUrl}/rest/v1/digital_identities?digital_id=eq.${encodeURIComponent(instructorDigitalId)}&select=pin_hash,failed_attempts,locked_until`,
    { headers },
  )
  if (!selectRes.ok) return { error: jsonResponse({ message: 'Could not verify instructor credentials.' }, 502) }
  const rows = await selectRes.json()
  const row = rows?.[0]
  if (!row) return { error: jsonResponse({ message: GENERIC_AUTH_ERROR }, 401) }
  if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
    return { error: jsonResponse({ message: GENERIC_AUTH_ERROR }, 401) }
  }
  const matches = await bcrypt.compare(instructorPin, row.pin_hash)
  if (!matches) {
    const newFailedAttempts = (row.failed_attempts || 0) + 1
    const lockedUntil = newFailedAttempts >= MAX_FAILED_ATTEMPTS
      ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString()
      : null
    await fetch(`${supabaseUrl}/rest/v1/digital_identities?digital_id=eq.${encodeURIComponent(instructorDigitalId)}`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ failed_attempts: newFailedAttempts, locked_until: lockedUntil }),
    })
    return { error: jsonResponse({ message: GENERIC_AUTH_ERROR }, 401) }
  }
  const instructorRes = await fetch(
    `${supabaseUrl}/rest/v1/instructors?digital_id=eq.${encodeURIComponent(instructorDigitalId)}&select=digital_id,display_name`,
    { headers },
  )
  const instructorRows = await instructorRes.json()
  if (!instructorRows?.[0]) {
    return { error: jsonResponse({ message: "This Digital ID isn't registered as an instructor yet." }, 403) }
  }
  return { error: null, displayName: instructorRows[0].display_name }
}

// Backs instructor.html's roster + progress dashboard. Deliberately no
// filter params -- a real roster is realistically tens of students, so
// filtering by subject/gradeLevel/school/section happens client-side on
// this one response, not as separate re-fetches. Reads directly from each
// attached student's own digital_identities.payload (the exact same blob
// Back Up via Digital ID already writes) rather than a second "stats"
// table, so this view can never silently drift from the main app's own
// definition of a completed quiz/score.
Deno.serve(async (req) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ message: 'Server misconfigured: missing Supabase service credentials.' }, 500)
    }

    const { instructorDigitalId, instructorPin } = await req.json()
    if (typeof instructorDigitalId !== 'string' || !instructorDigitalId.trim()
        || typeof instructorPin !== 'string' || !instructorPin) {
      return jsonResponse({ message: GENERIC_AUTH_ERROR }, 401)
    }

    const headers = {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      'Content-Type': 'application/json',
    }

    const { error: authError, displayName } = await verifyInstructor(supabaseUrl, serviceRoleKey, headers, instructorDigitalId, instructorPin)
    if (authError) return authError

    const select = 'id,student_digital_id,subject,created_at,digital_identities(payload)'
    const rosterRes = await fetch(
      `${supabaseUrl}/rest/v1/instructor_students?instructor_digital_id=eq.${encodeURIComponent(instructorDigitalId)}&status=eq.active&select=${encodeURIComponent(select)}&order=created_at.desc`,
      { headers },
    )
    if (!rosterRes.ok) {
      const errText = await rosterRes.text()
      return jsonResponse({ message: `Could not load your roster: ${errText.slice(0, 300)}` }, 502)
    }
    const rows = await rosterRes.json()

    const roster = (rows || []).map((row: any) => {
      const payload = row.digital_identities?.payload || null
      const identity = payload?.studentIdentity || null
      const library = Array.isArray(payload?.library) ? payload.library : []
      const hasData = library.length > 0

      // Flatten every exam's own history array into one timeline. Each
      // individual exam's history is already exactly chronological (built
      // by appending), so this is only approximate across DIFFERENT exams
      // completed on the same calendar day -- acceptable, not exact.
      const timeline: { date: string; scorePercent: number; examTitle: string; subject: string }[] = []
      for (const exam of library) {
        const examHistory = Array.isArray(exam.history) ? exam.history : []
        for (const h of examHistory) {
          timeline.push({
            date: h.date,
            scorePercent: h.scorePercent,
            examTitle: exam.examTitle || exam.title || 'Untitled Exam',
            subject: exam.subject || 'General',
          })
        }
      }
      timeline.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

      // quizCount = completed ATTEMPTS (timeline entries), not distinct
      // exams -- a retaken exam contributes more than one point here.
      const quizCount = timeline.length
      const averageScorePercent = quizCount > 0
        ? Math.round((timeline.reduce((sum, t) => sum + (t.scorePercent || 0), 0) / quizCount) * 10) / 10
        : null
      const last = quizCount > 0 ? timeline[timeline.length - 1] : null

      return {
        studentDigitalId: row.student_digital_id,
        subject: row.subject,
        attachedAt: row.created_at,
        identity: identity ? {
          surname: identity.surname || '',
          givenName: identity.givenName || '',
          middleName: identity.middleName || '',
          school: identity.school || '',
          gradeLevel: identity.gradeLevel || '',
          section: identity.section || '',
          photoDataUrl: identity.photoDataUrl || null,
        } : null,
        hasData,
        stats: {
          quizCount,
          averageScorePercent,
          mostRecentScorePercent: last ? last.scorePercent : null,
          mostRecentDate: last ? last.date : null,
          timeline,
        },
      }
    })

    return jsonResponse({ instructor: { digitalId: instructorDigitalId, displayName }, roster })
  } catch (err) {
    return jsonResponse({ message: err instanceof Error ? err.message : 'Unexpected error loading your roster.' }, 500)
  }
})
