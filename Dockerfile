# Usa la última imagen oficial de Playwright
FROM mcr.microsoft.com/playwright:v1.56.0-jammy

# Establece el directorio de trabajo
WORKDIR /app

# Copia los archivos del proyecto
COPY package*.json ./
RUN npm install --force

COPY . .

# Expone el puerto
EXPOSE 8080

# Comando de inicio
CMD ["node", "index.js"]
