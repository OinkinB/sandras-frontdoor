# Cloud Run image. Build from the costar-hackathon-kit folder so the kit data is in the context:
#   docker build -f homematch/Dockerfile -t frontdoor .
FROM node:22-slim AS bundle
WORKDIR /b
COPY homematch/sdk-test/package*.json ./
RUN npm ci --omit=dev

FROM python:3.12-slim
WORKDIR /app
COPY homematch/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY homematch/ /app/
COPY data/ /kit/data/
COPY residential-listings.csv /kit/
COPY --from=bundle /b/node_modules/@matterport/webcomponent/built-bundle /bundle
ENV KIT_DIR=/kit BUNDLE_DIR=/bundle CACHE_DIR=/tmp/frontdoor PORT=8080
# One small instance is plenty; scale to zero when idle so there is no standing cost.
CMD exec gunicorn -b :$PORT -w 1 --threads 8 --timeout 300 run:app
