FROM cube-sandbox-cn.tencentcloudcr.com/cube-sandbox/sandbox-code@sha256:743d264fad8c9dc9a49f07e931166d24d025363360ae770ca4b70e3f19540944

USER root

RUN sed -i \
      -e 's|URIs: http://deb.debian.org/debian$|URIs: https://snapshot.debian.org/archive/debian/20260202T000000Z|' \
      -e 's|URIs: http://deb.debian.org/debian-security$|URIs: https://snapshot.debian.org/archive/debian-security/20260202T000000Z|' \
      /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Check-Valid-Until=false -o Acquire::Retries=5 update \
    && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      fonts-dejavu-core \
      fonts-liberation \
      libreoffice-calc=4:7.4.7-1+deb12u10 \
      libreoffice-impress=4:7.4.7-1+deb12u10 \
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

COPY runtime-ts/managed-skills/csv-to-pdf/scripts/csv_to_pdf.py /tmp/csv-to-pdf-smoke/csv_to_pdf.py

# 模板发布前真实打开 Calc 并验证 PDF，避免只有 soffice 二进制存在但转换后端缺失。
RUN mkdir -p /workspace/output /resources/resource_smoke/version_smoke \
    && python3 -c "import base64; from pathlib import Path; name=base64.b64decode('JCh0b3VjaCBwd25lZClgdG91Y2ggcHduZWQyYC5jc3Y=').decode(); (Path('/resources/resource_smoke/version_smoke') / name).write_text('名称,内容\n公式前缀,=1+1\n', encoding='utf-8')" \
    && cd /tmp/csv-to-pdf-smoke \
    && python3 /tmp/csv-to-pdf-smoke/csv_to_pdf.py \
      --resource-id resource_smoke \
      --version-id version_smoke \
    && test ! -e pwned \
    && test ! -e pwned2 \
    && test -s /workspace/output/csv-to-pdf-1c16388190c5ac9c33552bef.pdf \
    && pdftotext /workspace/output/csv-to-pdf-1c16388190c5ac9c33552bef.pdf - | grep -F '=1+1' \
    && rm -rf /tmp/csv-to-pdf-smoke /resources/resource_smoke \
      /workspace/output/csv-to-pdf-1c16388190c5ac9c33552bef.pdf
