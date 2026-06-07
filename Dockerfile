FROM node:22-slim

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 8797

CMD ["npm", "run", "start:prod"]
