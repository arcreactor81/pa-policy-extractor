# PA policy extraction service — CPU-only Docling + Surya OCR + DeepSeek client.
# Built and pushed to Cloudflare's managed registry by the GitHub Actions runner
# (which runs `wrangler deploy`). Cloudflare has no server-side Dockerfile build,
# so the Actions build is the SOURCE OF TRUTH for what ships.
FROM python:3.12-slim

# Cache roots are placed UNDER /app so the model weights baked by the build-time
# warmup land in the image layer and are owned/readable by the runtime user.
# HF_HOME            -> Surya OCR + layout + table HF model weights
# XDG_CACHE_HOME     -> Docling's own model artifacts + misc caches
# TORCH_HOME         -> any torch hub assets
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/app/.cache/huggingface \
    XDG_CACHE_HOME=/app/.cache \
    TORCH_HOME=/app/.cache/torch \
    HF_HUB_DISABLE_TELEMETRY=1 \
    OMP_NUM_THREADS=4 \
    PORT=8080

WORKDIR /app

# Unprivileged runtime user, created BEFORE the model bake so the multi-GB cache
# layers below are written with the right ownership from the start — a late
# `chown -R /app` would duplicate every cached weight into a second image layer.
# Cloudflare Containers don't require root.
RUN useradd --create-home --uid 10001 appuser

# Runtime libraries Surya / Docling need: image codecs, OpenMP (torch), OpenGL (cv2).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# CPU build of torch first — Cloudflare Containers have no GPU. Installing it from
# the CPU wheel index keeps the image small and avoids pulling CUDA.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

# constraints.txt narrows the floating deps with verified pins (see notes there);
# requirements stay loose so the transformers pin still resolves.
COPY requirements.txt constraints.txt ./
RUN pip install --no-cache-dir -r requirements.txt -c constraints.txt

# App code copied owned by the runtime user directly (no recursive chown needed).
COPY --chown=appuser:appuser . .

# Hand /app + the cache roots to appuser BEFORE the bake. Targeted, non-recursive
# chown of a handful of (still nearly empty) directories — the weights downloaded
# next are then created appuser-owned inside a single layer.
RUN install -d -o appuser -g appuser /app/.cache /app/.cache/huggingface /app/.cache/torch \
    && chown appuser:appuser /app

# Best-effort model bake: download the OCR / layout / table models into the HF
# cache (under /app/.cache, see ENV above) so cold starts skip the multi-minute
# download. Non-fatal — `|| true` means a failed bake just defers the download to
# the container's first real request. docling-tools fetches the catalog; the
# warmup then runs a FULL convert over a synthetic text+table page so the Surya
# recognition and table-structure models (which only load when there is text /
# a table to process) are exercised and cached too. Run AS appuser so every
# cached file is readable/writable (incl. Surya/HF lock files) at runtime.
USER appuser
RUN docling-tools models download || true
RUN python warmup_build.py || true

# Liveness probe hitting /health. Uses stdlib urllib (no curl/wget in the slim
# base). /health returns 200 as soon as Flask is up (warmup runs in a background
# thread and is reported via the "warm" flag), so this is a true liveness check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD ["python", "-c", "import os,urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('PORT','8080'), timeout=4).status==200 else 1)"]

EXPOSE 8080
CMD ["python", "app.py"]
