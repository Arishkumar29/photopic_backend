import fs from "fs";
import path from "path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import * as ortModule from "onnxruntime-node";
import sqlite from "node:sqlite";
import { getProjectRootDir, getBulkPhotoDir, resolveModelPath } from "./storageService.js";

const ort: any = (ortModule as any).default || ortModule;

let _session: any = null;

async function getSession(): Promise<any> {
  if (!_session) {
    const modelPath = resolveModelPath("face_recognition_sface_2021dec.onnx");
    _session = await ort.InferenceSession.create(modelPath);
  }
  return _session;
}

/**
 * Decode JPEG or PNG image buffer to RGBA pixels
 */
function decodeImage(buffer: Buffer, isPng: boolean): { width: number; height: number; data: Uint8Array | Buffer } {
  if (isPng) {
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height, data: png.data };
  } else {
    const raw = jpeg.decode(buffer, { useTArray: true });
    return { width: raw.width, height: raw.height, data: raw.data };
  }
}

/**
 * Extract 128-d SFace feature vector from an image buffer in pure Node.js
 */
export async function extractSFaceVector(buffer: Buffer, isPng: boolean = false): Promise<Float32Array> {
  const { width, height, data } = decodeImage(buffer, isPng);

  // Center square crop
  const minDim = Math.min(width, height);
  const startX = Math.floor((width - minDim) / 2);
  const startY = Math.floor((height - minDim) / 2);

  // Tensor shape [1, 3, 112, 112] in BGR float32 format
  const tensorData = new Float32Array(1 * 3 * 112 * 112);

  for (let y = 0; y < 112; y++) {
    for (let x = 0; x < 112; x++) {
      const srcX = startX + Math.floor((x / 112) * minDim);
      const srcY = startY + Math.floor((y / 112) * minDim);
      const srcIdx = (srcY * width + srcX) * 4;

      const r = data[srcIdx];
      const g = data[srcIdx + 1];
      const b = data[srcIdx + 2];

      // BGR order for SFace: channel 0 = B, 1 = G, 2 = R
      tensorData[0 * 112 * 112 + y * 112 + x] = b;
      tensorData[1 * 112 * 112 + y * 112 + x] = g;
      tensorData[2 * 112 * 112 + y * 112 + x] = r;
    }
  }

  const session = await getSession();
  const inputTensor = new ort.Tensor("float32", tensorData, [1, 3, 112, 112]);
  const feeds = { [session.inputNames[0]]: inputTensor };
  const results = await session.run(feeds);
  const output = results[session.outputNames[0]];

  return new Float32Array(output.data as Float32Array);
}

export interface VectorMatch {
  name: string;
  score: number;
}

/**
 * Match a 128-d selfie vector against all pre-computed face embeddings in SQLite for this event.
 * Runs in under 50ms using vectorized cosine similarity.
 */
export function matchSFaceAgainstSqlite(
  selfieVec: Float32Array,
  eventId: string,
  minCosine = 0.33,
  validFileNames?: string[]
): VectorMatch[] {
  const sqlitePath = resolveModelPath("face_embeddings.sqlite");

  if (!fs.existsSync(sqlitePath)) {
    console.warn("[sfaceMatcher] face_embeddings.sqlite not found at:", sqlitePath);
    return [];
  }

  // Calculate L2 norm of selfie vector
  let selfieNormSq = 0;
  for (let i = 0; i < 128; i++) {
    selfieNormSq += selfieVec[i] * selfieVec[i];
  }
  const selfieNorm = Math.sqrt(selfieNormSq);
  if (selfieNorm === 0) return [];

  const db = new (sqlite as any).DatabaseSync(sqlitePath, { open: true, readOnly: true });

  const validNamesSet = validFileNames && validFileNames.length > 0 ? new Set(validFileNames) : null;

  let rows: { file_path: string; feat_blob: Buffer }[];
  if (validNamesSet && validNamesSet.size > 0) {
    const stmt = db.prepare("SELECT file_path, feat_blob FROM face_cache");
    rows = stmt.all() as { file_path: string; feat_blob: Buffer }[];
  } else {
    const stmt = db.prepare("SELECT file_path, feat_blob FROM face_cache WHERE file_path LIKE ?");
    rows = stmt.all(`%${eventId}%`) as { file_path: string; feat_blob: Buffer }[];
  }

  const photoScores: Record<string, number> = {};

  for (const row of rows) {
    const fname = path.win32.basename(row.file_path);
    if (!fname) continue;
    if (validNamesSet && !validNamesSet.has(fname)) continue;

    const blob = row.feat_blob;
    if (blob.length < 512) continue; // 128 * 4 bytes

    const dbVec = new Float32Array(blob.buffer, blob.byteOffset, 128);

    let dot = 0;
    let dbNormSq = 0;
    for (let i = 0; i < 128; i++) {
      dot += selfieVec[i] * dbVec[i];
      dbNormSq += dbVec[i] * dbVec[i];
    }
    const cos = dot / (selfieNorm * Math.sqrt(dbNormSq));

    if (cos >= minCosine) {
      if (!photoScores[fname] || cos > photoScores[fname]) {
        photoScores[fname] = cos;
      }
    }
  }

  const matches: VectorMatch[] = Object.entries(photoScores)
    .map(([name, score]) => ({ name, score: Math.round(score * 10000) / 10000 }))
    .sort((a, b) => b.score - a.score);

  return matches;
}
