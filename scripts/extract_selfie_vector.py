import sys
import os
import json
import cv2
import numpy as np

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python extract_selfie_vector.py <selfie_path>"}))
        sys.exit(1)

    selfie_path = sys.argv[1]
    if not os.path.exists(selfie_path):
        print(json.dumps({"error": f"File not found: {selfie_path}"}))
        sys.exit(1)

    model_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "models"))
    detector_path = os.path.join(model_dir, "face_detection_yunet_2023mar.onnx")
    recognizer_path = os.path.join(model_dir, "face_recognition_sface_2021dec.onnx")

    img = cv2.imread(selfie_path)
    if img is None:
        print(json.dumps({"error": f"Could not decode image at {selfie_path}"}))
        sys.exit(1)

    h, w = img.shape[:2]
    # Resize if too large for speed
    max_side = 1280
    scale = 1.0
    if max(h, w) > max_side:
        scale = max_side / float(max(h, w))
        img = cv2.resize(img, (int(w * scale), int(h * scale)))
        h, w = img.shape[:2]

    detector = cv2.FaceDetectorYN.create(detector_path, "", (w, h), score_threshold=0.6)
    detector.setInputSize((w, h))
    _, faces = detector.detect(img)

    recognizer = cv2.FaceRecognizerSF.create(recognizer_path, "")

    feat = None

    if faces is not None and len(faces) > 0:
        # Pick largest face
        faces_sorted = sorted(faces, key=lambda f: f[2] * f[3], reverse=True)
        best_face = faces_sorted[0]
        aligned = recognizer.alignCrop(img, best_face)
        feat = recognizer.feature(aligned).flatten()
    else:
        # Fallback: center crop
        min_dim = min(h, w)
        cy, cx = h // 2, w // 2
        crop = img[cy - min_dim//2 : cy + min_dim//2, cx - min_dim//2 : cx + min_dim//2]
        if crop.size > 0:
            face_112 = cv2.resize(crop, (112, 112))
            feat = recognizer.feature(face_112).flatten()

    if feat is None:
        print(json.dumps({"error": "No face feature extracted"}))
        sys.exit(1)

    # Normalize vector
    norm = float(np.linalg.norm(feat))
    if norm > 0:
        feat = feat / norm

    print(json.dumps({
        "success": True,
        "vector": [round(float(v), 6) for v in feat]
    }))

if __name__ == "__main__":
    main()
