/**
 * faceEmbeddingService.ts
 *
 * Pure-JavaScript face embedding extraction and matching.
 * Uses cosine similarity (128-d ArcFace descriptors from face-api.js).
 *
 * On Vercel serverless: this module provides the matchDescriptor() function.
 * Face extraction on server-side is skipped (models too heavy for serverless).
 * Instead, descriptors are extracted in-browser by the frontend.
 */

// ── Cosine Similarity ─────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Euclidean distance (lower = more similar, face-api.js default threshold = 0.6)
function euclideanDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] - b[i]) ** 2;
  }
  return Math.sqrt(sum);
}

// ── Matching ──────────────────────────────────────────────────────────────────

export interface FaceMatch {
  name: string;
  thumbUrl: string;
  score: number;
  confidence: "high" | "medium" | "low";
}

/**
 * Default face-api.js threshold: 0.6 (euclidean distance).
 * Lower = stricter matching. 0.5 gives good precision for event photos.
 */
const DISTANCE_THRESHOLD = 0.55;

/**
 * Match a selfie descriptor (array of 128 numbers from browser face-api)
 * against a list of pre-computed event photo descriptors.
 * Pure JS math — runs on Vercel serverless with zero dependencies.
 */
export function matchDescriptor(
  selfieDescriptor: number[],
  candidates: { name: string; thumbUrl: string; descriptors: number[][] }[]
): FaceMatch[] {
  if (!selfieDescriptor || selfieDescriptor.length !== 128) return [];
  const results: FaceMatch[] = [];

  for (const candidate of candidates) {
    if (!candidate.descriptors || candidate.descriptors.length === 0) continue;

    let bestDist = Infinity;
    for (const desc of candidate.descriptors) {
      const dist = euclideanDistance(selfieDescriptor, desc);
      if (dist < bestDist) bestDist = dist;
    }

    if (bestDist <= DISTANCE_THRESHOLD) {
      // Convert distance to a 0–1 similarity score for display
      const score = Math.max(0, 1 - bestDist / DISTANCE_THRESHOLD);
      const confidence: "high" | "medium" | "low" =
        bestDist <= 0.35 ? "high" :
        bestDist <= 0.48 ? "medium" : "low";

      results.push({
        name: candidate.name,
        thumbUrl: candidate.thumbUrl,
        score: parseFloat(score.toFixed(4)),
        confidence,
      });
    }
  }

  // Best match first
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ── Server-side descriptor extraction (optional, not used on Vercel) ──────────
// Descriptors are computed in-browser by the frontend using face-api.js WASM.
// Server-side extraction here is a no-op placeholder to keep the import chain clean.
export async function extractDescriptorsFromBuffer(_buf: Buffer): Promise<number[][]> {
  // Server-side face-api.js requires @tensorflow/tfjs-node (native bindings)
  // which cannot be compiled without Visual Studio on Windows.
  // All embedding extraction is done in the browser — see frontend/src/lib/faceDetection.js.
  return [];
}
