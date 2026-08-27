import { handleOptions, jsonResponse } from '../_shared/cors.ts'

const GEMINI_MODEL = 'gemini-3.1-flash-lite'

function parseDataUrl(dataUrl: string, fallbackMimeType: string) {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) return { mimeType: fallbackMimeType, data: dataUrl }
  return { mimeType: match[1], data: match[2] }
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req)
  if (preflight) return preflight

  try {
    const { images = [], geminiApiKey = '' } = await req.json()

    if (!geminiApiKey.trim()) {
      return jsonResponse({ message: 'Add your Gemini API key in Profile before using Read Aloud.' }, 400)
    }
    if (!Array.isArray(images) || images.length === 0) {
      return jsonResponse({ message: 'Provide at least one page photo.' }, 400)
    }

    const promptText = [
      'You are transcribing photographed page(s) of a book/notes for a text-to-speech reader.',
      'Transcribe every word of body text exactly as written, in natural reading order, across all provided images in order.',
      'Skip page numbers, running headers/footers, and figure/caption labels unless they are the only content on the page.',
      'Join hyphenated words split across a line break back into a single word. Join lines into normal flowing paragraphs (do not preserve line breaks within a paragraph).',
      'Return only the transcribed text itself -- no commentary, no markdown, no quotes around it.',
    ].join('\n')

    const parts: Record<string, unknown>[] = [{ text: promptText }]
    for (const image of images) {
      const { mimeType, data } = parseDataUrl(image.dataUrl, image.mimeType || 'image/jpeg')
      parts.push({ inline_data: { mime_type: mimeType, data } })
    }

    const requestBody = {
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.1 },
    }

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      }
    )

    if (!geminiRes.ok) {
      const errText = await geminiRes.text()
      return jsonResponse({ message: `Gemini request failed: ${errText.slice(0, 300)}` }, 502)
    }

    const geminiJson = await geminiRes.json()
    const rawText = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!rawText || !rawText.trim()) {
      return jsonResponse({ message: 'Gemini could not read any text from the photo(s). Try a clearer, well-lit shot.' }, 502)
    }

    return jsonResponse({ text: rawText.trim() })
  } catch (err) {
    return jsonResponse({ message: err instanceof Error ? err.message : 'Unexpected error transcribing the page(s).' }, 500)
  }
})
