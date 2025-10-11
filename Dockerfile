# Usa la versión más reciente de Playwright (compatible con 1.56.0)
FROM mcr.microsoft.com/playwright:v1.56.0-jammy

# Carpeta de trabajo
WORKDIR /app

# Copia los archivos del proyecto
COPY . .

# Instala dependencias sin errores de compatibilidad
RUN npm install --force

# Expone el puerto que Railway necesita
EXPOSE 8080

# Inicia el bot
CMD ["npm", "start"]
