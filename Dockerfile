# Usa la imagen oficial de Playwright con todas las dependencias de Chromium
FROM mcr.microsoft.com/playwright:v1.46.0-jammy

# Carpeta de trabajo
WORKDIR /app

# Instalar dependencias de npm
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i

# Copiar el código
COPY . .

# Variables útiles
ENV NODE_ENV=production

# Arrancar el bot
CMD ["node", "index.js"]
