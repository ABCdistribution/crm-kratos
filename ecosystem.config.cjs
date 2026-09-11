/**
 * Configuration pm2 — production (srvfr-kratos).
 * Lancement :  pnpm exec pm2 start ecosystem.config.cjs
 * Chaque app lit son .env (symlink vers le .env racine) depuis son cwd.
 */
module.exports = {
  apps: [
    {
      name: 'crm-api',
      cwd: './apps/api',
      script: 'dist/main.js',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '512M',
      out_file: '../../logs/api.out.log',
      error_file: '../../logs/api.err.log',
      time: true,
    },
    {
      name: 'crm-kratos',
      cwd: './apps/kratos',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '512M',
      out_file: '../../logs/kratos.out.log',
      error_file: '../../logs/kratos.err.log',
      time: true,
    },
  ],
};
