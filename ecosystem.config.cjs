// PM2 Ecosystem Config — VetPower Lead Engine API
// This file tells PM2 how to start the API server with the correct environment variables.
// Usage: cd /var/www/vetpower && pm2 start ecosystem.config.cjs

module.exports = {
  apps: [{
    name: 'vetpower-api',
    script: 'server/api.js',
    cwd: '/var/www/vetpower',
    env: {
      NODE_ENV: 'production',
      API_PORT: 3001,
      API_SERVER_KEY: 'vp-api-d40-2026-secure',
      // VITE_ANTHROPIC_KEY is loaded from .env by dotenv-style reading below
    },
    // Load .env file automatically
    node_args: '--env-file=.env',
    watch: false,
    instances: 1,
    autorestart: true,
    max_memory_restart: '256M',
  }],
};
