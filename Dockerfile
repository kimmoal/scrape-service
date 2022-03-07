FROM node:alpine

ENV CHROME_BIN=/usr/bin/chromium-browser \
    CHROME_PATH=/usr/lib/chromium/ \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD="true"

RUN apk add --no-cache chromium

ADD "package.json" .
ADD "yarn.lock" .

RUN yarn install --frozen-lockfile --production \
    && yarn cache clean

RUN deluser --remove-home node \
    && adduser -D appuser \
    && mkdir -p /home/appuser/tool \
    && chown -R appuser:appuser /home/appuser

USER appuser
WORKDIR /home/appuser/tool

ADD "scrape-service.js" .
ENTRYPOINT ["node", "scrape-service.js"]
