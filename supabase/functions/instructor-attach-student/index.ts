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

// Re-verifies the CALLER's own instructor credentials against
// digital_identities, every single call -- no session/JWT anywhere in this
// feature (matches the design lesson this was ported from: a coach/
// instructor's reach should be structurally re-proven each time, not
// trusted from a stored token). Returns null on success, or a Response to
// return immediately on failure.
async function verifyInstructor(
  supabaseUrl: string, serviceRoleKey: string, headers: Record<string, string>,
  instructorDigitalId: string, instructorPin: string,
): Promise<Response | null> {
  const selectRes = await fetch(
    `${supabaseUrl}/rest/v1/digital_identities?digital_id=eq.${encodeURIComponent(instructorDigitalId)}&select=pin_hash,failed_attempts,locked_until`,
    { headers },
  )
  if (!selectRes.ok) return jsonResponse({ message: 'Could not verify instructor credentials.' }, 502)
  const rows = await selectRes.json()
  const row = rows?.[0]
  if (!row) return jsonResponse({ message: GENERIC_AUTH_ERROR }, 401)
  if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
    return jsonResponse({ message: GENERIC_AUTH_ERROR }, 401)
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
    return jsonResponse({ message: GENERIC_AUTH_ERROR }, 401)
  }
  // Confirm this digital_id actually registered as an instructor (a valid
  // Digital ID + PIN alone isn't enough -- see register-instructor).
  const instructorRes = await fetch(
    `${supabaseUrl}/rest/v1/instructors?digital_id=eq.${encodeURIComponent(instructorDigitalId)}&select=digital_id`,
    { headers },
  )
  const instructorRows = await instructorRes.json()
  if (!instructorRows?.[0]) {
    return jsonResponse({ message: "This Digital ID isn't registered as an instructor yet." }, 403)
  }
  return null
}

// Backs instructor.html's "Add Student" form. No approval step from the
// student -- the student's Digital ID alone is treated as the consent
// signal (a deliberate, accepted design choice, same trust model this was
// ported from). Idempotent: attaching the same instructor+student+subject
// again just flips a removed relationship back to active.
Deno.serve(async (req) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ message: 'Server misconfigured: missing Supabase service credentials.' }, 500)
    }

    const { instructorDigitalId, instructorPin, studentDigitalId, subject } = await req.json()

    if (typeof instructorDigitalId !== 'string' || !instructorDigitalId.trim()
        || typeof instructorPin !== 'string' || !instructorPin) {
      return jsonResponse({ message: GENERIC_AUTH_ERROR }, 401)
    }
    if (typeof studentDigitalId !== 'string' || !studentDigitalId.trim()) {
      return jsonResponse({ message: 'Enter the student\'s Digital ID.' }, 400)
    }
    const cleanSubject = (typeof subject === 'string' && subject.trim()) ? subject.trim() : 'General'

    const headers = {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      'Content-Type': 'application/json',
    }

    const authError = await verifyInstructor(supabaseUrl, serviceRoleKey, headers, instructorDigitalId, instructorPin)
    if (authError) return authError

    const studentRes = await fetch(
      `${supabaseUrl}/rest/v1/digital_identities?digital_id=eq.${encodeURIComponent(studentDigitalId)}&select=digital_id`,
      { headers },
    )
    const studentRows = await studentRes.json()
    if (!studentRows?.[0]) {
      return jsonResponse({ message: 'No student found with that Digital ID.' }, 404)
    }

    const attachRes = await fetch(
      `${supabaseUrl}/rest/v1/instructor_students?on_conflict=instructor_digital_id,student_digital_id,subject`,
      {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({
          instructor_digital_id: instructorDigitalId,
          student_digital_id: studentDigitalId,
          subject: cleanSubject,
          status: 'active',
          updated_at: new Date().toISOString(),
        }),
      },
    )
    if (!attachRes.ok) {
      const errText = await attachRes.text()
      return jsonResponse({ message: `Could not attach this student: ${errText.slice(0, 300)}` }, 502)
    }

    return jsonResponse({ studentDigitalId, subject: cleanSubject, status: 'active' })
  } catch (err) {
    return jsonResponse({ message: err instanceof Error ? err.message : 'Unexpected error attaching this student.' }, 500)
  }
})
