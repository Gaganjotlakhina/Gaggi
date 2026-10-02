FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
# hero teaser video ships base64-encoded in chunks (binary-safe through the git push path); decode at build
RUN if ls public/video/teaser-neon.mp4.b64* >/dev/null 2>&1; then cat public/video/teaser-neon.mp4.b64* | base64 -d > public/video/teaser-neon.mp4 && rm public/video/teaser-neon.mp4.b64*; fi
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
