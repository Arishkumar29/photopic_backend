import os
import sys
import json
import glob
import cv2
import time
import numpy as np
import sqlite3

# ─── Globals ───
_YUNET_DETECTOR = None
_SFACE_RECOGNIZER = None
_SQLITE_CONN = None

# ═══════════════════════════════════════════════════════════════════════════════
#  SQLite Embedding Cache
# ═══════════════════════════════════════════════════════════════════════════════

def get_sqlite_conn():
    global _SQLITE_CONN
    if _SQLITE_CONN is not None:
        return _SQLITE_CONN
    try:
        model_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "models"))
        os.makedirs(model_dir, exist_ok=True)
        db_path = os.path.join(model_dir, "face_embeddings.sqlite")
        _SQLITE_CONN = sqlite3.connect(db_path, check_same_thread=False)
        cursor = _SQLITE_CONN.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS face_cache (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT NOT NULL,
                face_index INTEGER NOT NULL,
                feat_blob BLOB NOT NULL,
                file_mtime REAL NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(file_path, face_index)
            );
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_fc_path ON face_cache(file_path);")
        _SQLITE_CONN.commit()
        return _SQLITE_CONN
    except Exception as e:
        sys.stderr.write(f"SQLite DB init error: {str(e)}\n")
        return None


def get_cached_faces(file_path, current_mtime):
    """Return list of (feat_array,) tuples from cache if mtime matches, else empty list."""
    conn = get_sqlite_conn()
    if conn is None:
        return []
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT feat_blob, file_mtime FROM face_cache WHERE file_path = ? ORDER BY face_index",
            (file_path,)
        )
        rows = cursor.fetchall()
        if not rows:
            return []
        # If the file was modified since caching, invalidate
        if abs(rows[0][1] - current_mtime) > 1.0:
            cursor.execute("DELETE FROM face_cache WHERE file_path = ?", (file_path,))
            conn.commit()
            return []
        feats = []
        for row in rows:
            feat = np.frombuffer(row[0], dtype=np.float32).reshape(1, -1)
            feats.append(feat)
        return feats
    except Exception as e:
        sys.stderr.write(f"SQLite read error for {file_path}: {str(e)}\n")
        return []


def save_cached_faces(file_path, feats, mtime):
    """Save list of feature vectors for all faces in a file."""
    conn = get_sqlite_conn()
    if conn is None:
        return
    try:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM face_cache WHERE file_path = ?", (file_path,))
        for idx, feat in enumerate(feats):
            feat_blob = feat.astype(np.float32).tobytes()
            cursor.execute(
                "INSERT INTO face_cache (file_path, face_index, feat_blob, file_mtime) VALUES (?, ?, ?, ?)",
                (file_path, idx, feat_blob, mtime)
            )
        conn.commit()
    except Exception as e:
        sys.stderr.write(f"SQLite save error for {file_path}: {str(e)}\n")


# ═══════════════════════════════════════════════════════════════════════════════
#  YuNet Face Detector  (SCRFD-like DNN in OpenCV)
# ═══════════════════════════════════════════════════════════════════════════════

def get_yunet_detector(width, height):
    global _YUNET_DETECTOR
    model_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "models"))
    os.makedirs(model_dir, exist_ok=True)
    model_path = os.path.join(model_dir, "face_detection_yunet_2023mar.onnx")

    if not os.path.exists(model_path):
        try:
            import requests
            sys.stderr.write("Downloading YuNet ONNX model…\n")
            url = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
            r = requests.get(url, timeout=30)
            with open(model_path, "wb") as f:
                f.write(r.content)
        except Exception as e:
            sys.stderr.write(f"Failed to download YuNet model: {str(e)}\n")
            return None

    if not os.path.exists(model_path):
        return None

    try:
        if _YUNET_DETECTOR is None:
            _YUNET_DETECTOR = cv2.FaceDetectorYN.create(
                model=model_path,
                config="",
                input_size=(width, height),
                score_threshold=0.6,   # higher threshold = fewer false detections
                nms_threshold=0.3,
                top_k=5000
            )
        else:
            _YUNET_DETECTOR.setInputSize((width, height))
        return _YUNET_DETECTOR
    except Exception as e:
        sys.stderr.write(f"Failed to init YuNet: {str(e)}\n")
        return None


# ═══════════════════════════════════════════════════════════════════════════════
#  SFace Recognizer  (128-d / 512-d ArcFace-like embeddings)
# ═══════════════════════════════════════════════════════════════════════════════

def get_sface_recognizer():
    global _SFACE_RECOGNIZER
    if _SFACE_RECOGNIZER is not None:
        return _SFACE_RECOGNIZER

    model_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "models"))
    os.makedirs(model_dir, exist_ok=True)
    model_path = os.path.join(model_dir, "face_recognition_sface_2021dec.onnx")

    if not os.path.exists(model_path):
        try:
            import requests
            sys.stderr.write("Downloading SFace ONNX model…\n")
            url = "https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx"
            r = requests.get(url, stream=True, timeout=30)
            with open(model_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
        except Exception as e:
            sys.stderr.write(f"Failed to download SFace model: {str(e)}\n")
            return None

    if not os.path.exists(model_path):
        return None

    try:
        _SFACE_RECOGNIZER = cv2.FaceRecognizerSF.create(model_path, "")
        return _SFACE_RECOGNIZER
    except Exception as e:
        sys.stderr.write(f"Failed to init SFace: {str(e)}\n")
        return None


# ═══════════════════════════════════════════════════════════════════════════════
#  Image Preprocessing Helpers
# ═══════════════════════════════════════════════════════════════════════════════

def preprocess_for_detection(img, max_size=1024):
    """Resize for detection speed, return (resized_img, scale)."""
    h, w = img.shape[:2]
    scale = 1.0
    if max(h, w) > max_size:
        scale = max_size / max(h, w)
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    return img, scale


def enhance_image(img):
    """Apply CLAHE + bilateral filter for better face detection under poor lighting."""
    try:
        lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        l = clahe.apply(l)
        lab = cv2.merge([l, a, b])
        enhanced = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)
        return enhanced
    except Exception:
        return img


# ═══════════════════════════════════════════════════════════════════════════════
#  Multi-scale Face Detection
# ═══════════════════════════════════════════════════════════════════════════════

def detect_faces_multiscale(img):
    """Run YuNet at multiple scales to catch faces at various distances.
    Returns list of face arrays in the ORIGINAL image coordinate system."""
    h, w = img.shape[:2]
    all_faces = []
    scales = [1.0]

    # Add a zoomed-in pass if image is large (catches small distant faces)
    if max(h, w) > 1200:
        scales.append(1.5)
    if max(h, w) > 2000:
        scales.append(2.0)

    for s in scales:
        if s == 1.0:
            det_img, down_scale = preprocess_for_detection(img, max_size=1024)
        else:
            # Crop center region and upscale for small-face detection
            ch, cw = int(h * 0.7), int(w * 0.7)
            y_off, x_off = (h - ch) // 2, (w - cw) // 2
            crop = img[y_off:y_off + ch, x_off:x_off + cw]
            det_img = cv2.resize(crop, (int(cw * s), int(ch * s)), interpolation=cv2.INTER_LINEAR)
            down_scale = 1.0  # will adjust manually

        det_h, det_w = det_img.shape[:2]
        detector = get_yunet_detector(det_w, det_h)
        if detector is None:
            continue

        _, faces = detector.detect(det_img)
        if faces is None or len(faces) == 0:
            continue

        for face in faces:
            f = face.copy()
            if s == 1.0:
                if down_scale != 1.0:
                    f[0:14] = f[0:14] / down_scale
            else:
                # Map coordinates back to original image space
                f[0:14] = f[0:14] / s
                # Add offsets for center-crop
                ch2, cw2 = int(h * 0.7), int(w * 0.7)
                y_off2, x_off2 = (h - ch2) // 2, (w - cw2) // 2
                f[0] += x_off2  # x
                f[1] += y_off2  # y
                f[4] += x_off2; f[5] += y_off2   # right eye
                f[6] += x_off2; f[7] += y_off2   # left eye
                f[8] += x_off2; f[9] += y_off2   # nose
                f[10] += x_off2; f[11] += y_off2  # right mouth
                f[12] += x_off2; f[13] += y_off2  # left mouth

            all_faces.append(f)

    if len(all_faces) == 0:
        return []

    # NMS dedup: remove overlapping faces from multi-scale
    return nms_faces(all_faces, iou_threshold=0.4)


def nms_faces(faces, iou_threshold=0.4):
    """Simple IoU-based NMS to remove duplicate detections across scales."""
    if len(faces) <= 1:
        return faces

    boxes = []
    scores = []
    for f in faces:
        x, y, w, h = f[0], f[1], f[2], f[3]
        boxes.append([x, y, x + w, y + h])
        scores.append(f[14] if len(f) > 14 else 0.9)

    boxes = np.array(boxes, dtype=np.float32)
    scores = np.array(scores, dtype=np.float32)
    order = scores.argsort()[::-1]

    keep = []
    while len(order) > 0:
        i = order[0]
        keep.append(i)

        xx1 = np.maximum(boxes[i, 0], boxes[order[1:], 0])
        yy1 = np.maximum(boxes[i, 1], boxes[order[1:], 1])
        xx2 = np.minimum(boxes[i, 2], boxes[order[1:], 2])
        yy2 = np.minimum(boxes[i, 3], boxes[order[1:], 3])

        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        area_i = (boxes[i, 2] - boxes[i, 0]) * (boxes[i, 3] - boxes[i, 1])
        area_j = (boxes[order[1:], 2] - boxes[order[1:], 0]) * (boxes[order[1:], 3] - boxes[order[1:], 1])
        iou = inter / (area_i + area_j - inter + 1e-6)

        remaining = np.where(iou <= iou_threshold)[0]
        order = order[remaining + 1]

    return [faces[i] for i in keep]


# ═══════════════════════════════════════════════════════════════════════════════
#  Extract ALL face embeddings from a single image
# ═══════════════════════════════════════════════════════════════════════════════

def extract_all_face_features(img, recognizer):
    """Detect all faces in an image and return list of SFace feature vectors."""
    faces = detect_faces_multiscale(img)
    if not faces:
        # Try with enhanced image (CLAHE)
        enhanced = enhance_image(img)
        faces = detect_faces_multiscale(enhanced)
        if not faces:
            return []

    feats = []
    for face in faces:
        try:
            aligned = recognizer.alignCrop(img, face)
            feat = recognizer.feature(aligned)
            feats.append(feat)
        except Exception:
            continue
    return feats


# ═══════════════════════════════════════════════════════════════════════════════
#  Extract MULTIPLE embeddings from selfie (flipped + enhanced variants)
# ═══════════════════════════════════════════════════════════════════════════════

def extract_selfie_features(selfie_img, recognizer):
    """Extract robust feature set from selfie: original + enhanced + flipped.
    Returns list of feature vectors for robust matching."""
    feats = []

    # Original
    orig_feats = extract_all_face_features(selfie_img, recognizer)
    if not orig_feats:
        return []
    feats.extend(orig_feats)

    # Enhanced (CLAHE) version
    enhanced = enhance_image(selfie_img)
    enh_feats = extract_all_face_features(enhanced, recognizer)
    feats.extend(enh_feats)

    # Horizontally flipped version (helps with asymmetric faces)
    flipped = cv2.flip(selfie_img, 1)
    flip_feats = extract_all_face_features(flipped, recognizer)
    feats.extend(flip_feats)

    return feats


# ═══════════════════════════════════════════════════════════════════════════════
#  Cosine Similarity (NumPy)
# ═══════════════════════════════════════════════════════════════════════════════

def cosine_similarity(a, b):
    """Compute cosine similarity between two feature vectors."""
    a_flat = a.flatten()
    b_flat = b.flatten()
    dot = np.dot(a_flat, b_flat)
    norm = np.linalg.norm(a_flat) * np.linalg.norm(b_flat)
    if norm < 1e-10:
        return 0.0
    return float(dot / norm)


# ═══════════════════════════════════════════════════════════════════════════════
#  Main Face Matching Engine  (SFace + OpenCV ONLY)
# ═══════════════════════════════════════════════════════════════════════════════

# SFace thresholds calibrated for high accuracy:
# Official OpenCV benchmark: Cosine threshold = 0.363, L2 threshold = 1.128
COSINE_HIGH    = 0.45    # Clear, high-confidence match
COSINE_MEDIUM  = 0.363   # Confident match across different angles/expressions
L2_MAX         = 1.128   # L2 distance limit for same person

def match_faces(selfie_path, image_paths):
    """
    High-accuracy SFace + OpenCV face matching engine.
    - Multi-representation selfie extraction (original + CLAHE-enhanced + flipped)
    - Full face comparison across all candidate faces
    - Dual metric validation (Cosine similarity + L2 norm distance)
    """
    sys.stderr.write(f"[SFace Engine] Starting accurate face matching across {len(image_paths)} images…\n")
    start_time = time.time()

    recognizer = get_sface_recognizer()
    if recognizer is None:
        sys.stderr.write("[SFace Engine] ERROR: Could not initialize SFace recognizer\n")
        return []

    selfie_img = cv2.imread(selfie_path)
    if selfie_img is None:
        sys.stderr.write(f"[SFace Engine] ERROR: Could not read selfie at {selfie_path}\n")
        return []

    # Multi-variant selfie features for invariant recognition
    selfie_feats = extract_selfie_features(selfie_img, recognizer)
    if not selfie_feats:
        h, w = selfie_img.shape[:2]
        det = get_yunet_detector(w, h)
        if det:
            _, s_faces = det.detect(selfie_img)
            if s_faces is not None and len(s_faces) > 0:
                s_faces_sorted = sorted(s_faces, key=lambda f: f[2] * f[3], reverse=True)
                aligned = recognizer.alignCrop(selfie_img, s_faces_sorted[0])
                selfie_feats = [recognizer.feature(aligned)]

    if not selfie_feats:
        sys.stderr.write("[SFace Engine] ERROR: No face detected in selfie\n")
        return []

    sys.stderr.write(f"[SFace Engine] Extracted {len(selfie_feats)} selfie feature vectors for multi-angle matching\n")

    matched_images = []

    for idx, img_path in enumerate(image_paths):
        try:
            if "temp_selfie_" in os.path.basename(img_path):
                continue

            # Check cache first
            mtime = os.path.getmtime(img_path)
            cached_feats = get_cached_faces(img_path, mtime)

            if cached_feats:
                target_feats = cached_feats
            else:
                target_img = cv2.imread(img_path)
                if target_img is None:
                    continue

                target_feats = extract_all_face_features(target_img, recognizer)
                if not target_feats:
                    continue

                # Cache the embeddings
                save_cached_faces(img_path, target_feats, mtime)

            # Step 3: DUAL-METRIC matching across all selfie variants
            best_cosine = -1.0
            best_l2 = 999.0

            for s_feat in selfie_feats:
                for t_feat in target_feats:
                    cos_score = cosine_similarity(s_feat, t_feat)
                    l2_score = float(recognizer.match(s_feat, t_feat, cv2.FaceRecognizerSF_FR_NORM_L2))

                    if cos_score > best_cosine:
                        best_cosine = cos_score
                        best_l2 = l2_score

            # Step 4: Calibrated dual-threshold decision
            confidence = None
            if best_cosine >= COSINE_HIGH and best_l2 <= 1.10:
                confidence = "high"
            elif best_cosine >= COSINE_MEDIUM and best_l2 <= L2_MAX:
                confidence = "medium"

            if confidence:
                matched_images.append({
                    "name": os.path.basename(img_path),
                    "path": img_path,
                    "confidence": confidence,
                    "score": round(best_cosine, 4)
                })

            # Progress logging every 50 images
            if (idx + 1) % 50 == 0:
                elapsed = time.time() - start_time
                sys.stderr.write(
                    f"[SFace Engine] Processed {idx + 1}/{len(image_paths)} images "
                    f"({elapsed:.1f}s, {len(matched_images)} matches so far)\n"
                )

        except Exception as e:
            sys.stderr.write(f"[SFace Engine] Error processing {img_path}: {str(e)}\n")

    elapsed = time.time() - start_time
    sys.stderr.write(
        f"[SFace Engine] ✓ Completed in {elapsed:.2f}s — "
        f"{len(matched_images)} matches from {len(image_paths)} images\n"
    )

    # Sort by score descending (best matches first)
    matched_images.sort(key=lambda m: m.get("score", 0), reverse=True)

    return matched_images


# ═══════════════════════════════════════════════════════════════════════════════
#  Main Entry Point
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: python scan_faces.py <selfie_path> <bulk_dir>"}))
        sys.exit(1)

    selfie_path = sys.argv[1]
    bulk_dir = sys.argv[2]

    if not os.path.exists(selfie_path):
        print(json.dumps({"error": f"Selfie not found: {selfie_path}"}))
        sys.exit(1)

    if not os.path.exists(bulk_dir):
        print(json.dumps({"error": f"Bulk directory not found: {bulk_dir}"}))
        sys.exit(1)

    # Collect all valid image files
    valid_extensions = ["*.jpg", "*.jpeg", "*.png", "*.webp", "*.JPG", "*.JPEG", "*.PNG", "*.WEBP"]
    image_paths = []
    for ext in valid_extensions:
        image_paths.extend(glob.glob(os.path.join(bulk_dir, ext)))

    image_paths = list(set(image_paths))
    image_paths = [p for p in image_paths if "temp_selfie_" not in os.path.basename(p)]
    image_paths = sorted(image_paths)

    if not image_paths:
        print(json.dumps({"matches": [], "message": "No images found in bulk directory."}))
        sys.exit(0)

    # Run SFace + OpenCV matching
    matches = match_faces(selfie_path, image_paths)

    # Remove internal score from output
    output_matches = [{"name": m["name"], "path": m["path"], "confidence": m["confidence"]} for m in matches]
    print(json.dumps({"matches": output_matches}))


if __name__ == "__main__":
    main()
