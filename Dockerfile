FROM node:22-alpine


WORKDIR /app


COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

RUN chown -R node:node /app
USER node

EXPOSE 3000


ENV NODE_ENV=production

CMD ["node", "server.js"]

