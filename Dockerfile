FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.mjs ai.mjs drive.mjs ./
COPY public ./public
RUN mkdir -p /tmp/smart-capturer
ENV PORT=8080 DATA_DIR=/tmp/smart-capturer
EXPOSE 8080
CMD ["node", "server.mjs"]
