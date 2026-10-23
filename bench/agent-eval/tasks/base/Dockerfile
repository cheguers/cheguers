FROM ghcr.io/laude-institute/t-bench/python-3-13@sha256:236734f0cafcce942ca09316d57236c2273a2b5411e116454a22cf6d718d95f5

RUN pip install --no-cache-dir pytest==9.1.1 fastembed==0.9.0

COPY model-cache /opt/fastembed-cache
