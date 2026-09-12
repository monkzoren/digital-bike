# No dependencies at all: SQLite comes from node:sqlite, and the SpacetimeDB
# HTTP API is plain fetch. Nothing to npm install, nothing to build.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY *.mjs ./
# The SQLite file lives here; docker-compose mounts a named volume over it so
# it outlives every container, image and database wipe.
VOLUME /data
ENV PROFILES_DB=/data/profiles.db
CMD ["node", "index.mjs"]
