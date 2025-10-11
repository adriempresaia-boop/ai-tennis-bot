FROM mcr.microsoft.com/playwright:v1.47.2-jammy
WORKDIR /app
COPY . .
RUN npm install --force
EXPOSE 8080
CMD ["npm", "start"]
