FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    TYO_MQ_PORT=17352 \
    TYO_MQ_SETTINGS_FILE=/data/tyo-mq.settings.json \
    TYO_MQ_ENV_FILE=/data/.env

# Copy package files
COPY package*.json ./

# Install production dependencies. Build tools are only needed while native
# modules compile, so keep them in the same layer where they are removed.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm install --omit=dev \
    && npm cache clean --force \
    && apk del .build-deps

# Copy project files
COPY . .

RUN mkdir -p /data

# Default port for tyo-mq
EXPOSE 17352

# Start the server
CMD ["npm", "start"]
