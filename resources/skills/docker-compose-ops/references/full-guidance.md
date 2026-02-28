# Docker Compose Operations

You are a Docker Compose specialist. Use the `run_command` tool to execute docker compose commands and file tools to create/edit compose files.

## Core Commands (Compose v2)

```bash
docker compose up -d                     # Start all services in background
docker compose up -d --build             # Rebuild images then start
docker compose down                      # Stop and remove containers
docker compose down -v                   # Also remove volumes
docker compose ps                        # List running services
docker compose logs -f --tail=100        # Stream logs from all services
docker compose logs web -f               # Logs for specific service
docker compose exec web /bin/sh          # Shell into running container
docker compose build                     # Build all images
docker compose build --no-cache web      # Force rebuild without cache
docker compose pull                      # Pull latest images
docker compose restart web               # Restart a service
docker compose stop                      # Stop without removing
docker compose config                    # Validate and view resolved config
```

## Compose File Patterns

### Full-Stack Web Application
```yaml
version: "3.8"

services:
  web:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=development
      - DATABASE_URL=postgres://user:pass@db:5432/app
      - REDIS_URL=redis://redis:6379
    volumes:
      - .:/app
      - /app/node_modules
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started
    restart: unless-stopped

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: user
      POSTGRES_PASSWORD: pass
      POSTGRES_DB: app
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U user -d app"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

  worker:
    build: .
    command: node worker.js
    environment:
      - DATABASE_URL=postgres://user:pass@db:5432/app
      - REDIS_URL=redis://redis:6379
    depends_on:
      - db
      - redis
    restart: unless-stopped

volumes:
  postgres_data:
  redis_data:
```

### Multi-Stage Dockerfile
```dockerfile
# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

## Environment Variables

### .env File
```bash
# .env (loaded automatically by docker compose)
POSTGRES_USER=user
POSTGRES_PASSWORD=secretpassword
NODE_ENV=development
```

### Variable Interpolation
```yaml
services:
  web:
    image: myapp:${APP_VERSION:-latest}     # Default value
    environment:
      - DB_HOST=${DB_HOST:?DB_HOST required} # Fail if not set
```

## Override Pattern (Dev vs Prod)

### docker-compose.yml (base)
```yaml
services:
  web:
    image: myapp:latest
    restart: always
```

### docker-compose.override.yml (dev - loaded automatically)
```yaml
services:
  web:
    build: .
    volumes:
      - .:/app
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=development
```

### docker-compose.prod.yml (production)
```yaml
services:
  web:
    deploy:
      replicas: 3
      resources:
        limits:
          cpus: '0.5'
          memory: 512M
    environment:
      - NODE_ENV=production
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

```bash
# Use production override
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

## Networking

```yaml
services:
  web:
    networks:
      - frontend
      - backend
  db:
    networks:
      - backend

networks:
  frontend:
  backend:
    internal: true   # No external access
```

## Health Checks

```yaml
services:
  web:
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
```

## Debugging
```bash
docker compose config                    # Resolve and validate full config
docker compose events                    # Watch container events
docker compose top                       # Running processes in containers
docker system df                         # Disk usage by images/containers/volumes
docker compose exec db psql -U user app  # Interactive DB shell
```

## Best Practices
- Always use named volumes for persistent data (not bind mounts in production)
- Set `restart: unless-stopped` for production services
- Use health checks with `depends_on: condition: service_healthy`
- Pin image tags (e.g., `postgres:16-alpine`, not `postgres:latest`)
- Use multi-stage builds to minimize image size
- Separate dev overrides from base config
- Use `.dockerignore` to exclude node_modules, .git, .env
- Set resource limits in production
- Use `docker compose config` to validate before deploying
