FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --package-lock=false && npm cache clean --force

COPY server.js ./
COPY migrations ./migrations

USER node
EXPOSE 3001
CMD ["npm", "start"]
