FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY queries ./queries
USER node
EXPOSE 4000
CMD ["node", "--experimental-strip-types", "src/index.ts"]
