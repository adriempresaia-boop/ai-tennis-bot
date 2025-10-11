# Usa la imagen oficial de Playwright con todo lo necesario (Chromium, Node, etc.)
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

# Crea el directorio de trabajo dentro del contenedor
WORKDIR /app

# Copia todos los archivos de tu repositorio al contenedor
COPY . .

# Instala dependencias de Node.js (usa --force para evitar errores ETARGET o peer deps)
RUN npm install --force

# Expone el puerto que Railway necesita
EXPOSE 8080

# Comando para iniciar el bot
CMD ["npm", "start"]
