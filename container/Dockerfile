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

# CPU builds of torch AND torchvision first, as a MATCHED PAIR from the CPU wheel
# index — Cloudflare Containers have no GPU, and the pair must come from the SAME
# index: torchvision's compiled ops are built against one exact torch, and a PyPI
# (CUDA) torchvision next to a +cpu torch imports torch fine but never registers
# its operators ("operator torchvision::nms does not exist" → docling's converter
# import dies → every OCR fails). Installing torch alone here was exactly that
# bug: the requirements step then dragged torchvision in transitively from PyPI.
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu

# constraints.txt narrows the floating deps with verified pins (see notes there);
# requirements stay loose so the transformers pin still resolves. The CPU wheel
# index rides along as an EXTRA index so that if the resolver must move torch /
# torchvision to satisfy the docling stack, it can still pick +cpu builds (PEP 440
# local versions like 2.x.y+cpu outrank the same PyPI release, so the installed
# CPU pair wins whenever versions tie).
COPY requirements.txt constraints.txt ./
RUN pip install --no-cache-dir -r requirements.txt -c constraints.txt \
      --extra-index-url https://download.pytorch.org/whl/cpu

# App code copied owned by the runtime user directly (no recursive chown needed).
COPY --chown=appuser:appuser . .

# Hand /app + the cache roots to appuser BEFORE the bake. Targeted, non-recursive
# chown of a handful of (still nearly empty) directories — the weights downloaded
# next are then created appuser-owned inside a single layer.
RUN install -d -o appuser -g appuser /app/.cache /app/.cache/huggingface /app/.cache/torch \
    && chown appuser:appuser /app

# HARD import gate — deliberately NO `|| true`. Prove the heavy stack actually
# loads (the exact imports core._build_converter performs) before the best-effort
# model bake below. A torch/torchvision ABI mismatch or a broken docling resolve
# now FAILS THE BUILD on the Actions runner instead of shipping an image whose
# every OCR dies at runtime; the bake steps stay `|| true` because the only
# failure they are allowed is a flaky model download (which lazy-loads later).
USER appuser
RUN python -c "import torch, torchvision; \
from docling.document_converter import DocumentConverter; \
from docling_surya import SuryaOcrOptions; \
print('import gate OK: torch', torch.__version__, '| torchvision', torchvision.__version__)"

# Best-effort model bake: download the OCR / layout / table models into the HF
# cache (under /app/.cache, see ENV above) so cold starts skip the multi-minute
# download. Non-fatal — `|| true` means a failed bake just defers the download to
# the container's first real request. docling-tools fetches the catalog; the
# warmup then runs a FULL convert over a synthetic text+table page so the Surya
# recognition and table-structure models (which only load when there is text /
# a table to process) are exercised and cached too. Runs AS appuser (set above,
# before the import gate) so every cached file is readable/writable (incl.
# Surya/HF lock files) at runtime.
RUN docling-tools models download || true
RUN python warmup_build.py || true

# Liveness probe hitting /health. Uses stdlib urllib (no curl/wget in the slim
# base). /health returns 200 as soon as Flask is up (warmup runs in a background
# thread and is reported via the "warm" flag), so this is a true liveness check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD ["python", "-c", "import os,urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('PORT','8080'), timeout=4).status==200 else 1)"]

EXPOSE 8080
CMD ["python", "app.py"]
