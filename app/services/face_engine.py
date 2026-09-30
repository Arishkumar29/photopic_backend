"""Face detection (YuNet) and recognition (AuraFace / ArcFace ResNet100).

Measured on the GWC event photos (see README "Face matching"): AuraFace keeps a
0.15 cosine gap between the weakest genuine match and the strongest impostor
across two events, where OpenCV's SFace left 0.04. Look-alike siblings and
children were SFace's main source of wrong photos.
"""
import asyncio
import hashlib
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import cv2
import httpx
import numpy as np
import onnxruntime as ort

from ..config import DETECTOR_MODEL, MODEL_THREADS, RECOGNIZER_MODEL, RECOGNIZER_SHA256, RECOGNIZER_URL

log = logging.getLogger("face_engine")

MAX_SIDE = 2048
# Faces narrower than this (at <= 2048 px) are background crowd: too few pixels to
# identify anyone, and their noisy vectors were the largest source of false matches.
MIN_FACE_PX = 40
MIN_PHOTO_SCORE = 0.8
SELFIE_THRESHOLDS = (0.6, 0.4, 0.25)

# ArcFace 112x112 landmark template; YuNet returns landmarks in this same order.
_TEMPLATE = np.array(
    [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]]
)

_local = threading.local()
_session: ort.InferenceSession | None = None
_scan_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="scan")
_index_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="index")


@dataclass
class Face:
    vector: np.ndarray  # L2-normalised, 512-d
    box: tuple[int, int, int, int]
    score: float


# ── Models ──────────────────────────────────────────────────────────────────

def ensure_model() -> None:
    """Download the recognizer on first run and verify its checksum."""
    if RECOGNIZER_MODEL.exists():
        return
    log.info("Downloading AuraFace model (261 MB) from %s", RECOGNIZER_URL)
    tmp = RECOGNIZER_MODEL.with_suffix(".part")
    digest = hashlib.sha256()
    with httpx.stream("GET", RECOGNIZER_URL, follow_redirects=True, timeout=120) as res:
        res.raise_for_status()
        with open(tmp, "wb") as fh:
            for chunk in res.iter_bytes(1 << 20):
                fh.write(chunk)
                digest.update(chunk)
    if digest.hexdigest() != RECOGNIZER_SHA256:
        tmp.unlink(missing_ok=True)
        raise RuntimeError("AuraFace download is corrupt (checksum mismatch)")
    tmp.replace(RECOGNIZER_MODEL)


def load() -> None:
    global _session
    ensure_model()
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = MODEL_THREADS
    # ONNX Runtime sessions are thread-safe for run(): one copy serves both pools.
    _session = ort.InferenceSession(str(RECOGNIZER_MODEL), opts, providers=["CPUExecutionProvider"])
    _index_pool.submit(_detector).result()
    _scan_pool.submit(_detector).result()


def shutdown() -> None:
    _scan_pool.shutdown(wait=False, cancel_futures=True)
    _index_pool.shutdown(wait=False, cancel_futures=True)


async def run_scan(fn, *args):
    return await asyncio.get_running_loop().run_in_executor(_scan_pool, fn, *args)


async def run_index(fn, *args):
    return await asyncio.get_running_loop().run_in_executor(_index_pool, fn, *args)


def _detector():
    # The YuNet object is stateful (input size, threshold), so one per thread.
    if not hasattr(_local, "detector"):
        _local.detector = cv2.FaceDetectorYN.create(str(DETECTOR_MODEL), "", (320, 320), score_threshold=0.5)
    return _local.detector


# ── Pipeline ────────────────────────────────────────────────────────────────

def decode(data: bytes) -> np.ndarray | None:
    img = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None or min(img.shape[:2]) < 50:
        return None
    h, w = img.shape[:2]
    if max(h, w) > MAX_SIDE:
        scale = MAX_SIDE / max(h, w)
        img = cv2.resize(img, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
    return img


def _detect(img: np.ndarray, threshold: float) -> np.ndarray:
    detector = _detector()
    detector.setInputSize((img.shape[1], img.shape[0]))
    detector.setScoreThreshold(threshold)
    _, faces = detector.detect(img)
    return faces if faces is not None else np.empty((0, 15), dtype=np.float32)


def _align(img: np.ndarray, landmarks: np.ndarray) -> np.ndarray:
    """Least-squares similarity warp to the ArcFace template (same as OpenCV alignCrop)."""
    src = landmarks.reshape(5, 2).astype(np.float64)
    src_mean, dst_mean = src.mean(0), _TEMPLATE.mean(0)
    s, d = src - src_mean, _TEMPLATE - dst_mean
    u, sigma, vt = np.linalg.svd(d.T @ s / 5)
    flip = np.diag([1.0, -1.0 if np.linalg.det(u) * np.linalg.det(vt) < 0 else 1.0])
    rotation = u @ flip @ vt
    scale = (sigma * np.diag(flip)).sum() / s.var(0).sum()
    matrix = np.hstack([scale * rotation, (dst_mean - scale * rotation @ src_mean)[:, None]])
    return cv2.warpAffine(img, matrix, (112, 112), borderValue=0)


def _embed(crops: list[np.ndarray]) -> np.ndarray:
    blob = np.stack([cv2.cvtColor(c, cv2.COLOR_BGR2RGB) for c in crops]).astype(np.float32)
    blob = ((blob - 127.5) / 127.5).transpose(0, 3, 1, 2)
    name = _session.get_inputs()[0].name
    # The exported graph declares batch 1 on its output, so run faces one by one.
    vectors = np.concatenate([_session.run(None, {name: blob[i:i + 1]})[0] for i in range(len(blob))])
    return vectors / np.linalg.norm(vectors, axis=1, keepdims=True)


def _enhance(img: np.ndarray) -> np.ndarray:
    """CLAHE on luminance: recovers faces in shadow or backlight."""
    l, a, b = cv2.split(cv2.cvtColor(img, cv2.COLOR_BGR2LAB))
    l = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(l)
    return cv2.cvtColor(cv2.merge([l, a, b]), cv2.COLOR_LAB2BGR)


def photo_faces(data: bytes) -> list[Face] | None:
    """Every identifiable face in an event photo. None if the file isn't an image."""
    img = decode(data)
    if img is None:
        return None
    faces = [f for f in _detect(img, MIN_PHOTO_SCORE) if f[2] >= MIN_FACE_PX]
    if not faces:
        return []
    vectors = _embed([_align(img, f[4:14]) for f in faces])
    return [
        Face(vec.astype(np.float32), tuple(int(v) for v in f[:4]), round(float(f[14]), 3))
        for vec, f in zip(vectors, faces)
    ]


def _largest_face(img: np.ndarray) -> np.ndarray | None:
    for threshold in SELFIE_THRESHOLDS:
        faces = _detect(img, threshold)
        if len(faces):
            return max(faces, key=lambda f: f[2] * f[3])
    return None


def selfie_vectors(data: bytes) -> np.ndarray | None:
    """The selfie's main face as original, CLAHE and mirrored vectors (None = no face).

    Front cameras mirror the picture and phone lighting differs from the
    photographer's, so matching takes the best score over the variants.
    """
    img = decode(data)
    if img is None:
        return None
    face = _largest_face(img)
    if face is None:
        face = _largest_face(_enhance(img))
        if face is None:
            return None
    crops = [_align(img, face[4:14]), _align(_enhance(img), face[4:14])]
    crops.append(cv2.flip(crops[0], 1))
    return _embed(crops).astype(np.float32)
