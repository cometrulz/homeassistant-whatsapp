ARG BUILD_FROM
FROM $BUILD_FROM

RUN apk add --no-cache nodejs npm git

WORKDIR /opt/baileys_bridge
COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install
COPY index.js ./
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]

