FROM node AS build
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY apps/web/package.json apps/web/
FROM node AS runtime
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/db/package.json packages/db/
COPY --from=build /app/apps/web/package.json apps/web/
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/apps/web/build apps/web/build
