# GWC PhotoPic backend: FastAPI + YuNet face detection + AuraFace recognition
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# AuraFace (261 MB, Apache-2.0) is too large for git: bake it into the image, checksum-verified.
RUN mkdir -p models && python -c "import urllib.request; urllib.request.urlretrieve('https://huggingface.co/fal/AuraFace-v1/resolve/main/glintr100.onnx', 'models/auraface_glintr100.onnx')" \
    && echo "a7933ea5330113b01c9b60351d8f4c33003f145d8470ac5f0e52ee2effe25c60  models/auraface_glintr100.onnx" | sha256sum -c -

COPY models/face_detection_yunet_2023mar.onnx models/
COPY app ./app

# Events, face index and analytics. Mount a persistent disk here in production.
ENV DATA_DIR=/app/data
ENV PORT=3000
EXPOSE 3000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
