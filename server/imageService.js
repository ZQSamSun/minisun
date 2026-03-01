// Image generation using @google/genai
// Tries Imagen (generateImages) first, then Gemini (generateContent) as fallback

const { GoogleGenAI, Modality } = require('@google/genai');

const apiKey = process.env.GEMINI_API_KEY || process.env.REACT_APP_GEMINI_API_KEY || '';
const ai = new GoogleGenAI({ apiKey });

// Imagen models - try in order; override via IMAGE_MODEL env
const IMAGEN_MODELS = process.env.IMAGE_MODEL
  ? [process.env.IMAGE_MODEL]
  : ['imagen-4.0-generate-001', 'imagen-3.0-generate-002'];
// Gemini fallback - supports responseModalities for image output
const GEMINI_IMAGE_MODEL = 'gemini-2.0-flash-exp-image-generation';

function rephraseForSafety(prompt) {
  if (!prompt || typeof prompt !== 'string') return prompt;
  return prompt
    .replace(/\breal\s+person\b/gi, 'a person')
    .replace(/\breal\s+people\b/gi, 'people')
    .replace(/\breal\s+human\b/gi, 'a person')
    .replace(/\breal\s+humans\b/gi, 'people')
    .replace(/\bactual\s+person\b/gi, 'a person')
    .trim();
}

async function generateWithImagen(prompt, model) {
  const response = await ai.models.generateImages({
    model,
    prompt,
    config: { numberOfImages: 1 },
  });
  const img = response.generatedImages?.[0]?.image;
  if (img?.imageBytes) {
    return { mimeType: img.mimeType || 'image/png', data: img.imageBytes };
  }
  if (response.generatedImages?.[0]?.raiFilteredReason) {
    throw new Error(`Content filtered: ${response.generatedImages[0].raiFilteredReason}`);
  }
  throw new Error('No image in Imagen response');
}

async function generateWithGemini(prompt, anchorImageBase64, anchorMimeType) {
  const contents = anchorImageBase64
    ? [
        { text: prompt },
        { inlineData: { mimeType: anchorMimeType || 'image/png', data: anchorImageBase64 } },
      ]
    : prompt;

  const response = await ai.models.generateContent({
    model: GEMINI_IMAGE_MODEL,
    contents,
    config: {
      responseModalities: [Modality.TEXT, Modality.IMAGE],
      responseMimeType: 'image/png',
    },
  });

  const parts = response.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    if (p.inlineData?.data) {
      return { mimeType: p.inlineData.mimeType || 'image/png', data: p.inlineData.data };
    }
  }
  const blockReason = response.promptFeedback?.blockReason;
  throw new Error(blockReason ? `Content blocked: ${blockReason}` : 'No image in response');
}

async function generateImage(prompt, anchorImageBase64 = null, anchorMimeType = 'image/png') {
  const safePrompt = rephraseForSafety(prompt);
  const apiPrompt = `Generate an image: ${safePrompt}`;

  // If anchor image provided, use Gemini (Imagen generateImages doesn't support reference images)
  if (anchorImageBase64) {
    try {
      return await generateWithGemini(apiPrompt, anchorImageBase64, anchorMimeType);
    } catch (err) {
      console.error('[generateImage] Gemini (with anchor) Error:', err.message);
      return {
        error: `Image generation failed: ${err.message}. Try without a reference image.`,
      };
    }
  }

  // Try Imagen first (dedicated API, most reliable)
  for (const model of IMAGEN_MODELS) {
    try {
      return await generateWithImagen(apiPrompt, model);
    } catch (err) {
      console.warn(`[generateImage] Imagen ${model} failed:`, err.message);
    }
  }

  // Fallback to Gemini
  try {
    return await generateWithGemini(apiPrompt, null, null);
  } catch (err) {
    console.error('[generateImage] Gemini fallback Error:', err.message);
    const hint = /real\s+person|content|policy|safety|block/i.test(err.message || '')
      ? ' Try using "a person" instead of "a real person".'
      : '';
    return { error: `Image generation failed: ${err.message || 'Unknown error'}.${hint}` };
  }
}

module.exports = { generateImage };
