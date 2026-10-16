FROM node:24-alpine

# No dependencies, no build step — this copies the two source files and runs one of them.
WORKDIR /app
COPY server.js /app/server.js
COPY public/ /app/public/

ENV PORT=8080 MEDIA_DIR=/media DATA_DIR=/data
EXPOSE 8080
VOLUME ["/media", "/data"]

CMD ["node", "/app/server.js"]
