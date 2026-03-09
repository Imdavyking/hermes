ARG NODE_VERSION=22.8.0

FROM node:${NODE_VERSION}-alpine

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .
RUN yarn codegen
RUN yarn build

EXPOSE 5100

CMD ["node", "dist/src/index.js"]