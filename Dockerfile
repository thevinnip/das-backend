FROM node:latest

# Evitar prompts do apt
ENV DEBIAN_FRONTEND=noninteractive

# Instalar dependências do Chrome + Xvfb
RUN apt-get update && \
    apt-get install -y \
        wget \
        gnupg \
        xvfb \
        libx11-xcb1 \
        libxcomposite1 \
        libxcursor1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxi6 \
        libxrandr2 \
        libxrender1 \
        libxss1 \
        libxtst6 \
        fonts-liberation \
        libnss3 \
        libasound2 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libgtk-3-0 \
        libgbm1 \
        xdg-utils \
        ca-certificates \
        --no-install-recommends && \
    wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && \
    apt-get install -y ./google-chrome-stable_current_amd64.deb && \
    rm google-chrome-stable_current_amd64.deb && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Definir usuário opcional (ex: nextjs 1001) para evitar problemas de permissão
# RUN groupadd -g 1001 nextjs && useradd -m -u 1001 -g 1001 nextjs
# USER nextjs

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .
# Comando padrão para rodar Xvfb
CMD ["xvfb-run", "--auto-servernum", "--server-args='-screen 0 1280x720x24'", "google-chrome-stable", "--no-sandbox"]