ARG NODE_VERSION=22.8.0

FROM node:${NODE_VERSION}-alpine


WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
