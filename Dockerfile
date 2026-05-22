FROM node:22-alpine

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++

WORKDIR /app

ENV NODE_ENV=production \
    TYO_MQ_PORT=17352 \
    TYO_MQ_SETTINGS_FILE=/data/tyo-mq.settings.json \
    TYO_MQ_ENV_FILE=/data/.env

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Remove build dependencies
RUN apk del python3 make g++

# Copy project files
COPY . .

RUN mkdir -p /data

# Default port for tyo-mq
EXPOSE 17352

# Start the server
CMD ["npm", "start"]
