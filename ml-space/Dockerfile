FROM python:3.11-slim

# build-essential is needed for a couple of Python packages that compile
# native extensions during pip install
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Hugging Face Spaces requires the container to run as UID 1000, not root
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    HF_HOME=/home/user/app/.cache

WORKDIR $HOME/app

COPY --chown=user requirements.txt .

RUN pip install --no-cache-dir --upgrade pip
# Install the CPU-only PyTorch build explicitly. The default PyPI index
# resolves a CUDA-enabled build that's several GB larger, far slower to
# download/build, and useless on this CPU-only free Space.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=user . .

EXPOSE 7860

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860"]
