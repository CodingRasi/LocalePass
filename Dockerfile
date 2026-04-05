FROM mcr.microsoft.com/playwright:v1.53.0-noble

WORKDIR /app
COPY package.json tsconfig.json localepass.schema.json README.md action.yml ./
COPY packages ./packages

RUN npm install
RUN npm run build

WORKDIR /work
ENTRYPOINT ["node", "/app/dist/packages/cli/src/index.js"]
CMD ["--help"]
