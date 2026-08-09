// Inlined rather than imported from ../_shared/cors.ts -- the Supabase
// dashboard's "New Function" single-file editor can't resolve a relative
// import to a file outside that function's own source (same reason every
// other function in this project inlines its own copy).
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

// Backs instructor.html's "Become an Instructor" self-registration (and
// doubles as "update my display name" on a repeat call with the same id).
// An instructor persona sits ON TOP OF an existing Digital ID rather than
// being a separate credential system -- self-service signup literally
// means "I already hold a Digital ID from the main app's Backup & Restore,
// let me also register that same ID as an instructor." Auth is always
// re-verified against digital_identities' own pin_hash, same bcrypt+
// lockout block as save-digital-id-backup/restore-digital-id-backup.
Deno.serve(async (req) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ message: 'Server misconfigured: missing Supabase service credentials.' }, 500)
    }

    const { digitalId, pin, displayName } = await req.json()

    if (typeof digitalId !== 'string' || !digitalId.trim()) {
      return jsonResponse({ message: 'Missing digitalId.' }, 400)
    }
    if (typeof pin !== 'string' || !pin) {
      return jsonResponse({ message: 'Missing pin.' }, 400)
    }
    if (typeof displayName !== 'string' || !displayName.trim()) {
      return jsonResponse({ message: 'Enter a display name (how students/your roster will see you).' }, 400)
    }

    const headers = {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      'Content-Type': 'application/json',
    }

    const selectRes = await fetch(
      `${supabaseUrl}/rest/v1/digital_identities?digital_id=eq.${encodeURIComponent(digitalId)}&select=pin_hash,failed_attempts,locked_until`,
      { headers },
    )
    if (!selectRes.ok) {
      return jsonResponse({ message: 'Could not look up this Digital ID.' }, 502)
    }
    const rows = await selectRes.json()
    const row = rows?.[0]
    // Unlike restore/attach (login-guessing surfaces, kept deliberately
    // generic), this is a signup step -- a bit more guidance is safe and
    // genuinely helpful, since the real fix is "go create one first."
    if (!row) {
      return jsonResponse({ message: "That Digital ID doesn't exist yet. Create one first in the main app under Profile -> Backup & Restore -> Back Up via Digital ID, then come back here." }, 401)
    }
    if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
      return jsonResponse({ message: 'This Digital ID is temporarily locked. Please wait and try again.' }, 401)
    }

    const matches = await bcrypt.compare(pin, row.pin_hash)
    if (!matches) {
      const newFailedAttempts = (row.failed_attempts || 0) + 1
      const lockedUntil = newFailedAttempts >= MAX_FAILED_ATTEMPTS
        ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString()
        : null
      await fetch(`${supabaseUrl}/rest/v1/digital_identities?digital_id=eq.${encodeURIComponent(digitalId)}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ failed_attempts: newFailedAttempts, locked_until: lockedUntil }),
      })
      return jsonResponse({ message: 'That PIN is incorrect.' }, 401)
    }

    // Reset any stale failure count now that the PIN's been proven correct
    // (same reasoning as restore-digital-id-backup's success path).
    await fetch(`${supabaseUrl}/rest/v1/digital_identities?digital_id=eq.${encodeURIComponent(digitalId)}`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ failed_attempts: 0, locked_until: null }),
    })

    const upsertRes = await fetch(`${supabaseUrl}/rest/v1/instructors?on_conflict=digital_id`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ digital_id: digitalId, display_name: displayName.trim(), updated_at: new Date().toISOString() }),
    })
    if (!upsertRes.ok) {
      const errText = await upsertRes.text()
      return jsonResponse({ message: `Could not register as an instructor: ${errText.slice(0, 300)}` }, 502)
    }
    const upserted = await upsertRes.json()

    return jsonResponse({ digitalId, displayName: upserted?.[0]?.display_name ?? displayName.trim() })
  } catch (err) {
    return jsonResponse({ message: err instanceof Error ? err.message : 'Unexpected error registering as an instructor.' }, 500)
  }
})
