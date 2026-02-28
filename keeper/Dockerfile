# syntax=docker/dockerfile:1

ARG NODE_VERSION=22.8.0
ARG NODE_ENV=development

FROM node:${NODE_VERSION}-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

CMD ["node", "dist/index.js"]
