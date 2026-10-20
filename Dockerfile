# The same app without the desktop window: the API and the UI in a browser at http://localhost:8000

FROM node:24-slim AS ui
WORKDIR /src/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui/ ./
RUN npm run build

FROM python:3.14-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --create-home trader && mkdir /data && chown trader /data
COPY papertrader/ papertrader/
COPY --from=ui /src/papertrader/static papertrader/static
USER trader
ENV PAPERTRADER_DATA=/data
VOLUME /data
EXPOSE 8000
CMD ["python", "-m", "papertrader", "serve", "--host", "0.0.0.0", "--port", "8000"]
