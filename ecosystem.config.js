module.exports = {
  apps: [{
    name: 'musicstore',
    script: 'server.js',
    cwd: '/var/www/musicstore',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      SESSION_SECRET: process.env.SESSION_SECRET,
      DB_PATH: '/var/lib/musicstore/db.sqlite',
      PDF_DIR: '/var/lib/musicstore/pdfs',
      CACHE_DIR: '/var/lib/musicstore/cache',
      SMTP_HOST: process.env.SMTP_HOST,
      SMTP_PORT: process.env.SMTP_PORT,
      SMTP_USER: process.env.SMTP_USER,
      SMTP_PASS: process.env.SMTP_PASS,
      SMTP_FROM: process.env.SMTP_FROM,
      PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID,
      PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET,
      PAYPAL_MODE: 'live',
      PAYPAL_WEBHOOK_ID: process.env.PAYPAL_WEBHOOK_ID
    },
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '500M',
    restart_delay: 5000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: '/var/log/musicstore/error.log',
    out_file: '/var/log/musicstore/out.log',
    merge_logs: true,
    kill_timeout: 10000,
    listen_timeout: 8000,
    env_production: {
      NODE_ENV: 'production'
    }
  }]
};