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

from ..config import DETECTOR_MODEL, IS_SERVERLESS, MODEL_THREADS, RECOGNIZER_MODEL, RECOGNIZER_SHA256, RECOGNIZER_URL

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
    thumb: bytes | None = None  # 112x112 aligned crop (JPEG) for the admin People view


# ── Models ──────────────────────────────────────────────────────────────────

_model_lock = threading.Lock()


def ensure_model() -> None:
    """Download the recognizer on first run and verify its checksum."""
    with _model_lock:
        if not RECOGNIZER_MODEL.exists():
            data = _fetch_model()
            RECOGNIZER_MODEL.parent.mkdir(parents=True, exist_ok=True)
            tmp = RECOGNIZER_MODEL.with_suffix(".part")
            tmp.write_bytes(data)
            tmp.replace(RECOGNIZER_MODEL)


def _fetch_model() -> bytes:
    """The 261 MB AuraFace model, downloaded and checksum-verified, in memory."""
    log.info("Downloading AuraFace model (261 MB) from %s", RECOGNIZER_URL)
    data = bytearray()
    with httpx.stream("GET", RECOGNIZER_URL, follow_redirects=True, timeout=120) as res:
        res.raise_for_status()
        for chunk in res.iter_bytes(1 << 20):
            data += chunk
    if hashlib.sha256(data).hexdigest() != RECOGNIZER_SHA256:
        raise RuntimeError("AuraFace download is corrupt (checksum mismatch)")
    return bytes(data)


def loaded() -> bool:
    return _session is not None


def load() -> None:
    global _session
    if _session is not None:
        return
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = MODEL_THREADS
    # ONNX Runtime sessions are thread-safe for run(): one copy serves both pools.
    if IS_SERVERLESS:
        # Vercel unpacks the Python packages into /tmp, leaving no room for a 261 MB
        # file there: load the model straight from memory instead.
        with _model_lock:
            if _session is not None:
                return
            for leftover in RECOGNIZER_MODEL.parent.glob("*.part"):
                leftover.unlink(missing_ok=True)  # half-written files from older builds
            _session = ort.InferenceSession(_fetch_model(), opts, providers=["CPUExecutionProvider"])
    else:
        ensure_model()
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
    crops = [_align(img, f[4:14]) for f in faces]
    vectors = _embed(crops)
    return [
        Face(vec.astype(np.float32), tuple(int(v) for v in f[:4]), round(float(f[14]), 3), _jpeg(crop))
        for vec, f, crop in zip(vectors, faces, crops)
    ]


def _jpeg(crop: np.ndarray) -> bytes:
    return cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 82])[1].tobytes()


def _faces_any(img: np.ndarray) -> np.ndarray:
    for threshold in SELFIE_THRESHOLDS:
        faces = _detect(img, threshold)
        if len(faces):
            return faces
    return np.empty((0, 15), dtype=np.float32)


# ── Selfie quality coach ────────────────────────────────────────────────────
# Calibrated on phone selfies and event photos: below these the match rate drops.
DARK_LUMA = 55
BRIGHT_LUMA = 190
BLUR_VAR = 50          # contrast-normalised Laplacian variance (event faces: 2nd pct 67; sharp selfie ~210)
SMALL_FACE = 0.16      # face width / shorter image side
SMALL_FACE_PX = 90
YAW_LIMIT = 0.38       # nose offset from the eye midpoint / eye distance (frontal < 0.1, profile > 0.5)

_MESSAGES = {
    "dark": "It's a bit dark. Face a window or a light and try again.",
    "bright": "Too much light on your face. Step out of direct sun or flash.",
    "blurry": "The selfie is blurry. Hold the phone steady for a second.",
    "small": "Your face is small in the picture. Move the camera closer.",
    "angle": "Look straight at the camera, not to the side.",
    "multiple": "Several faces are in the picture. We used the biggest one: take a selfie of just you.",
    "partial": "Part of your face is cut off. Keep your whole face in the frame.",
}


@dataclass
class SelfieQuality:
    faces: int
    issues: list[str]

    def to_json(self) -> dict:
        penalty = {"dark": 25, "bright": 20, "blurry": 30, "small": 20, "angle": 20, "multiple": 10, "partial": 20}
        score = max(0, 100 - sum(penalty.get(code, 10) for code in self.issues))
        return {"score": score, "faces": self.faces,
                "issues": [{"code": code, "message": _MESSAGES[code]} for code in self.issues]}


def _sharpness(gray: np.ndarray) -> float:
    """Laplacian variance after normalising contrast, so dark faces don't read as blurry."""
    inner = gray[16:104, 16:96].astype(np.float32)
    norm = (inner - inner.mean()) / (inner.std() + 1e-3) * 40
    return float(cv2.Laplacian(norm, cv2.CV_32F).var())


def _quality(img: np.ndarray, faces: np.ndarray, face: np.ndarray, crop: np.ndarray) -> SelfieQuality:
    issues: list[str] = []
    h, w = img.shape[:2]
    x, y, fw, fh = face[:4]
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    # Brightness of the inner face only (the aligned crop's border can be black fill).
    luma = float(gray[20:100, 24:88].mean())
    if luma < DARK_LUMA:
        issues.append("dark")
    elif luma > BRIGHT_LUMA:
        issues.append("bright")
    if _sharpness(gray) < BLUR_VAR:
        issues.append("blurry")
    if fw < SMALL_FACE_PX or fw / min(h, w) < SMALL_FACE:
        issues.append("small")
    eyes = face[4:8].reshape(2, 2)
    eye_dist = float(np.linalg.norm(eyes[1] - eyes[0])) or 1.0
    if abs(face[8] - eyes[:, 0].mean()) / eye_dist > YAW_LIMIT:
        issues.append("angle")
    if x < -fw * 0.08 or y < -fh * 0.08 or x + fw > w * 1.02 or y + fh > h * 1.02:
        issues.append("partial")
    # Other faces at least 60% as wide as the main one are real people, not background.
    if sum(1 for f in faces if f[2] >= 0.6 * fw) > 1:
        issues.append("multiple")
    return SelfieQuality(len(faces), issues)


def selfie_vectors(data: bytes) -> tuple[np.ndarray | None, SelfieQuality | None]:
    """The selfie's main face as original, CLAHE and mirrored vectors, plus a quality report.

    Front cameras mirror the picture and phone lighting differs from the
    photographer's, so matching takes the best score over the variants.
    Returns (None, quality-or-None) when no face is found.
    """
    img = decode(data)
    if img is None:
        return None, None
    faces = _faces_any(img)
    if not len(faces):
        enhanced = _enhance(img)
        faces = _faces_any(enhanced)
        if not len(faces):
            luma = float(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).mean())
            hint = ["dark"] if luma < DARK_LUMA else ["bright"] if luma > BRIGHT_LUMA else []
            return None, SelfieQuality(0, hint)
    face = max(faces, key=lambda f: f[2] * f[3])
    crops = [_align(img, face[4:14]), _align(_enhance(img), face[4:14])]
    crops.append(cv2.flip(crops[0], 1))
    return _embed(crops).astype(np.float32), _quality(img, faces, face, crops[0])
