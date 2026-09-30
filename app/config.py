import os
import tempfile
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

BACKEND_DIR = Path(__file__).resolve().parent.parent
MODELS_DIR = BACKEND_DIR / "models"
IS_SERVERLESS = bool(os.getenv("VERCEL") or os.getenv("AWS_LAMBDA_FUNCTION_NAME"))

# Everything the server writes (events, face index, analytics). Point this at a
# persistent disk in production, otherwise every redeploy starts empty.
DATA_DIR = Path(os.getenv("DATA_DIR") or (Path(tempfile.gettempdir()) / "photopic" if IS_SERVERLESS else BACKEND_DIR / "data"))
DB_PATH = DATA_DIR / "photopic.sqlite"
EVENTS_FILE = DATA_DIR / "events.json"

MONGODB_URI = os.getenv("MONGODB_URI", "")

DETECTOR_MODEL = MODELS_DIR / "face_detection_yunet_2023mar.onnx"
# AuraFace (ArcFace ResNet100, Apache-2.0). 261 MB, so it is downloaded, not committed.
RECOGNIZER_MODEL = MODELS_DIR / "auraface_glintr100.onnx"
RECOGNIZER_URL = "https://huggingface.co/fal/AuraFace-v1/resolve/main/glintr100.onnx"
RECOGNIZER_SHA256 = "a7933ea5330113b01c9b60351d8f4c33003f145d8470ac5f0e52ee2effe25c60"

# CPU threads per model call (half the cores, 2..8: measured ~35% faster at 8 than 2).
# Scans and indexing run in separate pools, so a scan never waits behind indexing.
MODEL_THREADS = int(os.getenv("MODEL_THREADS") or min(8, max(2, (os.cpu_count() or 2) // 2)))

SCAN_RATE_LIMIT = 30  # scans per IP per minute

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
