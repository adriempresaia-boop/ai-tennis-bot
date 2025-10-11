# Imagen base con Node y Playwright preinstalado
FROM mcr.microsoft.com/playwright:v1.48.2-jammy

# Crea carpeta de trabajo
WORKDIR /app

# Copia todo el código
COPY . .

# Instala dependencias
RUN npm install

# Expone el puerto 8080 (para Railway)
EXPOSE 8080

# Comando de inicio
CMD ["npm", "start"]
