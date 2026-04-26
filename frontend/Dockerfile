FROM node:18-alpine AS builder

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

# Build static assets — VITE_API_URL tells the frontend where to reach the backend
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build

# ─── Production stage ─────────────────────────────────────────────────────────
FROM node:18-alpine

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist         ./dist
COPY --from=builder /app/vite.config.js ./

EXPOSE 5173

# Use vite preview to serve the production build
CMD ["node_modules/.bin/vite", "preview", "--host", "0.0.0.0", "--port", "5173"]
