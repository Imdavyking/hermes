# syntax=docker/dockerfile:1

ARG NODE_VERSION=22.8.0

FROM node:${NODE_VERSION}-alpine

WORKDIR /app

# Copy lock file too — this is critical
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/

RUN yarn build

CMD ["node", "dist/index.js"]