FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package manifest first (layer caching)
COPY package.json ./

# Install all dependencies inside the container - zero manual steps
RUN npm install --omit=dev

# Copy entire project
COPY . .

# Expose API port
EXPOSE 3000

# Start the application
CMD ["node", "src/index.js"]
