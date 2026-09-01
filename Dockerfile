# Production Multi-Stage Dockerfile with Node.js + Python + OpenCV
FROM node:20-bullseye-slim

# Install Python3, pip, and required system libraries for OpenCV
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-dev \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Make `python` point to python3 (required by faceScanService spawn("python",...))
RUN ln -sf /usr/bin/python3 /usr/bin/python

WORKDIR /app

# Install Python requirements
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# Install Node dependencies
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy application source code, scripts, and AI models
COPY . .

# Expose port
ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000

# Start server
CMD ["npx", "tsx", "server.ts"]
