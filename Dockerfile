# Usa la versión más reciente de Playwright
FROM mcr.microsoft.com/playwright:v1.56.0-jammy

# Define el directorio de trabajo
WORKDIR /app

# Copia los archivos del proyecto
COPY package*.json ./

# Instala las dependencias (usa --force por seguridad)
RUN npm install --force

# Copia todo el código al contenedor
COPY . .

# Expone el puerto usado por Railway
EXPOSE 8080

# Comando para ejecutar la app
CMD ["node", "index.js"]
