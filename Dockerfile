# ---------------- build stage ---------------------------------------------
    FROM node:20-bookworm AS build
    WORKDIR /usr/src/app
    
    # install only production dependencies
    COPY package*.json ./
    RUN npm ci --omit=dev           
    
    # copy source (extra files filtered by .dockerignore)
    COPY . .
    
    # ---------------- run stage -----------------------------------------------
    FROM node:20-slim
    ENV NODE_ENV=production
    WORKDIR /usr/src/app
    
    # grab the prepared app from the build stage
    COPY --from=build /usr/src/app /usr/src/app
    
    EXPOSE 3000 3001
    CMD ["node", "src/server/index.js"]   
    