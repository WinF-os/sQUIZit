import { handleOptions, jsonResponse } from '../_shared/cors.ts'

// Shared server-side key (Profile > Read Aloud has no BYOK field for this --
// one Azure Speech key, paid for by nobody since usage stays inside the free
// F0 tier (500K chars/month), set once via
// `npx supabase secrets set AZURE_SPEECH_KEY=... AZURE_SPEECH_REGION=...`).
const AZURE_SPEECH_KEY = Deno.env.get('AZURE_SPEECH_KEY') ?? ''
const AZURE_SPEECH_REGION = Deno.env.get('AZURE_SPEECH_REGION') ?? ''

// Azure's REST TTS endpoint hard-caps SSML input around 10 minutes of audio
// worth of text; the client chunks long transcripts well under that and
// calls this function once per chunk, but a byte cap is enforced here too
// as a safety net.
const MAX_TEXT_BYTES = 4800

function escapeSsml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight

  try {
    if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
      return jsonResponse({ message: 'Read Aloud is not configured yet (missing server TTS key).' }, 500)
    }

    const { text = '', voice = 'en-US-AndrewNeural' } = await req.json()
    if (!text.trim()) {
      return jsonResponse({ message: 'No text provided to read aloud.' }, 400)
    }
    if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) {
      return jsonResponse({ message: 'This chunk of text is too long for one request.' }, 400)
    }

    const tokenRes = await fetch(
      `https://${AZURE_SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
      { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY, 'Content-Length': '0' } }
    )
    if (!tokenRes.ok) {
      const errText = await tokenRes.text()
      return jsonResponse({ message: `Azure auth failed: ${errText.slice(0, 300)}` }, 502)
    }
    const accessToken = await tokenRes.text()

    const ssml = `<speak version='1.0' xml:lang='en-US'><voice xml:lang='en-US' name='${voice}'>${escapeSsml(text)}</voice></speak>`

    const ttsRes = await fetch(
      `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
          'User-Agent': 'sQUIZit',
        },
        body: ssml,
      }
    )

    if (!ttsRes.ok) {
      const errText = await ttsRes.text()
      return jsonResponse({ message: `Text-to-speech request failed: ${errText.slice(0, 300)}` }, 502)
    }

    const audioBuffer = await ttsRes.arrayBuffer()
    if (!audioBuffer.byteLength) {
      return jsonResponse({ message: 'Text-to-speech returned no audio.' }, 502)
    }

    return jsonResponse({ audioContent: arrayBufferToBase64(audioBuffer) })
  } catch (err) {
    return jsonResponse({ message: err instanceof Error ? err.message : 'Unexpected error generating audio.' }, 500)
  }
})
