/**
 * faceEmbeddingService.ts
 *
 * Pure-JavaScript face embedding extraction and matching using @vladmandic/face-api
 * with @tensorflow/tfjs (CPU backend — no native bindings, works on Vercel).
 *
 * Used server-side to:
 *   1. Extract 128-d face descriptors from event photos during admin sync.
 *   2. Match an attendee selfie descriptor (sent from browser) against event embeddings.
 */

import * as tf from "@tensorflow/tfjs";
import * as faceapi from "@vladmandic/face-api";
import path from "path";
import { createCanvas, loadImage } from "canvas";

// Path to model weights (bundled in backend/models/faceapi/)
const MODELS_DIR = path.resolve(process.cwd(), "backend", "models", "faceapi");

let _modelsLoaded = false;

async function ensureModels(): Promise<void> {
  if (_modelsLoaded) return;

  // Set TF.js to use CPU backend (pure JS, no native bindings)
  await tf.setBackend("cpu");
  await tf.ready();

  // @ts-ignore — Node.js canvas adapter for face-api
  faceapi.env.monkeyPatch({ Canvas: createCanvas, Image: loadImage, ImageData: (globalThis as any).ImageData } as any);

  await faceapi.nets.tinyFaceDetector.loadFromDisk(MODELS_DIR);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_DIR);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_DIR);

  _modelsLoaded = true;
  console.log("[faceEmbeddingService] Models loaded from disk.");
}

// ── Descriptor extraction ─────────────────────────────────────────────────────

/**
 * Extract all 128-d face descriptors from an image buffer.
 * Returns one descriptor per face detected. Empty array if no faces found.
 */
export async function extractDescriptorsFromBuffer(
  imageBuffer: Buffer
): Promise<number[][]> {
  try {
    await ensureModels();

    // Load image using node-canvas
    const img = await loadImage(imageBuffer);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img as any, 0, 0);

    const detections = await faceapi
      .detectAllFaces(canvas as any, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptors();

    if (!detections || detections.length === 0) return [];

    return detections.map(d => Array.from(d.descriptor));
  } catch (err) {
    console.warn("[faceEmbeddingService] extractDescriptorsFromBuffer error:", err);
    return [];
  }
}

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

// Euclidean distance (lower = more similar)
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

const DISTANCE_THRESHOLD = 0.6; // face-api.js default: 0.6 (lower = stricter)
const COSINE_THRESHOLD = 0.5;   // lower cosine = stricter

/**
 * Match a selfie descriptor (array of 128 numbers from browser face-api)
 * against a list of pre-computed event photo descriptors.
 */
export function matchDescriptor(
  selfieDescriptor: number[],
  candidates: { name: string; thumbUrl: string; descriptors: number[][] }[]
): FaceMatch[] {
  const results: FaceMatch[] = [];

  for (const candidate of candidates) {
    if (!candidate.descriptors || candidate.descriptors.length === 0) continue;

    let bestScore = -1;
    let bestDist = Infinity;

    for (const desc of candidate.descriptors) {
      const dist = euclideanDistance(selfieDescriptor, desc);
      const cos = cosineSimilarity(selfieDescriptor, desc);
      if (dist < bestDist) {
        bestDist = dist;
        bestScore = cos;
      }
    }

    if (bestDist <= DISTANCE_THRESHOLD) {
      const confidence: "high" | "medium" | "low" =
        bestDist <= 0.40 ? "high" :
        bestDist <= 0.52 ? "medium" : "low";

      results.push({
        name: candidate.name,
        thumbUrl: candidate.thumbUrl,
        score: parseFloat(bestScore.toFixed(4)),
        confidence,
      });
    }
  }

  // Sort: best match first (lowest euclidean distance = highest similarity)
  results.sort((a, b) => b.score - a.score);
  return results;
}
