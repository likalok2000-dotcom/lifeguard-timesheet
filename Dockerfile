FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY index.html ./
COPY 404.html ./
COPY manifest.webmanifest ./
COPY css ./css
COPY js ./js
RUN mkdir -p /app/data/userdata
ENV PORT=8765
ENV DATA_DIR=/app/data
EXPOSE 8765
CMD ["node", "server.js"]
