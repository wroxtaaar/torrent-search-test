FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY fast-search-test.mjs fast-search-test.html ./

ENV NODE_ENV=production
ENV PORT=10000

EXPOSE 10000

CMD ["node", "fast-search-test.mjs"]
