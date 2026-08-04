FROM cube-sandbox-cn.tencentcloudcr.com/cube-sandbox/sandbox-code@sha256:743d264fad8c9dc9a49f07e931166d24d025363360ae770ca4b70e3f19540944

USER root

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      fonts-dejavu-core \
      fonts-liberation \
      libreoffice-impress \
      nodejs \
      npm \
      poppler-utils \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global --omit=dev --no-audit --no-fund \
      pptxgenjs@3.12.0 \
      react@18.3.1 \
      react-dom@18.3.1 \
      react-icons@5.4.0 \
      sharp@0.33.5 \
    && npm cache clean --force

ENV NODE_PATH=/usr/local/lib/node_modules

RUN ln -s /usr/local/lib/node_modules /node_modules \
    && node -e "for (const name of ['pptxgenjs','react','react-dom','react-icons','sharp']) require(name)" \
    && command -v soffice \
    && command -v pdftoppm
